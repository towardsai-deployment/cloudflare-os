import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackApi, SlackApiError } from "../src/slack-api";

type Sent = { url: string; method?: string; auth?: string; body: URLSearchParams };

// Stub fetch with canned Slack responses, recording each request.
function stubSlack(...responses: object[]): Sent[] {
  let sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let headers = new Headers(init?.headers);
    sent.push({
      url, method: init?.method, auth: headers.get("Authorization") ?? undefined,
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    return Response.json(responses[sent.length - 1]);
  }));
  return sent;
}

const api = () => new SlackApi(async () => "xoxp-test");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlackApi.postMessage", () => {
  it("posts form-encoded text as the token's user and returns where it landed", async () => {
    let sent = stubSlack({ ok: true, channel: "C123", ts: "1700000000.000100" });

    let posted = await api().postMessage("C123", "Hello & <welcome>");

    expect(posted).toEqual({ channelId: "C123", ts: "1700000000.000100" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].auth).toBe("Bearer xoxp-test");
    expect(Object.fromEntries(sent[0].body)).toEqual({ channel: "C123", text: "Hello & <welcome>" });
  });

  it("sets thread_ts for a thread reply", async () => {
    let sent = stubSlack({ ok: true, channel: "C123", ts: "1700000001.000200" });

    await api().postMessage("C123", "Reply", "1700000000.000100");

    expect(sent[0].body.get("thread_ts")).toBe("1700000000.000100");
  });

  it("turns a Slack error into a SlackApiError", async () => {
    stubSlack({ ok: false, error: "not_in_channel" });

    let error = await api().postMessage("C123", "Hi").catch(e => e);

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error.code).toBe("not_in_channel");
  });
});

describe("SlackApi.openConversation", () => {
  it("opens a DM or group DM for the given users and returns its ID", async () => {
    let sent = stubSlack({ ok: true, channel: { id: "G999" } });

    let id = await api().openConversation(["U1", "U2"]);

    expect(id).toBe("G999");
    expect(sent[0].url).toBe("https://slack.com/api/conversations.open");
    expect(sent[0].method).toBe("POST");
    expect(Object.fromEntries(sent[0].body)).toEqual({ users: "U1,U2" });
  });
});
