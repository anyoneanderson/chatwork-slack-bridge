import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { createChatworkWebhookRoute } from "@/app/routes/chatwork-webhook";
import type { AppDeps } from "@/app/server";
import * as forwardModule from "@/app/services/forward-message";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";

const SIGNATURE_HEADER = "X-ChatWorkWebhookSignature";

// DUMMY 値（実トークン・実 ID を含まない / CON-005）。webhook token は base64 文字列。
const DUMMY_WEBHOOK_TOKEN = Buffer.from("dummy-webhook-secret").toString("base64");

/**
 * Chatwork 署名を本物の HMAC で計算する（検証ロジックと同じ手順）。
 * Base64( HMAC-SHA256( rawBody, base64decode(token) ) )。
 */
function sign(rawBody: string, token: string): string {
  const key = Buffer.from(token, "base64");
  return createHmac("sha256", key).update(Buffer.from(rawBody, "utf8")).digest("base64");
}

function makeConfig(): Config {
  return {
    DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
    PORT: 3000,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
    DB_HEALTH_TIMEOUT_MS: 123,
    SECRET_BACKEND: "env",
    DB_POOLED: false,
    CHATWORK_WEBHOOK_TOKEN: DUMMY_WEBHOOK_TOKEN,
    CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
    SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
    SLACK_DEFAULT_GROUP_CHANNEL_ID: "C0DUMMYGROUP",
    SLACK_DEFAULT_DM_CHANNEL_ID: "C0DUMMYDM",
  };
}

function makeDeps(): { deps: AppDeps; warnCalls: { payload: unknown; message: string }[] } {
  const warnCalls: { payload: unknown; message: string }[] = [];
  const logger = {
    info: vi.fn(),
    warn: (payload: unknown, message: string) => warnCalls.push({ payload, message }),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const deps: AppDeps = {
    db: { db: {}, ping: vi.fn(), close: vi.fn() } as unknown as DbClient,
    config: makeConfig(),
    logger,
    chatworkClient: { getRoom: vi.fn() } as unknown as ChatworkClient,
    slackClient: { postMessage: vi.fn() } as unknown as SlackClient,
  };
  return { deps, warnCalls };
}

/** 正常な message_created ペイロードの JSON 文字列を作る（ダミー値）。 */
function messageCreatedBody(): string {
  return JSON.stringify({
    webhook_setting_id: "1",
    webhook_event_type: "message_created",
    webhook_event_time: 1_700_000_000,
    webhook_event: {
      account_id: 1001,
      room_id: 2002,
      message_id: "msg-3003",
      body: "dummy message body",
      send_time: 1_700_000_000,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /chatwork/webhook", () => {
  it("returns 401 and does not call forwardMessage when the signature is invalid", async () => {
    // Arrange
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const body = messageCreatedBody();

    // Act: 署名ヘッダが誤り。
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: { [SIGNATURE_HEADER]: "not-a-valid-signature", "content-type": "application/json" },
      body,
    });

    // Assert
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when the signature header is missing", async () => {
    // Arrange
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);

    // Act: 署名ヘッダ欠落。
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageCreatedBody(),
    });

    // Assert
    expect(res.status).toBe(401);
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and does NOT call forwardMessage on valid signature with malformed JSON", async () => {
    // Arrange: 署名は raw body に対して正しいが本文が壊れた JSON。
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const body = "{ this is : not valid json";

    // Act
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: sign(body, DUMMY_WEBHOOK_TOKEN),
        "content-type": "application/json",
      },
      body,
    });

    // Assert: 500 にせず 200（再送ストーム回避）、forward は呼ばない。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and does NOT call forwardMessage on valid signature with schema-invalid payload", async () => {
    // Arrange: 署名は正しいが webhook_event が欠落（safeParse 失敗）。
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const body = JSON.stringify({ webhook_event_type: "message_created" });

    // Act
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: sign(body, DUMMY_WEBHOOK_TOKEN),
        "content-type": "application/json",
      },
      body,
    });

    // Assert
    expect(res.status).toBe(200);
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and does NOT call forwardMessage for a non-message_created event", async () => {
    // Arrange: 署名は正しいが対象外イベント（message_deleted）。
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const body = JSON.stringify({
      webhook_event_type: "message_deleted",
      webhook_event: {
        account_id: 1001,
        room_id: 2002,
        message_id: "msg-3003",
        body: "dummy",
        send_time: 1_700_000_000,
      },
    });

    // Act
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: sign(body, DUMMY_WEBHOOK_TOKEN),
        "content-type": "application/json",
      },
      body,
    });

    // Assert
    expect(res.status).toBe(200);
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and calls forwardMessage with the webhook_event on a valid message_created", async () => {
    // Arrange: 署名を raw body に対して計算（raw body が parse 前に読まれていることの担保）。
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const body = messageCreatedBody();

    // Act
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: sign(body, DUMMY_WEBHOOK_TOKEN),
        "content-type": "application/json",
      },
      body,
    });

    // Assert: 200 + forwardMessage が webhook_event で呼ばれる。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    const eventArg = forwardSpy.mock.calls[0]?.[0];
    expect(eventArg).toMatchObject({ account_id: 1001, room_id: 2002, message_id: "msg-3003" });
  });

  it("rejects a signature computed over a different body (raw body integrity)", async () => {
    // Arrange: 別の本文に対して計算した署名を、改竄後の本文に付ける。
    const forwardSpy = vi.spyOn(forwardModule, "forwardMessage").mockResolvedValue(undefined);
    const { deps } = makeDeps();
    const app = createChatworkWebhookRoute(deps);
    const signedBody = messageCreatedBody();
    const tamperedBody = signedBody.replace("msg-3003", "msg-9999");

    // Act: 署名は signedBody 用、送る本文は tamperedBody。
    const res = await app.request("/chatwork/webhook", {
      method: "POST",
      headers: {
        [SIGNATURE_HEADER]: sign(signedBody, DUMMY_WEBHOOK_TOKEN),
        "content-type": "application/json",
      },
      body: tamperedBody,
    });

    // Assert: raw body に対して検証されるため拒否される。
    expect(res.status).toBe(401);
    expect(forwardSpy).not.toHaveBeenCalled();
  });
});
