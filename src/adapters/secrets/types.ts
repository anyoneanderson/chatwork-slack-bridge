/** Phase 2 で扱う設定キー。typo をコンパイル時に検出するため固定値から union 型を導く。 */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "PORT",
  "LOG_LEVEL",
  "NODE_ENV",
  "DB_HEALTH_TIMEOUT_MS",
  "SECRET_BACKEND",
  "GOOGLE_CLOUD_PROJECT",
  "DATABASE_URL_SECRET",
  "DB_POOLED",
  "CHATWORK_WEBHOOK_TOKEN",
  "CHATWORK_API_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_DEFAULT_GROUP_CHANNEL_ID",
  "SLACK_DEFAULT_DM_CHANNEL_ID",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * 秘密情報の取得に失敗したことを表す。
 *
 * 値・シークレット名・接続文字列は保持せず、どのキー区分で失敗したかのみを伝える
 * （ログ・メッセージに秘密を含めない）。
 */
export class SecretAccessError extends Error {
  public readonly key: SecretKey;

  /**
   * 取得に失敗したキーを保持する。
   *
   * @param key 取得に失敗した秘密キー
   * @returns SecretAccessError インスタンス
   */
  constructor(key: SecretKey) {
    super(`Failed to access secret for key: ${key}`);
    this.name = "SecretAccessError";
    this.key = key;
  }
}

/** 秘密情報・設定値の取得経路を抽象化する。 */
export interface SecretProvider {
  /**
   * キーに対応する値を返す。
   *
   * @param key 取得する秘密情報・設定値のキー
   * @returns 設定値。未設定の場合は undefined
   */
  get(key: SecretKey): string | undefined;
}
