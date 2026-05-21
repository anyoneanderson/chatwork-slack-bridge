import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";
import { createGcpSecretProvider } from "@/adapters/secrets/gcp-secret-provider";
import type { SecretProvider } from "@/adapters/secrets/types";

/**
 * SECRET_BACKEND=gcp で必須の参照情報が欠落していることを表す。
 *
 * 値（プロジェクト ID・シークレット名・接続文字列）は保持せず、欠落したキー名のみを伝える
 * （ログ・メッセージに秘密や設定の実値を含めない）。
 */
export class SecretConfigError extends Error {
  /** 欠落している必須設定キー名の一覧。実値は含まない。 */
  public readonly missingKeys: readonly string[];

  /**
   * 欠落キー名を保持する。
   *
   * @param missingKeys 欠落している必須設定キー名（値は含めない）
   * @returns SecretConfigError インスタンス
   */
  constructor(missingKeys: readonly string[]) {
    super(`Missing required secret configuration: ${missingKeys.join(", ")}`);
    this.name = "SecretConfigError";
    this.missingKeys = missingKeys;
  }
}

/**
 * `SECRET_BACKEND` に応じて `SecretProvider` を構築する。
 *
 * `env`（既定）はローカル / compose 向けの `EnvSecretProvider` を同期的に返す。
 * `gcp` は Secret Manager から対象シークレットをプリフェッチした同期 `SecretProvider` を返す。
 *
 * backend 判定・Secret Manager 参照に必要な `SECRET_BACKEND` / `GOOGLE_CLOUD_PROJECT` /
 * `DATABASE_URL_SECRET` / `CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` /
 * `SLACK_BOT_TOKEN_SECRET` は secret provider 構築前に必要なため、`process.env` から直接読む
 * （シークレット名・スイッチであり秘密の実値ではない）。
 *
 * @returns 構築済みの `SecretProvider`
 * @throws SecretConfigError gcp backend で `GOOGLE_CLOUD_PROJECT` / `DATABASE_URL_SECRET` /
 *   `CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` / `SLACK_BOT_TOKEN_SECRET` が
 *   欠落している場合（キー名のみ保持）
 * @throws SecretAccessError gcp backend で Secret Manager アクセスに失敗した場合（`createGcpSecretProvider` 由来）
 */
export async function createSecretProvider(): Promise<SecretProvider> {
  const backend = process.env.SECRET_BACKEND ?? "env";
  if (backend !== "gcp") {
    return new EnvSecretProvider();
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  const databaseUrlSecret = process.env.DATABASE_URL_SECRET;
  // トークン系秘密の Secret Manager シークレット名（DATABASE_URL_SECRET と同じ仕組み）。
  const chatworkWebhookTokenSecret = process.env.CHATWORK_WEBHOOK_TOKEN_SECRET;
  const chatworkApiTokenSecret = process.env.CHATWORK_API_TOKEN_SECRET;
  const slackBotTokenSecret = process.env.SLACK_BOT_TOKEN_SECRET;

  // 欠落キー名のみを収集する。値（プロジェクト ID・シークレット名）はエラーに含めない。
  const missingKeys: string[] = [];
  if (!projectId) {
    missingKeys.push("GOOGLE_CLOUD_PROJECT");
  }
  if (!databaseUrlSecret) {
    missingKeys.push("DATABASE_URL_SECRET");
  }
  if (!chatworkWebhookTokenSecret) {
    missingKeys.push("CHATWORK_WEBHOOK_TOKEN_SECRET");
  }
  if (!chatworkApiTokenSecret) {
    missingKeys.push("CHATWORK_API_TOKEN_SECRET");
  }
  if (!slackBotTokenSecret) {
    missingKeys.push("SLACK_BOT_TOKEN_SECRET");
  }
  if (
    !projectId ||
    !databaseUrlSecret ||
    !chatworkWebhookTokenSecret ||
    !chatworkApiTokenSecret ||
    !slackBotTokenSecret
  ) {
    throw new SecretConfigError(missingKeys);
  }

  return createGcpSecretProvider({
    projectId,
    secretNames: {
      DATABASE_URL: databaseUrlSecret,
      CHATWORK_WEBHOOK_TOKEN: chatworkWebhookTokenSecret,
      CHATWORK_API_TOKEN: chatworkApiTokenSecret,
      SLACK_BOT_TOKEN: slackBotTokenSecret,
    },
  });
}
