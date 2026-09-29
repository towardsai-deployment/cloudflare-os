# Slack gatekeeper

Mediates a Gadget's access to a user's [Slack](https://slack.com) workspace: reading channels,
direct messages, threads, members, and search, and posting messages, thread replies, and new direct
messages once a person approves each one. Runs as its own Cloudflare Worker and is auto-discovered
by the backend from its `GATEKEEPER_SLACK` binding.

It never edits or deletes messages, and never adds reactions.

## Auth

OAuth 2.0 using a **user token** (`xoxp-…`), requested via `user_scope` (not a bot token) so the
agent sees exactly what the connecting user can see — including private channels, DMs, and search
— and approved posts appear as that user.

Create a Slack app (https://api.slack.com/apps) and provide its client credentials to the worker
as `CLIENT_ID` / `CLIENT_SECRET`. For local dev, `run-dev-server.ts` maps `SLACK_CLIENT_ID` /
`SLACK_CLIENT_SECRET` (e.g. from a root `.dev.vars`) into those vars.

App configuration:

- **Redirect URL** must match `<BASE_URL>/oauth`, which in local dev defaults to
  `http://localhost:8787/gatekeeper/slack/oauth`.
- Enable **token rotation** (OAuth & Permissions → *Token Rotation*). Tokens are then short-lived
  (~12h) and refreshed via `oauth.v2.access?grant_type=refresh_token`. Non-rotating tokens also
  work as a fallback (they're returned as-is).
- Request the **User Token Scopes** the granted resources need (see below). `users:read` is always
  requested for connected-account display and user-name resolution.

## Resources

Access is granted at one of three granularities. Each grantable resource maps to a URL pattern
that drives both consent (which OAuth scopes are requested) and routing:

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| Whole workspace | `https://*` (catch-all whole-instance) | `SlackWorkspaceSession` |
| A conversation (channel, DM, or group DM) | `https://app.slack.com/client/:teamId/:conversationId` | `SlackConversation` |
| A thread | `https://*.slack.com/archives/:conversationId/:messageId` | `SlackThread` |

Workspace grants use the framework's account-wide `https://*` pattern; more-specific conversation
and thread URLs take precedence. Channels and DMs share one "Conversation" grant.

### Scopes per resource (user token scopes)

- **Workspace**: `team:read`, conversation read scopes, `search:read`, `chat:write`, `im:write`,
  `mpim:write`
- **Conversation**: conversation read scopes, `search:read`, `chat:write`
- **Thread**: `channels:history`, `groups:history`, `im:history`, `mpim:history`, `chat:write`
- **Always**: `users:read`

where the conversation read scopes are `channels`/`groups`/`im`/`mpim` `:read` + `:history`.
`chat:write` posts; `im:write` and `mpim:write` let `conversations.open` start a DM or group DM,
which only whole-workspace grants can do. A resource counts as granted only when all its scopes
were, so a connection made before the write scopes existed is asked to reconnect. The scope tables
are in `src/slack-scopes.ts`.

## API

See `src/types.d.ts` for the full Session API (the agent-facing documentation). Highlights:

- `SlackWorkspaceSession`: `getInfo`, `listChannels`, `listDirectMessages`, `listUsers`,
  `getUser`, `getConversation`, `search`, `sendDirectMessage`
- `SlackConversation`: `getInfo`, `members`, `listMessages`, `getThread`, `search`, `postMessage`
  (conversation-scoped search is **hard-restricted** to the bound conversation regardless of query)
- `SlackThread`: `getRoot`, `listReplies`, `reply`

List and search methods return paginated `Cursor` objects. Known mentions are rendered with readable
names.

## Writes

`postMessage`, `reply`, and `sendDirectMessage` never call Slack directly. Each one checks its input
(non-empty text of at most 40,000 characters; 1–8 distinct user IDs for a DM), stores the action
in the gatekeeper's own storage, and submits it to the approval queue (`src/slack-actions.ts`).
`applyAction` makes the Slack calls only after approval — `chat.postMessage`, preceded by
`conversations.open` for a new DM — and never posts the same action twice.

- **Grant scope.** A conversation grant posts only to its conversation and replies only to threads
  in it; a thread grant replies only to its thread, at the resolved root; only a whole-workspace
  grant can send DMs. The destination is fixed when the action is queued.
- **Approval text.** The destination's name and ID (for example `#general (C0123ABCD)`, or each DM
  recipient as `Jane Doe (@jane, U0123ABCD)`), the thread's root timestamp for a reply, who posts,
  and the full text in a code fence the text can't close. It includes no other Slack content, since
  the action log is visible to collaborators who may not be able to read the conversation.
- **No simulation, auto-approval, or revert.** Pending posts don't appear in later reads, so each
  action sets `awaitDecision`. No action kind is auto-approvable. Undoing a post would need
  `chat.delete`, so `implementsRevert` is false.
- **Whose connection posts.** A post is made with the Slack account whose connection the binding
  was created from, not the approver's. The Workshop builds the gatekeeper class from the calling
  user's own connected account when a binding is created (`newGatekeeper` and `addGatekeeper` in
  `workshop-backend/src/overseer.ts`), and applies an approved action on that stored gatekeeper
  (`approveAction` → `applyPendingAction` → `applyAction`). "Build" collaborators can approve
  actions, so when the owner created the binding, a build collaborator's approval posts as the
  owner.

## Build

```
pnpm exec vp run -F @gadgets/slack-gatekeeper build
```

## Test

```
pnpm --filter @gadgets/slack-gatekeeper test:run
```
