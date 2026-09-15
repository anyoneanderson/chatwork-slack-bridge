import type { Logger } from "@/logger";

/**
 * 同じプロセス内の重複起動を避け、取得終了後に次回を予約する。
 * @param poll 停止要求をメッセージ間の境界で確認する取得処理
 * @param intervalMs 取得終了から次回開始までの待ち時間
 * @param logger 本文を記録しないロガー
 * @returns 実行中の外部通信の完了を待って停止する操作
 */
export function startGoogleChatPoller(
  poll: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  logger: Logger,
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const controller = new AbortController();

  async function run(): Promise<void> {
    try {
      await poll(controller.signal);
    } catch {
      // DB / API の生エラーには認証情報や本文が含まれる可能性がある。
      logger.error({ op: "google_chat.poll" }, "Google Chat polling failed");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        active = run();
      }, intervalMs);
      timer.unref();
    }
  }
  active = run();
  return {
    async stop() {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
