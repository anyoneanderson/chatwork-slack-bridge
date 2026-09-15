import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleChatPollRuntime,
  startGoogleChatPolling,
} from "@/app/services/google-chat-poll-runtime";
import type { Logger } from "@/logger";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function logger() {
  return { error: vi.fn() } as unknown as Logger;
}
afterEach(() => vi.useRealTimers());

describe("external Google Chat polling lifecycle", () => {
  it("does not poll at creation and only resolves after the requested poll completes", async () => {
    const work = deferred();
    const poll = vi.fn().mockReturnValue(work.promise);
    const runtime = createGoogleChatPollRuntime(poll, logger());
    expect(poll).not.toHaveBeenCalled();
    const settled = vi.fn();
    const run = runtime.run().then(settled);
    await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    work.resolve();
    await run;
    expect(settled).toHaveBeenCalledWith("completed");
    await runtime.stop();
  });

  it("rejects overlapping requests and permits a later independent run", async () => {
    const work = deferred();
    const poll = vi.fn().mockReturnValueOnce(work.promise).mockResolvedValue(undefined);
    const runtime = createGoogleChatPollRuntime(poll, logger());
    const first = runtime.run();
    expect(await runtime.run()).toBe("busy");
    expect(poll).toHaveBeenCalledOnce();
    work.resolve();
    expect(await first).toBe("completed");
    expect(await runtime.run()).toBe("completed");
    expect(poll).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("aborts at the deadline but keeps the request and lock until active work finishes", async () => {
    vi.useFakeTimers();
    const work = deferred();
    const poll = vi.fn((_signal: AbortSignal) => work.promise);
    const runtime = createGoogleChatPollRuntime(poll, logger(), 1000);
    const settled = vi.fn();
    const running = runtime.run().then(settled);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll.mock.calls[0]?.[0].aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(await runtime.run()).toBe("busy");
    work.resolve();
    await running;
    expect(settled).toHaveBeenCalledWith("interrupted");
    await runtime.stop();
  });

  it("graceful shutdown cancels active polling and waits for its cleanup", async () => {
    const work = deferred();
    const poll = vi.fn((_signal: AbortSignal) => work.promise);
    const runtime = createGoogleChatPollRuntime(poll, logger());
    const running = runtime.run();
    const stopped = vi.fn();
    const stopping = runtime.stop().then(stopped);
    await Promise.resolve();
    expect(poll.mock.calls[0]?.[0].aborted).toBe(true);
    expect(stopped).not.toHaveBeenCalled();
    expect(await runtime.run()).toBe("stopped");
    work.resolve();
    await stopping;
    expect(await running).toBe("interrupted");
    expect(stopped).toHaveBeenCalledOnce();
    expect(await runtime.run()).toBe("stopped");
  });

  it("returns a fixed failure and releases the lock without logging raw exception data", async () => {
    const log = logger();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRIVATE_TOKEN PRIVATE_BODY"))
      .mockResolvedValue(undefined);
    const runtime = createGoogleChatPollRuntime(poll, log);
    expect(await runtime.run()).toBe("failed");
    expect(log.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("PRIVATE_");
    expect(await runtime.run()).toBe("completed");
    await runtime.stop();
  });
});

describe("Google Chat polling startup mode", () => {
  it("starts immediately and schedules subsequent polls in timer mode", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const runtime = startGoogleChatPolling(poll, { mode: "timer", intervalMs: 1000 }, logger());
    await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("allows timer polling beyond the external deadline and still cancels on shutdown", async () => {
    vi.useFakeTimers();
    const work = deferred();
    const poll = vi.fn((_signal: AbortSignal) => work.promise);
    const runtime = startGoogleChatPolling(poll, { mode: "timer", intervalMs: 1000 }, logger());
    await vi.advanceTimersByTimeAsync(90000);
    expect(poll).toHaveBeenCalledOnce();
    expect(poll.mock.calls[0]?.[0].aborted).toBe(false);
    const settled = vi.fn();
    const stopping = runtime.stop().then(settled);
    expect(poll.mock.calls[0]?.[0].aborted).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    work.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledOnce();
  });

  it("applies the cooperative 45 second deadline to external polling", async () => {
    vi.useFakeTimers();
    const work = deferred();
    const poll = vi.fn((_signal: AbortSignal) => work.promise);
    const runtime = startGoogleChatPolling(poll, { mode: "external", intervalMs: 1000 }, logger());
    const running = runtime.run();
    await vi.advanceTimersByTimeAsync(44999);
    expect(poll.mock.calls[0]?.[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.mock.calls[0]?.[0].aborted).toBe(true);
    work.resolve();
    expect(await running).toBe("interrupted");
    await runtime.stop();
  });

  it("never starts background polling in external mode, including after an HTTP invocation", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const runtime = startGoogleChatPolling(poll, { mode: "external", intervalMs: 1000 }, logger());
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
    expect(await runtime.run()).toBe("completed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledOnce();
    await runtime.stop();
  });
});
