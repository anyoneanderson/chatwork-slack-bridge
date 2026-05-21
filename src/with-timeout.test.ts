import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeoutError, withTimeout } from "@/with-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves with value when promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "test.op")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError carrying op name when promise exceeds ms", async () => {
    vi.useFakeTimers();

    const promise = withTimeout(new Promise(() => undefined), 100, "slow.op");
    const capturedError = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);

    await expect(capturedError).resolves.toMatchObject({
      name: "TimeoutError",
      op: "slow.op",
    });
    await expect(capturedError).resolves.toBeInstanceOf(TimeoutError);
  });
});
