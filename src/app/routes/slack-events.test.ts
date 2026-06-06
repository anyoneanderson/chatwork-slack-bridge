import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { createSlackEventsRoute } from "@/app/routes/slack-events";
import type { AppDeps } from "@/app/server";
import * as handleModule from "@/app/services/handle-slack-reply";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";

// DUMMY 値（実 secret / channel / ts を含まない / CON-003）。
const DUMMY_SIGNING_SECRET = "dummy-slack-signing-secret";
const DUMMY_CHANNEL = "C0DUMMYCHAN";
const DUMMY_TS = "1700000000.000100";
const DUMMY_THREAD_TS = "1700000000.000000";
const DUMMY_USER = "U0DUMMYUSER";

/** Slack 署名を本物の HMAC で計算する（検証ロジックと同手順）。 */
function sign(rawBody: string, timestamp: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(Buffer.from(rawBody, "utf8")).digest("hex")}`;
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
    CHATWORK_WEBHOOK_TOKEN: "dummy-webhook-token",
    CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
    SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
    SLACK_SIGNING_SECRET: DUMMY_SIGNING_SECRET,
    SLACK_DEFAULT_GROUP_CHANNEL_ID: "C0DUMMYGROUP",
    SLACK_DEFAULT_DM_CHANNEL_ID: "C0DUMMYDM",
  };
}

function makeDeps(): AppDeps {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  return {
    db: { db: {}, ping: vi.fn(), close: vi.fn() } as unknown as DbClient,
    config: makeConfig(),
    logger,
    chatworkClient: { getRoom: vi.fn() } as unknown as ChatworkClient,
    slackClient: { postMessage: vi.fn() } as unknown as SlackClient,
  };
}

/** 署名済みリクエストを送る。timestamp 既定は現在時刻（スキュー内）。 */
function signedRequest(body: string, secret: string, timestamp?: string): RequestInit {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sign(body, ts, secret),
    },
    body,
  };
}

function messageEventBody(): string {
  return JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      user: DUMMY_USER,
      text: "dummy reply",
      ts: DUMMY_TS,
      thread_ts: DUMMY_THREAD_TS,
      channel: DUMMY_CHANNEL,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /slack/events", () => {
  it("returns 401 and does not reach handleSlackReply when the signature is invalid", async () => {
    const handleSpy = vi.spyOn(handleModule, "handleSlackReply").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);

    const res = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Slack-Signature": "v0=deadbeef",
      },
      body: messageEventBody(),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when signature headers are missing", async () => {
    const handleSpy = vi.spyOn(handleModule, "handleSlackReply").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);

    const res = await app.request("/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messageEventBody(),
    });

    expect(res.status).toBe(401);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("responds to url_verification with the challenge", async () => {
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);
    const body = JSON.stringify({ type: "url_verification", challenge: "dummy-challenge" });

    const res = await app.request("/slack/events", signedRequest(body, DUMMY_SIGNING_SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "dummy-challenge" });
  });

  it("returns 200 on invalid JSON without reaching handleSlackReply", async () => {
    const handleSpy = vi.spyOn(handleModule, "handleSlackReply").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);
    const body = "{not-json";

    const res = await app.request("/slack/events", signedRequest(body, DUMMY_SIGNING_SECRET));

    expect(res.status).toBe(200);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("returns 200 on an invalid payload (schema mismatch) without reaching handleSlackReply", async () => {
    const handleSpy = vi.spyOn(handleModule, "handleSlackReply").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);
    const body = JSON.stringify({ type: "event_callback", event: { type: "reaction_added" } });

    const res = await app.request("/slack/events", signedRequest(body, DUMMY_SIGNING_SECRET));

    expect(res.status).toBe(200);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("calls handleSlackReply with the channel for a message event", async () => {
    const handleSpy = vi.spyOn(handleModule, "handleSlackReply").mockResolvedValue(undefined);
    const deps = makeDeps();
    const app = createSlackEventsRoute(deps);

    const res = await app.request(
      "/slack/events",
      signedRequest(messageEventBody(), DUMMY_SIGNING_SECRET),
    );

    expect(res.status).toBe(200);
    expect(handleSpy).toHaveBeenCalledTimes(1);
    const call = handleSpy.mock.calls[0];
    const event = call?.[0] as { channel: string; thread_ts?: string };
    expect(event.channel).toBe(DUMMY_CHANNEL);
    expect(event.thread_ts).toBe(DUMMY_THREAD_TS);
  });
});
