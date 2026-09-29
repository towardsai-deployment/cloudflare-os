import { describe, expect, it } from "vitest";
import {
  CONVERSATION_RESOURCE, THREAD_RESOURCE, WORKSPACE_RESOURCE,
  grantedResourcesFromScopes, resourceUrlPatternsToScopes,
} from "../src/slack-scopes";

const READ_SCOPES = [
  "channels:read", "channels:history", "groups:read", "groups:history",
  "im:read", "im:history", "mpim:read", "mpim:history",
];
const HISTORY_SCOPES = ["channels:history", "groups:history", "im:history", "mpim:history"];

describe("resourceUrlPatternsToScopes", () => {
  it("asks a whole-workspace grant for chat:write, im:write and mpim:write", () => {
    expect(new Set(resourceUrlPatternsToScopes([WORKSPACE_RESOURCE.urlPattern]))).toEqual(new Set([
      "users:read", "team:read", ...READ_SCOPES, "search:read",
      "chat:write", "im:write", "mpim:write",
    ]));
  });

  it("asks a conversation grant for chat:write but not for opening DMs", () => {
    expect(new Set(resourceUrlPatternsToScopes([CONVERSATION_RESOURCE.urlPattern]))).toEqual(
        new Set(["users:read", ...READ_SCOPES, "search:read", "chat:write"]));
  });

  it("asks a thread grant only for history and chat:write", () => {
    expect(new Set(resourceUrlPatternsToScopes([THREAD_RESOURCE.urlPattern]))).toEqual(
        new Set(["users:read", ...HISTORY_SCOPES, "chat:write"]));
  });

  it("rejects an unknown resource pattern", () => {
    expect(() => resourceUrlPatternsToScopes(["https://example.com/*"]))
        .toThrow("Unknown grantable resource URL pattern");
  });
});

describe("grantedResourcesFromScopes", () => {
  it("does not grant a conversation whose token lacks chat:write", () => {
    expect(grantedResourcesFromScopes(["users:read", ...READ_SCOPES, "search:read"]))
        .not.toContain(CONVERSATION_RESOURCE.urlPattern);
  });

  it("grants conversations and threads, but not the workspace, without the DM scopes", () => {
    let granted = grantedResourcesFromScopes([
      "users:read", "team:read", ...READ_SCOPES, "search:read", "chat:write",
    ]);
    expect(granted).toEqual([CONVERSATION_RESOURCE.urlPattern, THREAD_RESOURCE.urlPattern]);
  });

  it("grants every resource when every scope was granted", () => {
    expect(grantedResourcesFromScopes(resourceUrlPatternsToScopes())).toEqual([
      WORKSPACE_RESOURCE.urlPattern, CONVERSATION_RESOURCE.urlPattern, THREAD_RESOURCE.urlPattern,
    ]);
  });
});
