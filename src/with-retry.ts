/** リトライ動作を制御するオプション。 */
export interface RetryOptions {
  /** 失敗時の追加試行回数（初回実行を除く）。既定 2。 */
  retries?: number;
  /** 指数バックオフの基準待機ミリ秒（試行ごとに 2 のべき乗で増える）。既定 100。 */
  baseDelayMs?: number;
}

/**
 * 非同期操作を指数バックオフで再試行する薄いヘルパー。
 *
 * 初回実行を含め最大 `retries + 1` 回まで `fn` を呼び出す。各失敗の待機時間は
 * `baseDelayMs * 2 ** attempt`（attempt は 0 始まり）。すべて失敗した場合は
 * 最後に捕捉した例外をそのまま再 throw する（呼び出し側でログ整形・秘匿する）。
 *
 * @param fn 実行する非同期操作（試行ごとに新しい Promise を生成すること）
 * @param options リトライ回数・バックオフ基準値
 * @returns `fn` の解決値
 * @throws 全試行が失敗した場合、最後に捕捉した例外
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 100;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await delay(baseDelayMs * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

/**
 * 指定ミリ秒だけ待機する。
 *
 * @param ms 待機するミリ秒
 * @returns 待機完了で解決する Promise
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
