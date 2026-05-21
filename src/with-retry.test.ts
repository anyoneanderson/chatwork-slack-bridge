import { afterEach, describe, expect, it, vi } from "vitest";

import { withRetry } from "@/with-retry";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry", () => {
  it("returns the resolved value without retrying on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, { retries: 2 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to retries+1 times and re-throws the last error when all fail", async () => {
    vi.useFakeTimers();

    const lastError = new Error("attempt-3");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("attempt-1"))
      .mockRejectedValueOnce(new Error("attempt-2"))
      .mockRejectedValueOnce(lastError);

    const promise = withRetry(fn, { retries: 2, baseDelayMs: 100 });
    const captured = promise.catch((err: unknown) => err);

    // 全バックオフ（100ms + 200ms）を消化させる。
    await vi.runAllTimersAsync();

    await expect(captured).resolves.toBe(lastError);
    // retries:2 → 初回 + リトライ 2 回 = 最大 3 回。
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("waits with exponential backoff between attempts", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("attempt-1"))
      .mockRejectedValueOnce(new Error("attempt-2"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { retries: 2, baseDelayMs: 100 });
    const captured = promise.catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    await captured;
    // baseDelayMs * 2 ** attempt → 100ms（attempt 0）, 200ms（attempt 1）。
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toEqual([100, 200]);
  });

  it("succeeds after a transient failure and stops retrying", async () => {
    vi.useFakeTimers();

    const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { retries: 2, baseDelayMs: 50 });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
