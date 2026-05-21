import type { SecretKey, SecretProvider } from "@/adapters/secrets/types";

/** process.env を SecretProvider として扱うローカル・コンテナ向け実装。 */
export class EnvSecretProvider implements SecretProvider {
  /**
   * 環境変数からキーに対応する値を取得する。
   *
   * @param key 取得する秘密情報・設定値のキー
   * @returns 環境変数の値。未設定の場合は undefined
   */
  get(key: SecretKey): string | undefined {
    return process.env[key];
  }
}
