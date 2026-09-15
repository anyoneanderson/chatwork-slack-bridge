import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleChatClient } from "@/adapters/google-chat/client";
import { GoogleChatError } from "@/adapters/google-chat/types";
import type { GoogleChatConfig } from "@/config/google-chat";

const CONFIG: GoogleChatConfig = {
  accountEmail: "dummy@example.test",
  spaceName: "spaces/DUMMYSPACE",
  spaceDisplayName: "Dummy",
  slackChannelId: "C0DUMMY",
  startTime: "2026-01-01T00:00:00Z",
  pollIntervalMs: 60000,
  pollMode: "timer",
  allowedReplyUserIds: [],
  credentials: {
    clientId: "dummy-client",
    clientSecret: "dummy-secret",
    refreshToken: "dummy-refresh",
  },
};
const WINDOW = { after: "2026-01-01T00:00:00Z", before: "2026-01-02T00:00:00Z" };
const RAW = {
  name: "spaces/DUMMYSPACE/messages/DUMMY",
  thread: { name: "spaces/DUMMYSPACE/threads/DUMMY" },
  createTime: "2026-01-01T01:00:00Z",
  text: "dummy text",
  sender: { name: "users/DUMMY", displayName: "Dummy sender" },
};
const REPLY = {
  threadName: RAW.thread.name,
  text: RAW.text,
  messageId: "client-dummy-1",
  requestId: "11111111-1111-4111-8111-111111111111",
};
const TOKEN = { access_token: "dummy-access", expires_in: 3600, token_type: "Bearer" };
const IDENTITY = { email: CONFIG.accountEmail, email_verified: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function mockRequests(
  api: (url: URL, init?: RequestInit) => Promise<Response> = async () => json({ messages: [RAW] }),
  token: () => Promise<Response> = async () => json(TOKEN),
  identity: () => Promise<Response> = async () => json(IDENTITY),
) {
  const mock = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "oauth2.googleapis.com") return token();
    if (parsed.hostname === "openidconnect.googleapis.com") return identity();
    return api(parsed, init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
function apiCalls(mock: ReturnType<typeof mockRequests>) {
  return mock.mock.calls.filter(([url]) => String(url).startsWith("https://chat.googleapis.com/"));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Google Chat sender display names", () => {
  it.each<{
    label: string;
    names: Record<string, string>;
    sender: { name: string; displayName?: string };
    expected: string;
  }>([
    {
      label: "configured name overrides API display name",
      names: { "users/DUMMY": "Configured sender" },
      sender: RAW.sender,
      expected: "Configured sender",
    },
    {
      label: "configured name resolves an ID-only sender",
      names: { "users/DUMMY": "Configured sender" },
      sender: { name: "users/DUMMY" },
      expected: "Configured sender",
    },
    {
      label: "unconfigured sender keeps API display name",
      names: { "users/OTHER": "Other sender" },
      sender: RAW.sender,
      expected: RAW.sender.displayName,
    },
    {
      label: "unconfigured ID-only sender keeps resource ID",
      names: { "users/OTHER": "Other sender" },
      sender: { name: "users/DUMMY" },
      expected: "users/DUMMY",
    },
    {
      label: "empty API display name falls back to resource ID",
      names: {},
      sender: { name: "users/DUMMY", displayName: "" },
      expected: "users/DUMMY",
    },
  ])("$label without changing the sender identity", async ({ names, sender, expected }) => {
    const mock = mockRequests(async () => json({ messages: [{ ...RAW, sender }] }));
    const client = createGoogleChatClient({
      ...CONFIG,
      credentials: { ...CONFIG.credentials, senderNames: names },
    });
    const page = await client.listMessages(WINDOW);
    expect(page.messages[0]).toMatchObject({ senderId: "users/DUMMY", senderName: expected });
    // 名前解決の追加 API 通信を発生させず、既存の token・identity・list だけを呼ぶ。
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("preserves ID-only senders when credentials have no sender name mapping", async () => {
    mockRequests(async () => json({ messages: [{ ...RAW, sender: { name: "users/DUMMY" } }] }));
    const page = await createGoogleChatClient(CONFIG).listMessages(WINDOW);
    expect(page.messages[0]).toMatchObject({ senderId: "users/DUMMY", senderName: "users/DUMMY" });
  });
});

describe("Google Chat authentication", () => {
  it("refreshes once and verifies identity before concurrent API reads", async () => {
    const mock = mockRequests();
    const client = createGoogleChatClient(CONFIG);
    await Promise.all([client.listMessages(WINDOW), client.listMessages(WINDOW)]);
    expect(
      mock.mock.calls.filter(([url]) => String(url).includes("oauth2.googleapis.com")),
    ).toHaveLength(1);
    expect(mock.mock.calls.filter(([url]) => String(url).includes("userinfo"))).toHaveLength(1);
    expect(apiCalls(mock)).toHaveLength(2);
    expect(mock.mock.calls[0]?.[1]?.body).toBeInstanceOf(URLSearchParams);
    const body = mock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("dummy-refresh");
    for (const [, init] of apiCalls(mock))
      expect(init?.headers).toMatchObject({ Authorization: "Bearer dummy-access" });
  });

  it("rechecks identity after an expiring access token is refreshed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const mock = mockRequests();
    const client = createGoogleChatClient(CONFIG);
    await client.listMessages(WINDOW);
    now.mockReturnValue(3590000);
    await client.listMessages(WINDOW);
    expect(mock.mock.calls.filter(([url]) => String(url).includes("userinfo"))).toHaveLength(2);
  });

  it.each([
    [{ email: "another@example.test", email_verified: true }, "account_mismatch"],
    [{ email: CONFIG.accountEmail, email_verified: false }, "invalid_response"],
    [{ email: CONFIG.accountEmail }, "invalid_response"],
  ])("never reads messages for invalid identity %j", async (identity, code) => {
    const mock = mockRequests(undefined, undefined, async () => json(identity));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code,
    });
    expect(apiCalls(mock)).toHaveLength(0);
  });

  it("sanitizes invalid_grant without retaining OAuth error descriptions", async () => {
    const mock = mockRequests(undefined, async () =>
      json({ error: "invalid_grant", error_description: "dummy-refresh private-body-bait" }, 400),
    );
    const error = await createGoogleChatClient(CONFIG)
      .listMessages(WINDOW)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "auth_revoked", status: 400 });
    expect(String(error)).not.toContain("dummy-refresh");
    expect(JSON.stringify(error)).not.toContain("private-body-bait");
    expect((error as Error).cause).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    401, 403,
  ])("rejects token endpoint status %s without a message API call", async (status) => {
    const mock = mockRequests(undefined, async () => json({ secret: "dummy-refresh" }, status));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code: status === 401 ? "auth_revoked" : "forbidden",
      status,
    });
    expect(apiCalls(mock)).toHaveLength(0);
  });

  it.each([
    { ...TOKEN, access_token: "" },
    { ...TOKEN, token_type: "Basic" },
    { ...TOKEN, expires_in: -1 },
    { ...TOKEN, expires_in: "3600" },
  ])("rejects malformed token responses before reading identity or messages", async (payload) => {
    const mock = mockRequests(undefined, async () => json(payload));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected token and refreshes only on a later explicit read", async () => {
    let reads = 0;
    const mock = mockRequests(async () =>
      ++reads === 1 ? json({ secret: "dummy-access" }, 401) : json({}),
    );
    const client = createGoogleChatClient(CONFIG);
    await expect(client.listMessages(WINDOW)).rejects.toMatchObject({ code: "auth_revoked" });
    expect(apiCalls(mock)).toHaveLength(1);
    await expect(client.listMessages(WINDOW)).resolves.toEqual({ messages: [] });
    expect(
      mock.mock.calls.filter(([url]) => String(url).includes("oauth2.googleapis.com")),
    ).toHaveLength(2);
  });
});

