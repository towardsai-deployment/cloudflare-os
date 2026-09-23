import { beforeAll, describe, expect, it } from "vitest";
import {
  createAccessTokenSource, parseServiceAccountKey, withBearerToken, type ServiceAccountKey,
} from "../src/google-vertex-auth.js";

// Real Web Crypto, stubbed token endpoint: a fresh RSA key pair stands in for the service
// account's, so the JWT-bearer assertion can be verified against the matching public key.

const TOKEN_URI = "https://oauth2.googleapis.com/token";

let key: ServiceAccountKey;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256" },
      true, ["sign", "verify"]);
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  key = {
    clientEmail: "vertex@my-project.iam.gserviceaccount.com",
    privateKey: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
    projectId: "my-project",
    tokenUri: TOKEN_URI,
  };
});

type TokenRequest = { url: string; contentType: string | null; form: URLSearchParams };

// A token endpoint stub that records each request and answers with the given body.
function tokenEndpoint(status: number, body: unknown)
    : { fetch: typeof fetch; requests: TokenRequest[] } {
  const requests: TokenRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    requests.push({
      url: request.url,
      contentType: request.headers.get("content-type"),
      form: new URLSearchParams([...await request.formData()] as [string, string][]),
    });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

function base64urlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

describe("parseServiceAccountKey", () => {
  const KEY_FILE = {
    type: "service_account",
    project_id: "my-project",
    client_email: "vertex@my-project.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    token_uri: TOKEN_URI,
    private_key_id: "ignored",
  };

  it("extracts the fields token minting needs", () => {
    expect(parseServiceAccountKey(JSON.stringify(KEY_FILE))).toEqual({
      clientEmail: KEY_FILE.client_email,
      privateKey: KEY_FILE.private_key,
      projectId: "my-project",
      tokenUri: TOKEN_URI,
    });
  });

  it("rejects anything that is not a service-account key file", () => {
    expect(() => parseServiceAccountKey("AIzaSy-an-api-key")).toThrow(/service-account JSON key/);
    expect(() => parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, type: "authorized_user" })))
        .toThrow(/type "service_account"/);
    expect(() => parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, private_key: undefined })))
        .toThrow(/missing its "private_key"/);
  });
});

describe("createAccessTokenSource", () => {
  it("exchanges an RS256 JWT-bearer assertion for an access token", async () => {
    const endpoint = tokenEndpoint(200, { access_token: "ya29.token", expires_in: 3600 });
    const before = Math.floor(Date.now() / 1000);

    const token = await createAccessTokenSource(key, endpoint.fetch)();

    expect(token).toBe("ya29.token");
    expect(endpoint.requests).toHaveLength(1);
    const [request] = endpoint.requests;
    expect(request.url).toBe(TOKEN_URI);
    expect(request.contentType).toBe("application/x-www-form-urlencoded");
    expect(request.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [header, claims, signature] = request.form.get("assertion")!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(header))))
        .toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(claims)));
    expect(payload).toMatchObject({
      iss: key.clientEmail,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: TOKEN_URI,
    });
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.exp).toBe(payload.iat + 3600);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, base64urlDecode(signature),
        new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
  });

  it("reuses a token until it nears expiry, then mints again", async () => {
    const longLived = tokenEndpoint(200, { access_token: "long", expires_in: 3600 });
    const source = createAccessTokenSource(key, longLived.fetch);
    expect(await Promise.all([source(), source(), source()])).toEqual(["long", "long", "long"]);
    expect(longLived.requests).toHaveLength(1);

    // Already inside the refresh margin when issued, so every call re-mints.
    const shortLived = tokenEndpoint(200, { access_token: "short", expires_in: 30 });
    const impatient = createAccessTokenSource(key, shortLived.fetch);
    await impatient();
    await impatient();
    expect(shortLived.requests).toHaveLength(2);
  });

  it("reports a refused grant and retries on the next call", async () => {
    const endpoint = tokenEndpoint(400,
        { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    const source = createAccessTokenSource(key, endpoint.fetch);

    await expect(source()).rejects.toThrow(/Vertex AI access token: Invalid JWT Signature\./);
    await expect(source()).rejects.toThrow(/invalid_grant|Invalid JWT Signature/);
    expect(endpoint.requests).toHaveLength(2);
  });
});

describe("withBearerToken", () => {
  it("adds the Authorization header to the request's httpOptions, keeping the rest", () => {
    const payload = {
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: { temperature: 0.2, httpOptions: { headers: { "x-custom": "1" }, timeout: 5000 } },
    };
    expect(withBearerToken(payload, "tok")).toEqual({
      ...payload,
      config: {
        temperature: 0.2,
        httpOptions: { headers: { "x-custom": "1", Authorization: "Bearer tok" }, timeout: 5000 },
      },
    });
    expect(payload.config.httpOptions.headers).toEqual({ "x-custom": "1" });
  });

  it("creates the config when the payload has none", () => {
    expect(withBearerToken({ model: "m", contents: [] }, "tok")).toEqual({
      model: "m", contents: [],
      config: { httpOptions: { headers: { Authorization: "Bearer tok" } } },
    });
  });
});
