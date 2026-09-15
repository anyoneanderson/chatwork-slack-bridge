import { eq, isNull, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleChatError, type GoogleChatMessage } from "@/adapters/google-chat/types";
import { SlackApiError } from "@/adapters/slack/client";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import { createGoogleChatBridge } from "@/app/services/google-chat/bridge";
import type { GoogleChatConfig } from "@/config/google-chat";
import { createDbClient } from "@/db/client";
import {
  googleChatDeliveryAttempts as attempts,
  googleChatConnections as connections,
  googleChatInbox as inbox,
  googleChatOutbox as outbox,
  googleChatThreads as threads,
} from "@/db/google-chat-schema";
import type { Logger } from "@/logger";

const databaseUrl = process.env.GOOGLE_CHAT_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Google Chat の永続配送（実 PostgreSQL）", () => {
  const db = createDbClient(databaseUrl ?? "postgres://unused@127.0.0.1/unused");
  const start = new Date(Date.now() - 120000).toISOString();
  const config: GoogleChatConfig = {
    accountEmail: "bridge@example.test",
    spaceName: "spaces/FAKE",
    spaceDisplayName: "Test space",
    slackChannelId: "CFAKE",
    startTime: start,
    pollIntervalMs: 60000,
    allowedReplyUserIds: ["UALLOWED"],
    credentials: { clientId: "fake", clientSecret: "fake", refreshToken: "fake" },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  function message(id = "one", thread = "root"): GoogleChatMessage {
    return {
      name: `spaces/FAKE/messages/${thread}.${id}`,
      threadName: `spaces/FAKE/threads/${thread}`,
      text: `body ${id} <!channel>`,
      senderName: "Sender",
      senderId: "users/FAKE",
      createTime: new Date(Date.now() - 60000).toISOString(),
    };
  }
  function fixture(override: Partial<GoogleChatConfig> = {}) {
    const client = {
      listMessages: vi.fn().mockResolvedValue({ messages: [message()] }),
      createReply: vi.fn(),
      getMessage: vi.fn(),
    };
    let sequence = 0;
    const slackClient = {
      postMessage: vi
        .fn()
        .mockImplementation(async () => ({ ts: toSlackTs(`${++sequence}.000000`) })),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn(),
    };
    const bridge = createGoogleChatBridge({
      db,
      client,
      slackClient,
      logger,
      config: { ...config, ...override },
    });
    return { bridge, client, slackClient };
  }
  async function expireCooldown() {
    // DB の時計が待機期限を過ぎた状態だけを再現し、実行中の lease は変更しない。
    await db.db
      .update(connections)
      .set({ leaseUntil: sql`now()-interval '1 second'` })
      .where(isNull(connections.leaseToken));
  }
  const event = {
    type: "message" as const,
    channel: "CFAKE",
    ts: "20.0",
    thread_ts: "1.000000",
    user: "UALLOWED",
    text: "Confirmed reply",
  };
  beforeAll(async () => {
    await migrate(db.db, { migrationsFolder: "src/db/migrations" });
  });
  beforeEach(async () => {
    await db.db.delete(attempts);
    await db.db.delete(inbox);
    await db.db.delete(outbox);
    await db.db.delete(threads);
    await db.db.delete(connections);
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await db.close();
  });
  it("再取得・再起動でも同じ投稿を重ねず、同じ Google スレッドへまとめる", async () => {
    const f = fixture();
    f.client.listMessages.mockResolvedValue({ messages: [message(), message("two")] });
    await f.bridge.poll();
    await expireCooldown();
    await f.bridge.poll();
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
    expect(f.slackClient.postMessage.mock.calls[1]?.[2]).toEqual({ threadTs: "1.000000" });
    expect(f.slackClient.postMessage.mock.calls[0]?.[1].text).not.toContain("<!channel>");
    expect(f.slackClient.postMessage.mock.calls[0]?.[1].blocks[0].text.type).toBe("plain_text");
    const restarted = createGoogleChatBridge({
      db,
      client: f.client,
      slackClient: f.slackClient,
      logger,
      config,
    });
    await expireCooldown();
    await restarted.poll();
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
    expect((await db.db.select().from(inbox)).map((x) => x.status)).toEqual(["sent", "sent"]);
  });
  it("ページ上限で止めた後も同じ取得区間と token から再開する", async () => {
    const f = fixture();
    f.client.listMessages.mockImplementation(async (input: { pageToken?: string }) => {
      const n = Number(input.pageToken ?? 0);
      return { messages: [message(`p${n}`)], ...(n < 5 ? { nextPageToken: String(n + 1) } : {}) };
    });
    await f.bridge.poll();
    expect(f.slackClient.postMessage).not.toHaveBeenCalled();
    expect((await db.db.select().from(connections))[0]?.pageToken).toBe("5");
    await f.bridge.poll();
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(6);
    const calls = f.client.listMessages.mock.calls;
    expect(calls[5]?.[0]).toMatchObject({ ...calls[0]?.[0], pageToken: "5" });
  }, 15000);
  it("ページ取得失敗では checkpoint を進めず、再開後も重複しない", async () => {
    const f = fixture();
    f.client.listMessages
      .mockResolvedValueOnce({ messages: [message()], nextPageToken: "next" })
      .mockRejectedValueOnce(new GoogleChatError("unavailable", 503))
      .mockResolvedValue({ messages: [message("two")] });
    await f.bridge.poll();
    expect(f.slackClient.postMessage).not.toHaveBeenCalled();
    await f.bridge.poll();
    expect(f.client.listMessages.mock.calls[2]?.[0].pageToken).toBe("next");
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
  });
  it("同時実行する別プロセス相当の poll は lease を奪わない", async () => {
    const f = fixture();
    let release!: (value: { messages: GoogleChatMessage[] }) => void;
    f.client.listMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = f.bridge.poll();
    await vi.waitFor(() => expect(f.client.listMessages).toHaveBeenCalledOnce());
    const second = fixture();
    await second.bridge.poll();
    expect(second.client.listMessages).not.toHaveBeenCalled();
    release({ messages: [message()] });
    await running;
    expect(f.slackClient.postMessage).toHaveBeenCalledOnce();
  });
  it("Slack 投稿が成否不明なら再起動後も再投稿しない", async () => {
    const f = fixture();
    f.slackClient.postMessage.mockRejectedValue(new Error("PRIVATE_BODY_TOKEN"));
    await f.bridge.poll();
    await expireCooldown();
    await f.bridge.poll();
    expect(f.slackClient.postMessage).toHaveBeenCalledOnce();
    expect((await db.db.select().from(inbox))[0]?.status).toBe("unknown");
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("PRIVATE_BODY_TOKEN");
  });
  it("lease が切れても送信中の Slack 投稿を次の worker が重ねない", async () => {
    const f = fixture();
    let release!: (value: { ts: ReturnType<typeof toSlackTs> }) => void;
    f.slackClient.postMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = f.bridge.poll();
    await vi.waitFor(() => expect(f.slackClient.postMessage).toHaveBeenCalledOnce());
    await db.db.update(connections).set({ leaseUntil: sql`now()-interval '1 second'` });
    const second = fixture();
    await second.bridge.poll();
    expect(second.slackClient.postMessage).not.toHaveBeenCalled();
    release({ ts: toSlackTs("1.000000") });
    await running;
    expect((await db.db.select().from(inbox))[0]?.status).toBe("sent");
  });
  it("未認可ユーザー・bot では意図を作らず、イベント再送でも確認を重ねない", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply({ ...event, user: "UOTHER" });
    await f.bridge.handleReply({ ...event, bot_id: "BFAKE" });
    expect(await db.db.select().from(outbox)).toHaveLength(0);
    expect(await f.bridge.handleReply({ ...event, thread_ts: "unmanaged" })).toBe(false);
    await f.bridge.handleReply(event);
    await f.bridge.handleReply(event);
    expect(await db.db.select().from(outbox)).toHaveLength(1);
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
    expect(f.client.createReply).not.toHaveBeenCalled();
  });
  it("確認ボタンの並行二重押下でも同じ thread に1回だけ送る", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    f.client.createReply.mockResolvedValue({
      ...message("sent"),
      text: event.text,
      clientAssignedMessageId: row.messageId,
    });
    await f.bridge.handleAction("gc_send", row.id, "UOTHER");
    expect(f.client.createReply).not.toHaveBeenCalled();
    await Promise.all([
      f.bridge.handleAction("gc_send", row.id, "UALLOWED"),
      f.bridge.handleAction("gc_send", row.id, "UALLOWED"),
    ]);
    expect(f.client.createReply).toHaveBeenCalledExactlyOnceWith({
      threadName: row.threadName,
      text: event.text,
      messageId: row.messageId,
      requestId: row.requestId,
    });
    expect((await db.db.select().from(outbox))[0]?.status).toBe("sent");
  });
  it("キャンセル済み・停止した接続では投稿しない", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    await f.bridge.handleAction("gc_cancel", row.id, "UALLOWED");
    await f.bridge.handleAction("gc_send", row.id, "UALLOWED");
    expect((await db.db.select().from(outbox))[0]?.status).toBe("cancelled");
    await f.bridge.handleReply({ ...event, ts: "21.0" });
    const rows = await db.db.select().from(outbox);
    const next = rows.find((x) => x.slackReplyTs === "21.0");
    if (!next) throw Error("missing intent");
    await db.db.update(connections).set({ enabled: false });
    await f.bridge.handleAction("gc_send", next.id, "UALLOWED");
    expect(f.client.createReply).not.toHaveBeenCalled();
  });
  it("成否不明の返信は GET で照合し、POST を繰り返さない", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    f.client.createReply.mockRejectedValue(new GoogleChatError("unavailable"));
    await f.bridge.handleAction("gc_send", row.id, "UALLOWED");
    await f.bridge.handleAction("gc_send", row.id, "UALLOWED");
    expect((await db.db.select().from(outbox))[0]?.status).toBe("unknown");
    f.client.getMessage.mockResolvedValue(undefined);
    await f.bridge.handleAction("gc_check", row.id, "UALLOWED");
    expect((await db.db.select().from(outbox))[0]?.status).toBe("unknown");
    f.client.getMessage.mockResolvedValue({
      ...message("sent"),
      text: event.text,
      clientAssignedMessageId: row.messageId,
    });
    await f.bridge.handleAction("gc_check", row.id, "UALLOWED");
    expect(f.client.getMessage).toHaveBeenCalledWith(row.messageId);
    expect(f.client.createReply).toHaveBeenCalledOnce();
    expect((await db.db.select().from(outbox))[0]?.status).toBe("sent");
  });
  it("bridge の投稿だけを再取得時に抑止し、同じユーザーの通常発言は転送する", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    await db.db.update(outbox).set({ status: "unknown" }).where(eq(outbox.id, row.id));
    f.client.listMessages.mockResolvedValue({
      messages: [{ ...message("echo"), clientAssignedMessageId: row.messageId }, message("manual")],
    });
    await expireCooldown();
    await f.bridge.poll();
    const stored = await db.db.select().from(inbox);
    expect(stored.find((x) => x.messageName.endsWith(".echo"))?.status).toBe("suppressed");
    expect(stored.find((x) => x.messageName.endsWith(".manual"))?.status).toBe("sent");
  });
  it("接続先を設定変更しただけでは過去の対応を別スペースへ流用しない", async () => {
    const f = fixture();
    await f.bridge.poll();
    const changed = fixture({ spaceName: "spaces/OTHER" });
    await changed.bridge.poll();
    expect(changed.client.listMessages).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { op: "google_chat.config_mismatch", code: "config_mismatch" },
      expect.any(String),
    );
    await changed.bridge.handleReply(event);
    expect(await db.db.select().from(outbox)).toHaveLength(0);
  });

  it.each([
    "auth_revoked",
    "forbidden",
    "account_mismatch",
    "resource_mismatch",
  ] as const)("%s で接続を止め、再起動後も再通知しない", async (code) => {
    const f = fixture();
    f.client.listMessages.mockRejectedValue(new GoogleChatError(code, 403));
    await f.bridge.poll();
    await expireCooldown();
    await f.bridge.poll();
    const [row] = await db.db.select().from(connections);
    expect(row?.enabled).toBe(false);
    expect(row?.errorCode).toBe(code);
    expect(f.client.listMessages).toHaveBeenCalledOnce();
    expect(f.slackClient.postMessage).toHaveBeenCalledOnce();
  });
  it("返信で失効を検知した場合も別の確認済み返信を開始しない", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    await f.bridge.handleReply({ ...event, ts: "21.0" });
    const rows = await db.db.select().from(outbox);
    const first = rows[0];
    const second = rows[1];
    if (!first || !second) throw Error("missing intent");
    f.client.createReply.mockRejectedValue(new GoogleChatError("auth_revoked", 401));
    await f.bridge.handleAction("gc_send", first.id, "UALLOWED");
    await f.bridge.handleAction("gc_send", second.id, "UALLOWED");
    expect(f.client.createReply).toHaveBeenCalledOnce();
    expect((await db.db.select().from(connections))[0]?.enabled).toBe(false);
  });
  it("無効になった page token だけを破棄し、同じ区間を取り直す", async () => {
    const f = fixture();
    f.client.listMessages
      .mockResolvedValueOnce({ messages: [message()], nextPageToken: "expired" })
      .mockRejectedValueOnce(new GoogleChatError("invalid_input", 400))
      .mockResolvedValue({ messages: [message(), message("two")] });
    await f.bridge.poll();
    const previous = await db.db.select().from(connections);
    expect(previous[0]?.pageToken).toBeNull();
    expect(previous[0]?.windowBefore).not.toBeNull();
    await f.bridge.poll();
    expect(f.client.listMessages.mock.calls[2]?.[0]).toEqual(
      f.client.listMessages.mock.calls[0]?.[0],
    );
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
  });
  it("本文が一致しない照合結果を成功扱いにしない", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply(event);
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    await db.db.update(outbox).set({ status: "sending" }).where(eq(outbox.id, row.id));
    f.client.getMessage.mockResolvedValue(message("different"));
    await f.bridge.handleAction("gc_check", row.id, "UALLOWED");
    expect((await db.db.select().from(outbox))[0]?.status).toBe("unknown");
    expect(f.client.createReply).not.toHaveBeenCalled();
  });
  it("確認投稿の成否不明でも再イベントによる二重確認を避ける", async () => {
    const f = fixture();
    await f.bridge.poll();
    f.slackClient.postMessage.mockRejectedValue(new Error("private"));
    await f.bridge.handleReply(event);
    await f.bridge.handleReply(event);
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
    expect((await db.db.select().from(outbox))[0]?.errorCode).toBe("confirmation_delivery_unknown");
  });

  it.each([
    "not_in_channel",
    "channel_not_found",
    "invalid_blocks",
  ])("Slack の確定拒否 %s は pending を保ち、修正後に転送する", async (code) => {
    const f = fixture();
    f.slackClient.postMessage.mockRejectedValueOnce(
      new SlackApiError("slack.postMessage", toSlackChannelId(config.slackChannelId), code),
    );
    await f.bridge.poll();
    expect((await db.db.select().from(inbox))[0]).toMatchObject({
      status: "pending",
      errorCode: "slack_rejected",
    });
    await expireCooldown();
    await f.bridge.poll();
    expect((await db.db.select().from(inbox))[0]?.status).toBe("sent");
    expect(f.slackClient.postMessage).toHaveBeenCalledTimes(2);
  });
  it("429 の Retry-After は別プロセスと再起動でも維持する", async () => {
    const f = fixture();
    f.slackClient.postMessage.mockRejectedValueOnce(
      new SlackApiError("slack.postMessage", toSlackChannelId(config.slackChannelId), undefined, {
        kind: "rate_limited",
        retryAfterSeconds: 120,
      }),
    );
    await f.bridge.poll();
    const [saved] = await db.db.select().from(connections);
    expect(saved?.leaseToken).toBeNull();
    expect((saved?.leaseUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(110000);
    const restarted = fixture();
    await restarted.bridge.poll();
    expect(restarted.slackClient.postMessage).not.toHaveBeenCalled();
    expect(restarted.client.listMessages).not.toHaveBeenCalled();
    expect((await db.db.select().from(inbox))[0]?.status).toBe("pending");
    await expireCooldown();
    await restarted.bridge.poll();
    expect(restarted.slackClient.postMessage).toHaveBeenCalledOnce();
  });
  it("投稿前の表示エラーでは sending や unknown を残さず、POST もしない", async () => {
    const f = fixture();
    f.client.listMessages.mockResolvedValue({
      messages: [{ ...message(), text: "a".repeat(35001) }],
    });
    await f.bridge.poll();
    expect(f.slackClient.postMessage).not.toHaveBeenCalled();
    expect((await db.db.select().from(inbox))[0]).toMatchObject({
      status: "pending",
      errorCode: "slack_payload_invalid",
    });
    expect(await db.db.select().from(attempts)).toHaveLength(0);
  });
  it("受信専用から返信許可へ変更しても取得位置と既存スレッドを維持する", async () => {
    const receive = fixture({ allowedReplyUserIds: [] });
    await receive.bridge.poll();
    await receive.bridge.handleReply(event);
    expect(await db.db.select().from(outbox)).toHaveLength(0);
    const [before] = await db.db.select().from(connections);
    const enabled = fixture();
    await expireCooldown();
    await enabled.bridge.poll();
    await enabled.bridge.handleReply(event);
    const [after] = await db.db.select().from(connections);
    expect(after?.id).toBe(before?.id);
    expect(after?.configIdentity).toBe(before?.configIdentity);
    expect(await db.db.select().from(threads)).toHaveLength(1);
    expect(await db.db.select().from(outbox)).toHaveLength(1);
    expect(enabled.client.listMessages).toHaveBeenCalledOnce();
  });
  it("Slack 本文を平文へ戻した値を確認画面と送信の両方に使う", async () => {
    const f = fixture();
    await f.bridge.poll();
    const body = "資料 https://example.test/a?x=1&y=2 <条件> @UALLOWED";
    await f.bridge.handleReply({
      ...event,
      text: "資料 <https://example.test/a?x=1&amp;y=2|link> &lt;条件&gt; <@UALLOWED>",
    });
    const [row] = await db.db.select().from(outbox);
    if (!row) throw Error("missing intent");
    expect(row.body).toBe(body);
    expect(f.slackClient.postMessage.mock.calls[1]?.[1].blocks[0].text.text).toContain(body);
    f.client.createReply.mockResolvedValue({
      ...message("sent"),
      text: body,
      clientAssignedMessageId: row.messageId,
    });
    await f.bridge.handleAction("gc_send", row.id, "UALLOWED");
    expect(f.client.createReply.mock.calls[0]?.[0].text).toBe(body);
    expect((await db.db.select().from(outbox))[0]?.status).toBe("sent");
  });
  it("停止要求後は実行中の POST の結果を保存し、後続を開始しない", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.client.listMessages.mockResolvedValue({ messages: [message(), message("two")] });
    f.slackClient.postMessage.mockImplementationOnce(async () => {
      controller.abort();
      return { ts: toSlackTs("1.000000") };
    });
    await f.bridge.poll({ signal: controller.signal });
    expect(f.slackClient.postMessage).toHaveBeenCalledOnce();
    expect((await db.db.select().from(inbox)).map((x) => x.status).sort()).toEqual([
      "pending",
      "sent",
    ]);
  });

  it("長すぎる返信は本文を切って送らず、キャンセルとして記録する", async () => {
    const f = fixture();
    await f.bridge.poll();
    await f.bridge.handleReply({ ...event, text: "a".repeat(10001) });
    const [row] = await db.db.select().from(outbox);
    expect(row?.status).toBe("cancelled");
    if (row) await f.bridge.handleAction("gc_send", row.id, "UALLOWED");
    expect(f.client.createReply).not.toHaveBeenCalled();
  });
});
