// Approval-gated Slack writes. A session method builds a SlackPostAction, submitSlackAction stores it
// and submits it to the approval queue, and applySlackAction performs it only after approval. Kept
// free of Workers runtime imports so it can be tested directly.

import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { SlackConversationInfo, SlackUser } from "./types";
import type { SlackApi } from "./slack-api";

/** Slack's hard limit on message text. */
const MAX_TEXT_LENGTH = 40_000;
/** conversations.open accepts 1 to 8 users. */
const MAX_DM_RECIPIENTS = 8;
const USER_ID_PATTERN = /^[UW][A-Z0-9]+$/;

/** Where a post goes, for the approver: a short name for the title and a full label with IDs. */
export type SlackDestination = {
  name: string;
  label: string;
};

/** A write waiting for approval. Destinations are fixed here; applying uses only these values. */
export type SlackPostAction =
  | {
    kind: "postMessage";
    conversationId: string;
    destination: SlackDestination;
    text: string;
    /** The thread root's ts, for a thread reply. */
    threadTs?: string;
    /** A short excerpt of the thread root, shown to the approver. */
    threadExcerpt?: string;
  }
  | {
    kind: "sendDirectMessage";
    userIds: string[];
    recipients: SlackDestination[];
    text: string;
  };

/** A stored action, with where it was posted once applied. */
export type StoredSlackAction = SlackPostAction & {
  id: number;
  posted?: { channelId: string; ts: string };
};

/** The slice of Durable Object KV storage the store uses. */
export interface ActionKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean | void;
}

/** The slice of the approval queue used to submit actions. */
export interface ActionSubmitter {
  submitAction(action: number, description: ActionDescription): Promise<unknown>;
}

/** Stores pending and applied Slack actions in a Gatekeeper's own storage. */
export class SlackActionStore {
  #kv: ActionKv;

  constructor(kv: ActionKv) {
    this.#kv = kv;
  }

  /** Stores a new action and returns its sequential ID. */
  add(action: SlackPostAction): number {
    let id = (this.#kv.get<number>("counter:action") ?? 0) + 1;
    this.#kv.put("counter:action", id);
    this.put({ ...action, id });
    return id;
  }

  /** The stored action with this ID, if any. */
  get(id: number): StoredSlackAction | undefined {
    return this.#kv.get<StoredSlackAction>(`action:${id}`);
  }

  /** Replaces a stored action. */
  put(action: StoredSlackAction): void {
    this.#kv.put(`action:${action.id}`, action);
  }

  /** Forgets an action. */
  remove(id: number): void {
    this.#kv.delete(`action:${id}`);
  }
}

/** The approver-facing label for a Slack user, or the bare ID when the user couldn't be resolved. */
export function userLabel(userId: string, user?: SlackUser): SlackDestination {
  if (!user) return { name: userId, label: userId };
  let name = user.realName || user.displayName || user.username || userId;
  return { name, label: `${name} (@${user.username}, ${userId})` };
}

/** The approver-facing label for a conversation, or the bare ID when it couldn't be resolved. */
export function conversationDestination(
    conversationId: string, info?: SlackConversationInfo): SlackDestination {
  if (info?.kind === "im" && info.peer) {
    let peer = userLabel(info.peer.id, info.peer);
    return {
      name: `a direct message with ${peer.name}`,
      label: `direct message with ${peer.label} (${conversationId})`,
    };
  }
  if (info?.kind === "mpim") {
    let name = info.name ? `the group DM ${info.name}` : "a group DM";
    return { name, label: `${name} (${conversationId})` };
  }
  if (info?.name) return { name: `#${info.name}`, label: `#${info.name} (${conversationId})` };
  return { name: conversationId, label: conversationId };
}

function validateText(text: string): void {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Slack message text must not be empty.");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error("Slack message text must be at most 40,000 characters.");
  }
}

function validateRecipients(userIds: string[]): void {
  if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > MAX_DM_RECIPIENTS) {
    throw new Error("A direct message needs 1 to 8 recipients.");
  }
  for (let id of userIds) {
    if (typeof id !== "string" || !USER_ID_PATTERN.test(id)) {
      throw new Error(`${String(id)} is not a Slack user ID (like "U012AB3CD").`);
    }
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new Error("Direct message recipients must be distinct.");
  }
}

/** Checks a post's input, throwing before anything is stored or queued. */
export function validateSlackAction(action: SlackPostAction): void {
  validateText(action.text);
  if (action.kind === "sendDirectMessage") validateRecipients(action.userIds);
}

// A fence longer than any backtick run in the text, so the text can't close it early.
function fenced(text: string): string {
  let longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  let fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

const POSTS_AS =
    "**Posts as:** the connected Slack user whose connection this workspace uses, not the approver.";

/** The approval-queue description for a post. */
export function describeSlackAction(action: SlackPostAction): ActionDescription {
  let title: string;
  let lines: string[];
  if (action.kind === "sendDirectMessage") {
    let names = action.recipients.map(recipient => recipient.name).join(", ");
    let group = action.recipients.length > 1;
    title = group ? `Send a group DM to ${names}` : `Send a direct message to ${names}`;
    lines = [
      `**To:** ${action.recipients.map(recipient => recipient.label).join(", ")}`,
      `Opens the ${group ? "group DM" : "direct message"} with ${group ? "these people" : "this person"}` +
          " (or finds the existing one), then posts to it.",
    ];
  } else if (action.threadTs) {
    title = `Reply in a thread in ${action.destination.name}`;
    lines = [
      `**Destination:** ${action.destination.label}`,
      `**Thread:** a reply to the message sent at \`${action.threadTs}\`` +
          (action.threadExcerpt ? `, which begins:\n\n${fenced(action.threadExcerpt)}` : "."),
    ];
  } else {
    title = `Post to ${action.destination.name}`;
    lines = [`**Destination:** ${action.destination.label}`];
  }
  return {
    title,
    description: [...lines, POSTS_AS, "**Message** (sent exactly as shown):", fenced(action.text)]
        .join("\n\n"),
    // Undoing a post would need chat.delete, which this Gatekeeper doesn't use.
    implementsRevert: false,
    // Pending posts aren't simulated in later reads, so the agent waits for the decision.
    awaitDecision: true,
  };
}

/** Validates, stores and submits a post for approval. Nothing is sent to Slack here. */
export async function submitSlackAction(
    store: SlackActionStore, queue: ActionSubmitter, action: SlackPostAction): Promise<void> {
  validateSlackAction(action);
  let id = store.add(action);
  try {
    await queue.submitAction(id, describeSlackAction(action));
  } catch (error) {
    store.remove(id);
    throw error;
  }
}

/** Performs an approved post, once: an action already posted is not posted again. */
export async function applySlackAction(
    store: SlackActionStore, api: Pick<SlackApi, "openConversation" | "postMessage">,
    id: number): Promise<void> {
  let action = store.get(id);
  if (!action) throw new Error(`Unknown action: ${id}`);
  if (action.posted) return;
  let channelId = action.kind === "sendDirectMessage"
      ? await api.openConversation(action.userIds)
      : action.conversationId;
  let threadTs = action.kind === "postMessage" ? action.threadTs : undefined;
  action.posted = await api.postMessage(channelId, action.text, threadTs);
  store.put(action);
}

/** Drops a rejected post. Nothing was simulated, so no restart is needed. */
export function rejectSlackAction(store: SlackActionStore, id: number): void {
  store.remove(id);
}
