// Grantable Slack resources and the user-token scopes each one requests. Kept free of Workers
// runtime imports so it can be tested directly.

import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

// Needed for account display and user-name resolution.
const IDENTITY_SCOPES = ["users:read"];

/** `https://*` denotes account-wide access; the configurator resolves the concrete workspace URL. */
export const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Slack Workspace",
  description:
      "Read channels, direct messages, members, and search across the whole connected workspace, " +
      "and ask to post messages, thread replies, and new direct messages (each needs approval). " +
      "The workspace is auto-detected from the connected account — no URL or ID need be supplied.",
  grantable: true,
};

/** One channel, direct message, or group DM. */
export const CONVERSATION_RESOURCE: SupportedResource = {
  urlPattern: "https://app.slack.com/client/:teamId/:conversationId",
  title: "Slack Conversation",
  description:
      "Read a single channel, direct message, or group DM, and ask to post in it or reply to its " +
      "threads (each post needs approval).",
  grantable: true,
};

/** One message thread. */
export const THREAD_RESOURCE: SupportedResource = {
  urlPattern: "https://*.slack.com/archives/:conversationId/:messageId",
  title: "Slack Thread",
  description:
      "Read a single message thread and its replies, and ask to reply in it (each reply needs " +
      "approval).",
  grantable: true,
};

const CONVERSATION_READ_SCOPES = [
  "channels:read", "channels:history",
  "groups:read", "groups:history",
  "im:read", "im:history",
  "mpim:read", "mpim:history",
];

// chat:write posts as the connected user. im:write and mpim:write let conversations.open start a
// new DM or group DM, which only whole-workspace grants may do.
const RESOURCE_SCOPES: { resource: SupportedResource; scopes: string[] }[] = [
  {
    resource: WORKSPACE_RESOURCE,
    scopes: [
      "team:read", ...CONVERSATION_READ_SCOPES, "search:read",
      "chat:write", "im:write", "mpim:write",
    ],
  },
  {
    resource: CONVERSATION_RESOURCE,
    scopes: [...CONVERSATION_READ_SCOPES, "search:read", "chat:write"],
  },
  {
    resource: THREAD_RESOURCE,
    scopes: ["channels:history", "groups:history", "im:history", "mpim:history", "chat:write"],
  },
];

/** Every grantable Slack resource, most general first. */
export const SUPPORTED_RESOURCES: SupportedResource[] = RESOURCE_SCOPES.map(entry => entry.resource);

function validateResourceUrlPatterns(resourceUrlPatterns?: string[]): void {
  if (resourceUrlPatterns === undefined) return;
  let known = new Set(RESOURCE_SCOPES.map(entry => entry.resource.urlPattern));
  let unknown = resourceUrlPatterns.filter(pattern => !known.has(pattern));
  if (unknown.length > 0) {
    throw new Error(`Unknown grantable resource URL pattern(s): ${unknown.join(", ")}`);
  }
}

/** The user-token scopes to request for the given resources, or for all of them when omitted. */
export function resourceUrlPatternsToScopes(resourceUrlPatterns?: string[]): string[] {
  validateResourceUrlPatterns(resourceUrlPatterns);
  let scopes = new Set<string>(IDENTITY_SCOPES);
  for (let entry of RESOURCE_SCOPES) {
    if (resourceUrlPatterns === undefined ||
        resourceUrlPatterns.includes(entry.resource.urlPattern)) {
      for (let scope of entry.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

/** The resource URL patterns whose every required scope is among `grantedScopes`. */
export function grantedResourcesFromScopes(grantedScopes: string[]): string[] {
  let granted = new Set(grantedScopes);
  return RESOURCE_SCOPES
      .filter(entry => entry.scopes.every(scope => granted.has(scope)))
      .map(entry => entry.resource.urlPattern);
}
