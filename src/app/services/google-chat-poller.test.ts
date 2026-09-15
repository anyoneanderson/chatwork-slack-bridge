import { afterEach, expect, it, vi } from "vitest";
import { startGoogleChatPoller } from "@/app/services/google-chat-poller";
import type { Logger } from "@/logger";

afterEach(() => vi.useRealTimers());
it("取得中に次回を重ねず、停止時は実行中の取得を待つ", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const poll = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const loop = startGoogleChatPoller(poll, 1000, {} as Logger);
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll).toHaveBeenCalledTimes(1);
  const stop = loop.stop();
  expect(poll.mock.calls[0]?.[0].aborted).toBe(true);
  finish();
  await stop;
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll).toHaveBeenCalledTimes(1);
});
it("失敗の生本文を記録せず、次回の取得を継続する", async () => {
  vi.useFakeTimers();
  const logger = { error: vi.fn() } as unknown as Logger;
  const poll = vi
    .fn()
    .mockRejectedValueOnce(new Error("private-token-and-body"))
    .mockResolvedValue(undefined);
  const loop = startGoogleChatPoller(poll, 1000, logger);
  await vi.advanceTimersByTimeAsync(1000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("private-token");
  await loop.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(poll).toHaveBeenCalledTimes(2);
});
