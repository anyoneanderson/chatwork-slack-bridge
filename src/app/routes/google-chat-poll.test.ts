import { describe, expect, it, vi } from "vitest";
import { createGoogleChatPollRoute } from "@/app/routes/google-chat-poll";
import { type AppDeps, createApp } from "@/app/server";
import { createGoogleChatPollRuntime } from "@/app/services/google-chat-poll-runtime";
import type { Logger } from "@/logger";

const token = "dummy-poll-token-".repeat(3);
const path = "/internal/poll-google-chat";
function setup() {
  const runtime = { run: vi.fn().mockResolvedValue("completed"), stop: vi.fn() };
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  return { runtime, logger, route: createGoogleChatPollRoute({ runtime, token, logger }) };
}
function request(authorization: string | undefined = `Bearer ${token}`, body?: string) {
  return {
    method: "POST",
    headers: authorization === undefined ? {} : { Authorization: authorization },
    ...(body === undefined ? {} : { body }),
  };
}

describe("authenticated Google Chat poll endpoint", () => {
  it.each([
    "",
    "Bearer wrong",
    `Basic ${token}`,
    `Bearer ${token}extra`,
    `Bearer ${token} ${token}`,
  ])("rejects invalid authorization without invoking Google Chat", async (authorization) => {
    const { route, runtime, logger } = setup();
    const response = await route.request(path, request(authorization));
    expect(response.status).toBe(401);
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(token);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(token);
  });

  it("rejects a missing authorization header", async () => {
    const { route, runtime } = setup();
    expect((await route.request(path, { method: "POST" })).status).toBe(401);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it.each([undefined, "{}"])("accepts an authenticated empty invocation", async (body) => {
    const { route, runtime } = setup();
    const response = await route.request(path, request(`Bearer ${token}`, body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, complete: true });
    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"space":"spaces/PRIVATE"}',
    " ".repeat(1025),
  ])("rejects payload overrides and oversized requests", async (body) => {
    const { route, runtime } = setup();
    const response = await route.request(path, request(`Bearer ${token}`, body));
    expect(response.status).toBe(400);
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("PRIVATE");
  });

  it.each([
    "busy",
    "stopped",
    "failed",
  ])("keeps %s retryable with a fixed response", async (outcome) => {
    const { route, runtime } = setup();
    runtime.run.mockResolvedValue(outcome);
    const response = await route.request(path, request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "poll_unavailable" });
  });

  it("rejects connection overrides supplied through query parameters", async () => {
    const { route, runtime } = setup();
    const response = await route.request(`${path}?space=spaces%2FPRIVATE`, request());
    expect(response.status).toBe(400);
    expect(runtime.run).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("PRIVATE");
  });

  it("acknowledges a cooperatively interrupted poll without asking the scheduler to retry", async () => {
    const { route, runtime } = setup();
    runtime.run.mockResolvedValue("interrupted");
    const response = await route.request(path, request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, complete: false });
  });

  it("holds the HTTP response until work completes and prevents overlapping polls", async () => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const logger = { error: vi.fn() } as unknown as Logger;
    const runtime = createGoogleChatPollRuntime(poll, logger);
    const route = createGoogleChatPollRoute({ runtime, token, logger });
    const settled = vi.fn();
    const first = Promise.resolve(route.request(path, request())).then((response) => {
      settled();
      return response;
    });
    await entered;
    expect(settled).not.toHaveBeenCalled();
    expect((await route.request(path, request())).status).toBe(503);
    expect(poll).toHaveBeenCalledOnce();
    finish();
    expect((await first).status).toBe(200);
    await runtime.stop();
  });

  it("sanitizes unexpected runtime exceptions in responses and logs", async () => {
    const { route, runtime, logger } = setup();
    runtime.run.mockRejectedValue(new Error(`PRIVATE_BODY ${token}`));
    const response = await route.request(path, request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "poll_unavailable" });
    const logs = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logs).not.toContain("PRIVATE_BODY");
    expect(logs).not.toContain(token);
  });

  it("mounts the authenticated endpoint when the external bridge is configured", async () => {
    const { runtime, logger } = setup();
    const deps = {
      logger,
      config: {},
      googleChatBridge: {},
      googleChatPoll: { runtime, token },
    } as unknown as AppDeps;
    const app = createApp(deps);
    expect((await app.request(path, request())).status).toBe(200);
    expect(
      (await app.request(path, { method: "GET", headers: { Authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(404);
    expect(runtime.run).toHaveBeenCalledOnce();
  });

  it.each(["disabled", "timer"])("does not expose the endpoint in %s mode", async (mode) => {
    const { runtime, logger } = setup();
    const deps = {
      logger,
      config: {},
      ...(mode === "disabled" ? { googleChatPoll: { runtime, token } } : { googleChatBridge: {} }),
    } as unknown as AppDeps;
    const response = await createApp(deps).request(path, request());
    expect(response.status).toBe(404);
    expect(runtime.run).not.toHaveBeenCalled();
  });
});
