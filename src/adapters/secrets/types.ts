/** Phase 2 で扱う設定キー。typo をコンパイル時に検出するため固定値から union 型を導く。 */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "PORT",
  "LOG_LEVEL",
  "NODE_ENV",
  "DB_HEALTH_TIMEOUT_MS",
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];

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
