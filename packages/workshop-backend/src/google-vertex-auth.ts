// Service-account authentication for Google Vertex AI.
//
// Vertex accepts only OAuth2 bearer tokens (API keys are refused outright under common org
// policies), and Google's own auth library needs a filesystem and metadata server we don't have
// in Workers. So a Vertex model's `apiToken` is a service-account JSON key, and each request is
// authenticated with a short-lived access token minted here through the OAuth2 JWT-bearer grant
// (RFC 7523): sign a claim set with the key's RSA private key via Web Crypto, exchange it at
// Google's token endpoint, cache the result until shortly before it expires.

/** The fields of a Google service-account JSON key that minting an access token needs. */
export type ServiceAccountKey = {
  clientEmail: string;
  /** PKCS#8 PEM. */
  privateKey: string;
  projectId: string;
  tokenUri: string;
};

/** Access token lifetime we ask for (Google's maximum), and how early we refresh a cached one. */
const TOKEN_LIFETIME_SECONDS = 3600;
const REFRESH_MARGIN_MS = 60_000;

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Parse the JSON key file Google issues for a service account (Cloud console: IAM > Service
 * Accounts > Keys). Throws a user-facing error for anything else, so a bad paste fails at add
 * time rather than at the first chat message.
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The Vertex AI credential must be a service-account JSON key file.");
  }
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as
      Record<string, unknown>;
  const field = (name: string): string => {
    const value = record[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`The service-account key is missing its "${name}" field.`);
    }
    return value;
  };
  if (record.type !== "service_account") {
    throw new Error('The Vertex AI credential must be a key of type "service_account".');
  }
  return {
    clientEmail: field("client_email"),
    privateKey: field("private_key"),
    projectId: field("project_id"),
    tokenUri: field("token_uri"),
  };
}

/**
 * A source of bearer tokens for the service account: mints one on first use and reuses it until
 * it is about to expire. Concurrent callers share an in-flight mint. `fetchFn` is injectable for
 * tests.
 */
export function createAccessTokenSource(key: ServiceAccountKey, fetchFn: typeof fetch = fetch)
    : () => Promise<string> {
  let cached: Promise<{ token: string; expiresAt: number }> | undefined;
  return async () => {
    if (cached) {
      const { token, expiresAt } = await cached;
      if (Date.now() < expiresAt - REFRESH_MARGIN_MS) return token;
    }
    cached = mintAccessToken(key, fetchFn);
    try {
      return (await cached).token;
    } catch (err) {
      cached = undefined;
      throw err;
    }
  };
}

/**
 * Attach the bearer token to a @google/genai request payload as a per-request header. The SDK
 * merges `config.httpOptions.headers` into every request, after the client-level headers and
 * before its own auth step -- which sees an Authorization header only as one more header, so
 * this is the one place a token minted at request time can be applied.
 */
export function withBearerToken(payload: unknown, token: string): unknown {
  const params = payload as { config?: { httpOptions?: { headers?: Record<string, string> } } };
  const config = params.config ?? {};
  const httpOptions = config.httpOptions ?? {};
  return {
    ...params,
    config: {
      ...config,
      httpOptions: {
        ...httpOptions,
        headers: { ...httpOptions.headers, Authorization: `Bearer ${token}` },
      },
    },
  };
}

async function mintAccessToken(key: ServiceAccountKey, fetchFn: typeof fetch)
    : Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(key.privateKey, {
    iss: key.clientEmail,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: key.tokenUri,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  });
  const response = await fetchFn(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  // Google's error body is {error, error_description}; both describe the grant, not the key.
  const body = await response.json().catch(() => ({})) as
      { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!response.ok || typeof body.access_token !== "string") {
    const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new Error(`Google refused to issue a Vertex AI access token: ${detail}`);
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000,
  };
}

// RS256-sign a JWT with a PKCS#8 PEM private key.
async function signJwt(privateKeyPem: string, claims: Record<string, unknown>): Promise<string> {
  const signingKey = await crypto.subtle.importKey(
      "pkcs8", pemToDer(privateKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const encoder = new TextEncoder();
  const signingInput = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.` +
      base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", signingKey, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
