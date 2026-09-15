import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { createSlackInteractionsRoute } from "@/app/routes/slack-interactions";
import type { AppDeps } from "@/app/server";
import * as sendModule from "@/app/services/send-outbound";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";

// DUMMY 値（実 secret / user / outbound id を含まない / CON-003）。
const DUMMY_SIGNING_SECRET = "dummy-slack-signing-secret";
const DUMMY_USER = "U0DUMMYUSER";
const OUTBOUND_ID = "42";

/** Slack 署名を本物の HMAC で計算する（検証ロジックと同手順）。 */
function sign(rawBody: string, timestamp: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(Buffer.from(rawBody, "utf8")).digest("hex")}`;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
    PORT: 3000,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
    DB_HEALTH_TIMEOUT_MS: 123,
    SECRET_BACKEND: "env",
    DB_POOLED: false,
    CHATWORK_WEBHOOK_TOKEN: "dummy-webhook-token",
    CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
    SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
    SLACK_SIGNING_SECRET: DUMMY_SIGNING_SECRET,
    SLACK_DEFAULT_GROUP_CHANNEL_ID: "C0DUMMYGROUP",
    SLACK_DEFAULT_DM_CHANNEL_ID: "C0DUMMYDM",
    ...overrides,
  };
}

function makeDeps(configOverrides: Partial<Config> = {}): AppDeps {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return {
    db: { db: {}, ping: vi.fn(), close: vi.fn() } as unknown as DbClient,
    config: makeConfig(configOverrides),
    logger,
    chatworkClient: { postMessage: vi.fn() } as unknown as ChatworkClient,
    slackClient: { updateMessage: vi.fn() } as unknown as SlackClient,
  };
}

/** block_actions payload を form-urlencoded（payload=<json>）にして署名済みリクエストを作る。 */
function signedInteractionRequest(
  actionId: string,
  value: string | undefined,
  secret: string,
): RequestInit {
  const payload = JSON.stringify({
    type: "block_actions",
    user: { id: DUMMY_USER },
    actions: [value === undefined ? { action_id: actionId } : { action_id: actionId, value }],
  });
  const body = new URLSearchParams({ payload }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sign(body, ts, secret),
    },
    body,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /slack/interactions", () => {
  it("returns 401 and does not reach sendOutbound when the signature is invalid", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);
    const body = new URLSearchParams({ payload: "{}" }).toString();

    const res = await app.request("/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Slack-Signature": "v0=deadbeef",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("returns 200 on missing payload field", async () => {
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);
    const body = new URLSearchParams({ other: "x" }).toString();
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await app.request("/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(body, ts, DUMMY_SIGNING_SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("returns 200 on an invalid payload JSON", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);
    const body = new URLSearchParams({ payload: "{not-json" }).toString();
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await app.request("/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sign(body, ts, DUMMY_SIGNING_SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("calls sendOutbound for a cw_send action", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);

    const res = await app.request(
      "/slack/interactions",
      signedInteractionRequest("cw_send", OUTBOUND_ID, DUMMY_SIGNING_SECRET),
    );

    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const input = sendSpy.mock.calls[0]?.[0] as { outboundId: string; pressUserId: string };
    expect(input.outboundId).toBe(OUTBOUND_ID);
    expect(input.pressUserId).toBe(DUMMY_USER);
  });

  it("calls cancelOutbound for a cw_cancel action", async () => {
    const cancelSpy = vi.spyOn(sendModule, "cancelOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);

    const res = await app.request(
      "/slack/interactions",
      signedInteractionRequest("cw_cancel", OUTBOUND_ID, DUMMY_SIGNING_SECRET),
    );

    expect(res.status).toBe(200);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 200 and does nothing for an unknown action", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const cancelSpy = vi.spyOn(sendModule, "cancelOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);

    const res = await app.request(
      "/slack/interactions",
      signedInteractionRequest("unknown_action", OUTBOUND_ID, DUMMY_SIGNING_SECRET),
    );

    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it("returns 200 and does nothing when value is missing", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackInteractionsRoute(deps);

    const res = await app.request(
      "/slack/interactions",
      signedInteractionRequest("cw_send", undefined, DUMMY_SIGNING_SECRET),
    );

    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("passes the parsed allowlist from config to sendOutbound deps", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendOutbound").mockResolvedValue(undefined);
    const deps = makeDeps({ SLACK_ALLOWED_REPLY_USER_IDS: " U0ADMIN1 , U0ADMIN2 ," });
    const app = createSlackInteractionsRoute(deps);

    await app.request(
      "/slack/interactions",
      signedInteractionRequest("cw_send", OUTBOUND_ID, DUMMY_SIGNING_SECRET),
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sendDeps = sendSpy.mock.calls[0]?.[1] as { allowedReplyUserIds: readonly string[] };
    expect(sendDeps.allowedReplyUserIds).toEqual(["U0ADMIN1", "U0ADMIN2"]);
  });
});
