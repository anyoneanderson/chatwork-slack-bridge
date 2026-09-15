import { startGoogleChatPoller } from "@/app/services/google-chat-poller";
import type { Logger } from "@/logger";

export type GoogleChatPollResult = "completed" | "busy" | "stopped" | "interrupted" | "failed";

export interface GoogleChatPollRuntime {
  /**
   * @returns 保存と外部通信が完了した後の取得結果。同時実行は開始しない
   * @throws なし。失敗は固定の結果へ変換する
   */
  run(): Promise<GoogleChatPollResult>;
  /**
   * @returns 新しい取得を禁止し、実行中の保存と外部通信が完了するまで待つ
   * @throws なし
   */
  stop(): Promise<void>;
}

/**
 * 外部通信の結果を保存してから応答できるよう、期限到達時は取得境界で停止する。
 * @param poll 停止要求をページ・メッセージ間で確認する取得処理
 * @param logger 本文や秘密を記録しないロガー
 * @param deadlineMs 新しい取得・送信を止め始めるまでの時間。null は時間制限なし
 * @returns タイマーと HTTP の両方で使用できる取得制御
 * @throws なし。取得エラーは固定の結果へ変換する
 */
export function createGoogleChatPollRuntime(
  poll: (signal: AbortSignal) => Promise<void>,
  logger: Logger,
  deadlineMs: number | null = 45000,
): GoogleChatPollRuntime {
  let stopped = false;
  let active: Promise<GoogleChatPollResult> | undefined;
  let controller: AbortController | undefined;
  return {
    async run() {
      if (stopped) return "stopped";
      if (active) return "busy";
      const current = new AbortController();
      controller = current;
      const deadline =
        deadlineMs === null ? undefined : setTimeout(() => current.abort(), deadlineMs);
      deadline?.unref();
      active = Promise.resolve().then(async (): Promise<GoogleChatPollResult> => {
        try {
          await poll(current.signal);
          return current.signal.aborted ? "interrupted" : "completed";
        } catch {
          logger.error({ op: "google_chat.poll_run" }, "Google Chat polling failed");
          return "failed";
        } finally {
          clearTimeout(deadline);
          controller = undefined;
          active = undefined;
        }
      });
      return active;
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await active;
    },
  };
}

/**
 * @param poll 保存済みの接続を一回取得する処理
 * @param schedule 起動方法とタイマーの待機間隔
 * @param logger 本文や秘密を記録しないロガー
 * @returns 外部モードでは呼び出しまで待機し、タイマーモードでは取得を開始する制御
 * @throws なし。取得エラーは固定の結果へ変換する
 */
export function startGoogleChatPolling(
  poll: (signal: AbortSignal) => Promise<void>,
  schedule: { mode: "timer" | "external"; intervalMs: number },
  logger: Logger,
): GoogleChatPollRuntime {
  const runtime = createGoogleChatPollRuntime(
    poll,
    logger,
    schedule.mode === "external" ? 45000 : null,
  );
  const timer =
    schedule.mode === "timer"
      ? startGoogleChatPoller(
          async () => {
            await runtime.run();
          },
          schedule.intervalMs,
          logger,
        )
      : undefined;
  return {
    run: runtime.run,
    async stop() {
      await Promise.all([runtime.stop(), timer?.stop()]);
    },
  };
}
