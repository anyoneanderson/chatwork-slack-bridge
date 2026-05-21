/** 操作が指定時間内に終わらなかったことを表す。 */
export class TimeoutError extends Error {
  public readonly op: string;

  /**
   * タイムアウトした操作名を保持する。
   *
   * @param op タイムアウトした操作名
   * @returns TimeoutError インスタンス
   */
  constructor(op: string) {
    super(`Operation timed out: ${op}`);
    this.name = "TimeoutError";
    this.op = op;
  }
}

/**
 * Promise に上限時間を設定する。
 *
 * @param promise 実行対象の Promise
 * @param ms タイムアウトまでのミリ秒
 * @param op ログ・エラー識別用の操作名
 * @returns 元の Promise の解決値
 * @throws TimeoutError ms を超えても完了しない場合
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, op: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(op));
    }, ms);
  });

  // DB 側の処理を止める仕組みではなく、health 応答の上限を守るために競争させる。
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}
