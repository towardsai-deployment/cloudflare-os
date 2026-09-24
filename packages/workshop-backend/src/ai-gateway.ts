import { AiChatAuthorInfo, AiModelConfig, OpenModelConfig, SUGGESTED_MODELS }
  from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability.js";
import { UserAiModelRecord } from "./user.js";

const logger = createWorkshopLogger("workshop.ai-gateway");

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Providers whose pi API adapter refuses a custom fetch, so their inference cannot ride the
 * Workers AI binding and needs CF_AI_GATEWAY_API_TOKEN over HTTPS. pi's Google adapter throws
 * "Custom fetch is not supported by the Google Generative AI adapter" whenever the fetch it is
 * given is not globalThis.fetch, and the client it builds on offers no hook to route around that:
 * @google/genai's `GoogleGenAI` takes only `httpOptions`, whose knobs are
 * baseUrl/apiVersion/headers/timeout/extraBody/retryOptions.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-generative-ai.ts#L80
 *
 * pi's Vertex adapter throws the same way, so a google-vertex provider would belong here too; it
 * is absent only because this deployment has no such provider.
 * https://github.com/earendil-works/pi/blob/v0.84.2/packages/ai/src/api/google-vertex.ts#L98
 */
const HTTPS_ONLY_PROVIDERS = new Set(["google"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

// A relative route under the gateway root: non-empty segments, no dot segments, and none of the
// characters that would let the path escape it once joined (scheme, query, fragment, backslash,
// percent-encoding such as %2e%2e, whitespace).
function isGatewayPath(value: unknown): value is string {
  return typeof value === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
      !/[?#\\%\s]/.test(value) &&
      value.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

// Returns the validated entry, or a reason it was rejected. Copies only the known fields.
function validateOpenModel(value: unknown): OpenModelConfig | string {
  if (typeof value !== "object" || value === null) return "not an object";
  const entry = value as Record<string, unknown>;
  if (!isNonEmptyString(entry.id)) return "id must be a non-empty string";
  if (!isNonEmptyString(entry.name)) return "name must be a non-empty string";
  if (!isGatewayPath(entry.gatewayPath)) {
    return "gatewayPath must be a relative path with no scheme, no leading or trailing " +
        "slash, and no '..'";
  }
  if (!isNonEmptyString(entry.model)) return "model must be a non-empty string";
  if (!isPositiveInteger(entry.contextWindow)) return "contextWindow must be a positive integer";
  if (!isPositiveInteger(entry.outputLimit)) return "outputLimit must be a positive integer";
  const result: OpenModelConfig = {
    id: entry.id, name: entry.name, gatewayPath: entry.gatewayPath, model: entry.model,
    contextWindow: entry.contextWindow, outputLimit: entry.outputLimit,
  };
  if (entry.cost !== undefined) {
    const cost = entry.cost as Record<string, unknown> | null;
    if (typeof cost !== "object" || cost === null || !isPrice(cost.input) ||
        !isPrice(cost.output) || (cost.cacheRead !== undefined && !isPrice(cost.cacheRead))) {
      return "cost must have non-negative input and output prices (and cacheRead, if set)";
    }
    result.cost = {
      input: cost.input, output: cost.output,
      ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead as number } : {}),
    };
  }
  return result;
}

/**
 * Parse CF_AI_GATEWAY_OPEN_MODELS (a JSON array of OpenModelConfig) into a map keyed by id.
 * Deployment config must never take down the model list, so malformed JSON and invalid or
 * duplicate entries are logged and skipped rather than thrown.
 */
function parseOpenModels(raw: string | undefined): Map<string, OpenModelConfig> {
  const result = new Map<string, OpenModelConfig>();
  if (!raw?.trim()) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("ignoring malformed CF_AI_GATEWAY_OPEN_MODELS", {
      event: "ai-gateway.open-models.invalid", error,
    });
    return result;
  }
  if (!Array.isArray(parsed)) {
    logger.warn("ignoring malformed CF_AI_GATEWAY_OPEN_MODELS", {
      event: "ai-gateway.open-models.invalid", error: "not a JSON array",
    });
    return result;
  }
  for (const [index, value] of parsed.entries()) {
    const entry = validateOpenModel(value);
    if (typeof entry !== "string" && !result.has(entry.id)) {
      result.set(entry.id, entry);
      continue;
    }
    logger.warn("skipping invalid CF_AI_GATEWAY_OPEN_MODELS entry", {
      event: "ai-gateway.open-models.invalid",
      error: `entry ${index}: ${typeof entry === "string" ? entry : "duplicate id"}`,
    });
  }
  return result;
}

export class AiGatewayConfig {
  readonly gateway: string;
  /**
   * The gateway name for Workers-AI-binding calls (webFetch's toMarkdown): binding calls only
   * reach gateways in the Worker's own account, so this is the platform gateway whenever the
   * binding transport is active, and unset when it isn't (see {@link binding}).
   */
  readonly sameAccountGateway?: string;
  readonly accountId: string;
  readonly apiToken?: string;
  /**
   * Workers AI binding, used as the gateway transport whenever present unless
   * CF_AI_GATEWAY_USE_BINDING=false opts out: binding requests are pre-authenticated in-account,
   * so inference and cost-log reads need no API token. Binding requests only reach gateways in
   * the Worker's own account, and the Worker can't verify that itself (it can't discover its own
   * account ID), so deployments whose gateway lives in a DIFFERENT account must set the opt-out
   * and use CF_AI_GATEWAY_API_TOKEN over HTTPS. Absent in local dev unless run-dev-server is
   * started with --use-workers-ai-binding.
   *
   * Such a deployment opts out with the flag rather than by unbinding WORKERS_AI, because the
   * binding is not only the gateway transport: webFetch's document-to-Markdown conversion calls
   * `env.ai.toMarkdown()` through it (see web-fetch.ts), so unbinding would break that too.
   */
  readonly binding?: Ai;
  readonly providers: Set<string>;
  /**
   * The deployment's open models (provider "gateway-openai"), keyed by their user-visible id.
   * Empty unless "gateway-openai" is an enabled provider.
   */
  readonly openModels: ReadonlyMap<string, OpenModelConfig>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID) {
      throw new Error("CF_AI_GATEWAY_ACCOUNT_ID is required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN || undefined;
    // Normalized once, so a stray " False " opts out rather than reading as unset and silently
    // picking the other transport.
    const useBinding = env.CF_AI_GATEWAY_USE_BINDING?.trim().toLowerCase();
    this.binding = useBinding === "false"
        ? undefined
        : (env as { WORKERS_AI?: Ai }).WORKERS_AI;
    if (useBinding === "true" && !this.binding) {
      throw new Error(
          "CF_AI_GATEWAY_USE_BINDING requires the WORKERS_AI binding; without it the config " +
          "would silently fall back to the HTTPS transport.");
    }
    if (!this.apiToken && !this.binding) {
      throw new Error(
          "AI Gateway mode needs a transport: bind Workers AI (WORKERS_AI; in local dev start " +
          "with --use-workers-ai-binding) or set CF_AI_GATEWAY_API_TOKEN (a Run + Read token).");
    }
    this.sameAccountGateway = this.binding ? this.gateway : undefined;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    const httpsOnly = [...this.providers].filter(p => HTTPS_ONLY_PROVIDERS.has(p));
    if (httpsOnly.length > 0 && !this.apiToken) {
      const names = httpsOnly.join(", ");
      throw new Error(
          `${names} inference cannot ride the Workers AI binding transport, so enabling the ` +
          `${names} provider${httpsOnly.length > 1 ? "s" : ""} requires ` +
          "CF_AI_GATEWAY_API_TOKEN.");
    }
    this.openModels = this.providers.has("gateway-openai")
        ? parseOpenModels(env.CF_AI_GATEWAY_OPEN_MODELS)
        : new Map();
  }

  /**
   * Transport for a provider's gateway inference: the Workers AI binding when present, except for
   * the providers in {@link HTTPS_ONLY_PROVIDERS}, which ride HTTPS with the token (the
   * constructor guarantees a token whenever one of them is an enabled provider).
   */
  bindingFor(provider: string): Ai | undefined {
    return HTTPS_ONLY_PROVIDERS.has(provider) ? undefined : this.binding;
  }

  /**
   * Get the list of models available through AI Gateway, as AiChatAuthorInfo entries: the
   * SUGGESTED_MODELS of enabled providers, then the deployment's open models.
   */
  getModelList(): AiChatAuthorInfo[] {
    let result: AiChatAuthorInfo[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name });
        }
      }
    }
    for (let model of this.openModels.values()) {
      result.push({ type: "agent", id: model.id, name: model.name });
    }
    return result;
  }

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the model is a
   * SUGGESTED_MODEL for an enabled gateway provider or one of the deployment's open models, or
   * undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    let openModel = this.openModels.get(modelId);
    if (openModel) {
      return {
        profile: { type: "agent", id: openModel.id, name: openModel.name },
        // getModel() looks the entry up again by id, so the config carries no route or key.
        config: { provider: "gateway-openai", model: openModel.id, apiToken: "" },
      };
    }
    return undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
