import { describe, expect, it } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  SlackActionStore, applySlackAction, conversationDestination, rejectSlackAction,
  submitSlackAction, userLabel, type ActionKv, type SlackPostAction,
} from "../src/slack-actions";

function makeKv(): ActionKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key: string, value: unknown) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
  };
}

function makeQueue() {
  let submitted: { id: number; description: ActionDescription }[] = [];
  return {
    submitted,
    submitAction: async (id: number, description: ActionDescription) => {
      submitted.push({ id, description });
    },
  };
}

function makeApi() {
  let calls: string[] = [];
  return {
    calls,
    openConversation: async (userIds: string[]) => {
      calls.push(`open ${userIds.join(",")}`);
      return "G777";
    },
    postMessage: async (channelId: string, text: string, threadTs?: string) => {
      calls.push(`post ${channelId} ${threadTs ?? "-"} ${text}`);
      return { channelId, ts: "1700000009.000900" };
    },
  };
}

const general = conversationDestination("C0123ABCD", {
  id: "C0123ABCD", kind: "public_channel", name: "general", isArchived: false,
});

const post: SlackPostAction = {
  kind: "postMessage", conversationId: "C0123ABCD", destination: general,
  text: "Deploy is done.",
};

function dm(userIds: string[]): SlackPostAction {
  return {
    kind: "sendDirectMessage", userIds, text: "Hi", recipients: userIds.map(id => userLabel(id)),
  };
}

describe("submitSlackAction", () => {
  it("queues a post with its destination, author and full text for approval", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await submitSlackAction(store, queue, post);

    expect(queue.submitted).toHaveLength(1);
    let { id, description } = queue.submitted[0];
    expect(store.get(id)).toMatchObject(post);
    expect(description.title).toBe("Post to #general");
    expect(description.description).toContain("#general (C0123ABCD)");
    expect(description.description).toContain("connected Slack user");
    expect(description.description).toContain("```\nDeploy is done.\n```");
    expect(description.implementsRevert).toBe(false);
    expect(description.awaitDecision).toBe(true);
    expect(description.autoApprovable).toBeUndefined();
    expect(description.actionKind).toBeUndefined();
  });

  it("fences the text so backticks in it cannot end the block early", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await submitSlackAction(store, queue, { ...post, text: "run ```rm``` then ````x````" });

    expect(queue.submitted[0].description.description)
        .toContain("`````\nrun ```rm``` then ````x````\n`````");
  });

  it("describes a thread reply with the thread it answers", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await submitSlackAction(store, queue, { ...post, threadTs: "1700000000.000100" });

    let { title, description } = queue.submitted[0].description;
    expect(title).toBe("Reply in a thread in #general");
    expect(description).toContain("#general (C0123ABCD)");
    expect(description).toContain("1700000000.000100");
  });

  it("names every recipient of a new group DM with their IDs", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await submitSlackAction(store, queue, {
      kind: "sendDirectMessage", userIds: ["U01", "U02"], text: "Lunch?",
      recipients: [
        userLabel("U01", { id: "U01", username: "jane", realName: "Jane Doe", isBot: false }),
        userLabel("U02"),
      ],
    });

    let { title, description } = queue.submitted[0].description;
    expect(title).toBe("Send a group DM to Jane Doe, U02");
    expect(description).toContain("Jane Doe (@jane, U01)");
    expect(description).toContain("U02");
  });

  it("refuses empty or oversized text before queuing anything", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await expect(submitSlackAction(store, queue, { ...post, text: "  " }))
        .rejects.toThrow("must not be empty");
    await expect(submitSlackAction(store, queue, { ...post, text: "x".repeat(40_001) }))
        .rejects.toThrow("at most 40,000");
    expect(queue.submitted).toHaveLength(0);
  });

  it("refuses a DM to no one, to more than eight people, or to a malformed ID", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();

    await expect(submitSlackAction(store, queue, dm([]))).rejects.toThrow("1 to 8");
    await expect(submitSlackAction(store, queue, dm(
        ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "U9"]))).rejects.toThrow("1 to 8");
    await expect(submitSlackAction(store, queue, dm(["U1", "U1"]))).rejects.toThrow("distinct");
    await expect(submitSlackAction(store, queue, dm(["C0123ABCD"]))).rejects.toThrow("user ID");
    expect(queue.submitted).toHaveLength(0);
  });

  it("forgets the action when the queue refuses it", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = { submitAction: async () => { throw new Error("queue closed"); } };

    await expect(submitSlackAction(store, queue, post)).rejects.toThrow("queue closed");
    expect(store.get(1)).toBeUndefined();
  });
});

describe("applySlackAction", () => {
  it("posts to the stored conversation, in the stored thread", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();
    let api = makeApi();
    await submitSlackAction(store, queue, { ...post, threadTs: "1700000000.000100" });

    await applySlackAction(store, api, queue.submitted[0].id);

    expect(api.calls).toEqual(["post C0123ABCD 1700000000.000100 Deploy is done."]);
  });

  it("opens the DM only once approved, then posts to it", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();
    let api = makeApi();
    await submitSlackAction(store, queue, {
      kind: "sendDirectMessage", userIds: ["U01", "U02"], text: "Lunch?",
      recipients: [userLabel("U01"), userLabel("U02")],
    });
    expect(api.calls).toEqual([]);

    await applySlackAction(store, api, queue.submitted[0].id);

    expect(api.calls).toEqual(["open U01,U02", "post G777 - Lunch?"]);
  });

  it("does not post twice when an applied action is applied again", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();
    let api = makeApi();
    await submitSlackAction(store, queue, post);
    let id = queue.submitted[0].id;

    await applySlackAction(store, api, id);
    await applySlackAction(store, api, id);

    expect(api.calls).toHaveLength(1);
  });

  it("refuses an unknown action", async () => {
    await expect(applySlackAction(new SlackActionStore(makeKv()), makeApi(), 42))
        .rejects.toThrow("Unknown action");
  });
});

describe("rejectSlackAction", () => {
  it("drops the action so it can never be applied", async () => {
    let store = new SlackActionStore(makeKv());
    let queue = makeQueue();
    let api = makeApi();
    await submitSlackAction(store, queue, post);
    let id = queue.submitted[0].id;

    rejectSlackAction(store, id);

    await expect(applySlackAction(store, api, id)).rejects.toThrow("Unknown action");
    expect(api.calls).toEqual([]);
  });
});