describe("Google Chat message boundaries", () => {
  it("encodes a bounded ordered page query and returns its continuation", async () => {
    const mock = mockRequests(async () => json({ messages: [RAW], nextPageToken: "next-dummy" }));
    const page = await createGoogleChatClient(CONFIG).listMessages({
      ...WINDOW,
      pageToken: "dummy+token&value",
    });
    expect(page).toMatchObject({
      messages: [
        { name: RAW.name, threadName: RAW.thread.name, text: RAW.text, senderId: "users/DUMMY" },
      ],
      nextPageToken: "next-dummy",
    });
    const url = new URL(String(apiCalls(mock)[0]?.[0]));
    expect(url.pathname).toBe("/v1/spaces/DUMMYSPACE/messages");
    expect(url.searchParams.get("filter")).toBe(
      `createTime > "${WINDOW.after}" AND createTime < "${WINDOW.before}"`,
    );
    expect(url.searchParams.get("pageToken")).toBe("dummy+token&value");
    expect(url.searchParams.get("orderBy")).toBe("createTime ASC");
    expect(url.searchParams.get("pageSize")).toBe("100");
  });

  it.each([
    { messages: "invalid" },
    { messages: [{ ...RAW, createTime: "invalid" }] },
    { messages: [{ ...RAW, sender: null }] },
  ])("rejects malformed response %j", async (payload) => {
    mockRequests(async () => json(payload));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    { ...RAW, name: "spaces/OTHER/messages/DUMMY" },
    { ...RAW, name: "spaces/DUMMYSPACE/messages/.." },
    { ...RAW, space: { name: "spaces/OTHER" } },
    { ...RAW, thread: { name: "spaces/OTHER/threads/DUMMY" } },
    { ...RAW, name: "spaces/DUMMYSPACE/messages/DUMMY/extra" },
  ])("rejects resources outside the configured space %j", async (message) => {
    mockRequests(async () => json({ messages: [message] }));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });

  it("rejects an invalid time window before authentication", async () => {
    const mock = mockRequests();
    await expect(
      createGoogleChatClient(CONFIG).listMessages({ after: WINDOW.before, before: WINDOW.after }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("discards raw transport errors", async () => {
    mockRequests(async () => {
      throw new Error("private-body-bait dummy-access");
    });
    const error = await createGoogleChatClient(CONFIG)
      .listMessages(WINDOW)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoogleChatError);
    expect(String(error)).toBe("GoogleChatError: Google Chat request failed: unavailable");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects malformed JSON without exposing its raw body", async () => {
    mockRequests(async () => new Response("private-body-bait"));
    await expect(createGoogleChatClient(CONFIG).listMessages(WINDOW)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("Google Chat confirmed reply transport", () => {
  it("posts only into the existing thread with persisted custom and request IDs", async () => {
    const mock = mockRequests(async () =>
      json({ ...RAW, clientAssignedMessageId: REPLY.messageId }),
    );
    await createGoogleChatClient(CONFIG).createReply(REPLY);
    expect(apiCalls(mock)).toHaveLength(1);
    const [url, init] = apiCalls(mock)[0] ?? [];
    const query = new URL(String(url)).searchParams;
    expect(query.get("messageReplyOption")).toBe("REPLY_MESSAGE_OR_FAIL");
    expect(query.get("messageId")).toBe(REPLY.messageId);
    expect(query.get("requestId")).toBe(REPLY.requestId);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: REPLY.text,
      thread: { name: REPLY.threadName },
    });
  });

  it.each([401, 403, 429, 500, 503])("does not retry a reply after HTTP %s", async (status) => {
    const mock = mockRequests(async () =>
      json({ error: "private-body-bait dummy-access" }, status),
    );
    const error = await createGoogleChatClient(CONFIG)
      .createReply(REPLY)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoogleChatError);
    expect(String(error)).not.toContain("private-body-bait");
    expect(apiCalls(mock)).toHaveLength(1);
  });

  it("does not retry a reply after a transport failure", async () => {
    const mock = mockRequests(async () => {
      throw new Error("connection lost");
    });
    await expect(createGoogleChatClient(CONFIG).createReply(REPLY)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(apiCalls(mock)).toHaveLength(1);
  });

  it.each([
    { ...REPLY, threadName: "spaces/OTHER/threads/DUMMY" },
    { ...REPLY, threadName: "spaces/DUMMYSPACE/threads/.." },
    { ...REPLY, messageId: "not-custom" },
    { ...REPLY, requestId: "invalid" },
  ])("rejects invalid reply routing before network %j", async (input) => {
    const mock = mockRequests();
    await expect(createGoogleChatClient(CONFIG).createReply(input)).rejects.toBeInstanceOf(
      GoogleChatError,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    { ...RAW, text: "wrong" },
    { ...RAW, thread: { name: "spaces/DUMMYSPACE/threads/OTHER" } },
    { ...RAW, clientAssignedMessageId: "client-other" },
  ])("rejects inconsistent create results %j", async (payload) => {
    mockRequests(async () => json(payload));
    await expect(createGoogleChatClient(CONFIG).createReply(REPLY)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });

  it("returns undefined only for a missing message", async () => {
    mockRequests(async () => json({}, 404));
    await expect(
      createGoogleChatClient(CONFIG).getMessage("client-dummy-1"),
    ).resolves.toBeUndefined();
  });

  it("requires custom ID evidence when reconciling a previous send", async () => {
    mockRequests(async () => json(RAW));
    await expect(createGoogleChatClient(CONFIG).getMessage("client-dummy-1")).rejects.toMatchObject(
      { code: "resource_mismatch" },
    );
  });

  it("accepts a matching custom ID in a reconciliation response", async () => {
    mockRequests(async () => json({ ...RAW, clientAssignedMessageId: REPLY.messageId }));
    await expect(createGoogleChatClient(CONFIG).getMessage(REPLY.messageId)).resolves.toMatchObject(
      { name: RAW.name, clientAssignedMessageId: REPLY.messageId },
    );
  });
});
