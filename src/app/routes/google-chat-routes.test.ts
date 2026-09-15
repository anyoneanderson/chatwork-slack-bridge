import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackEventsRoute } from "@/app/routes/slack-events";
import { createSlackInteractionsRoute } from "@/app/routes/slack-interactions";
import type { AppDeps } from "@/app/server";
import * as chatworkReply from "@/app/services/handle-slack-reply";
import * as chatworkSend from "@/app/services/send-outbound";

const secret = "dummy-signing-secret";
function deps(): AppDeps & { googleChatBridge: NonNullable<AppDeps["googleChatBridge"]> } {
  return {
    config: { SLACK_SIGNING_SECRET: secret },
    logger: { warn: vi.fn(), error: vi.fn() },
    googleChatBridge: {
      poll: vi.fn(),
      handleReply: vi.fn().mockResolvedValue(true),
      handleAction: vi.fn(),
    },
  } as unknown as AppDeps & { googleChatBridge: NonNullable<AppDeps["googleChatBridge"]> };
}
function request(body: string, valid = true): RequestInit {
  const time = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": time,
      "X-Slack-Signature": valid
        ? `v0=${createHmac("sha256", secret).update(`v0:${time}:${body}`).digest("hex")}`
        : "invalid",
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe("Google Chat の署名済み Slack 入力", () => {
  const event = JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      channel: "CFAKE",
      ts: "2.0",
      thread_ts: "1.0",
      user: "UFAKE",
      text: "reply",
    },
  });
  it("Google 所有確認が失敗したら503を返し、Chatworkへ渡さず秘密をログに出さない", async () => {
    const fallback = vi.spyOn(chatworkReply, "handleSlackReply").mockResolvedValue();
    const d = deps();
    vi.mocked(d.googleChatBridge.handleReply).mockRejectedValue(
      new Error("dummy-private-body dummy-refresh-token"),
    );
    const response = await createSlackEventsRoute(d).request("/slack/events", request(event));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(fallback).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledOnce();
    expect(vi.mocked(d.logger.error).mock.calls[0]?.[0]).toEqual({
      op: "google_chat.slack_event",
      code: "processing_failed",
    });
    expect(JSON.stringify(vi.mocked(d.logger.error).mock.calls)).not.toContain(
      "dummy-private-body",
    );
    expect(JSON.stringify(vi.mocked(d.logger.error).mock.calls)).not.toContain(
      "dummy-refresh-token",
    );
  });

  it.each([
    "gc_send",
    "gc_cancel",
    "gc_check",
  ])("%sの保存が失敗したら503を返し、Chatworkへ渡さず秘密をログに出さない", async (action) => {
    const send = vi.spyOn(chatworkSend, "sendOutbound").mockResolvedValue();
    const cancel = vi.spyOn(chatworkSend, "cancelOutbound").mockResolvedValue();
    const d = deps();
    vi.mocked(d.googleChatBridge.handleAction).mockRejectedValue(
      new Error("dummy-private-body dummy-refresh-token"),
    );
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "UFAKE" },
        actions: [{ action_id: action, value: "fake-outbound" }],
      }),
    }).toString();
    const response = await createSlackInteractionsRoute(d).request(
      "/slack/interactions",
      request(body),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(send).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledOnce();
    expect(vi.mocked(d.logger.error).mock.calls[0]?.[0]).toEqual({
      op: "google_chat.slack_action",
      code: "processing_failed",
    });
    expect(JSON.stringify(vi.mocked(d.logger.error).mock.calls)).not.toContain(
      "dummy-private-body",
    );
    expect(JSON.stringify(vi.mocked(d.logger.error).mock.calls)).not.toContain(
      "dummy-refresh-token",
    );
  });

  it("署名が不正なら Google の返信処理に到達しない", async () => {
    const d = deps();
    const r = await createSlackEventsRoute(d).request("/slack/events", request(event, false));
    expect(r.status).toBe(401);
    expect(d.googleChatBridge?.handleReply).not.toHaveBeenCalled();
  });
  it("Google の管理スレッドなら Chatwork に渡さない", async () => {
    const spy = vi.spyOn(chatworkReply, "handleSlackReply").mockResolvedValue();
    const d = deps();
    const r = await createSlackEventsRoute(d).request("/slack/events", request(event));
    expect(r.status).toBe(200);
    expect(d.googleChatBridge?.handleReply).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });
  it("Google の管理外なら既存 Chatwork 経路へ渡す", async () => {
    const spy = vi.spyOn(chatworkReply, "handleSlackReply").mockResolvedValue();
    const d = deps();
    vi.mocked(d.googleChatBridge.handleReply).mockResolvedValue(false);
    await createSlackEventsRoute(d).request("/slack/events", request(event));
    expect(spy).toHaveBeenCalledOnce();
  });
  it.each([
    "gc_send",
    "gc_cancel",
    "gc_check",
  ])("%s は署名検証後だけ Google に渡す", async (action) => {
    const spy = vi.spyOn(chatworkSend, "sendOutbound").mockResolvedValue();
    const d = deps();
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "UFAKE" },
        actions: [{ action_id: action, value: "fake-outbound" }],
      }),
    }).toString();
    const route = createSlackInteractionsRoute(d);
    expect((await route.request("/slack/interactions", request(body, false))).status).toBe(401);
    expect(d.googleChatBridge?.handleAction).not.toHaveBeenCalled();
    expect((await route.request("/slack/interactions", request(body))).status).toBe(200);
    expect(d.googleChatBridge?.handleAction).toHaveBeenCalledWith(action, "fake-outbound", "UFAKE");
    expect(spy).not.toHaveBeenCalled();
  });
});
