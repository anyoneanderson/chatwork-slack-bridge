import { z } from "zod";

import type { SecretProvider } from "@/adapters/secrets/types";

export const ConfigSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DB_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    /** secret 取得バックエンド。env（既定）はローカル/compose、gcp は Secret Manager。 */
    SECRET_BACKEND: z.enum(["env", "gcp"]).default("env"),
    /** GCP プロジェクト ID。SECRET_BACKEND=gcp のとき必須（refine で担保）。 */
    GOOGLE_CLOUD_PROJECT: z.string().optional(),
    /** DATABASE_URL を格納する Secret Manager のシークレット名。gcp のとき必須。 */
    DATABASE_URL_SECRET: z.string().optional(),
    /**
     * Neon pooled connection 利用時に true。postgres.js の prepare:false を有効化する。
     * 環境変数は文字列のため厳密判定する（`z.coerce.boolean()` は "false" も true 化するため不可）。
     * 既定は未設定 → false。"true"/"1" のみ true。
     */
    DB_POOLED: z
      .enum(["true", "false", "1", "0"])
      .default("false")
      .transform((v) => v === "true" || v === "1"),
    /** Chatwork Webhook 署名検証用トークン（base64）。secret adapter 経由で取得する。 */
    CHATWORK_WEBHOOK_TOKEN: z.string().min(1),
    /** Chatwork API（`GET /rooms`）用トークン。secret adapter 経由で取得する。 */
    CHATWORK_API_TOKEN: z.string().min(1),
    /** Slack 投稿用 Bot トークン。secret adapter 経由で取得する。 */
    SLACK_BOT_TOKEN: z.string().min(1),
    /** Slack request 署名検証用シークレット。secret adapter 経由で取得する。 */
    SLACK_SIGNING_SECRET: z.string().min(1),
    /** カンマ区切りの Slack user ID。送信操作の allowlist。未設定=本人のみ許可。 */
    SLACK_ALLOWED_REPLY_USER_IDS: z.string().optional(),
    /** group 種別の集約フォールバック Slack チャンネル ID（秘密ではなく設定値）。 */
    SLACK_DEFAULT_GROUP_CHANNEL_ID: z.string().min(1),
    /** direct 種別の集約フォールバック Slack チャンネル ID（秘密ではなく設定値）。 */
    SLACK_DEFAULT_DM_CHANNEL_ID: z.string().min(1),
  })
  .superRefine((config, ctx) => {
    if (config.SECRET_BACKEND !== "gcp") {
      return;
    }
    // gcp backend では Secret Manager 参照情報が必須。値ではなくキーの有無のみを検証する。
    if (!config.GOOGLE_CLOUD_PROJECT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_CLOUD_PROJECT"],
        message: "Required when SECRET_BACKEND=gcp",
      });
    }
    if (!config.DATABASE_URL_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL_SECRET"],
        message: "Required when SECRET_BACKEND=gcp",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigIssues = z.inferFlattenedErrors<typeof ConfigSchema>["fieldErrors"];

/** 設定検証失敗を表す。値そのものを持たず、キー名と理由だけを保持する。 */
export class ConfigError extends Error {
  public readonly issues: ConfigIssues;

  /**
   * 検証失敗の理由を保持する。
   *
   * @param issues Zod flatten の fieldErrors。秘密値は含めない
   * @returns ConfigError インスタンス
   */
  constructor(issues: ConfigIssues) {
    super("Invalid configuration");
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * SecretProvider から設定を読み込み、Zod で検証済みの Config を返す。
 *
 * @param secrets 秘密情報・設定値の取得元
 * @returns 検証済み設定
 * @throws ConfigError 検証に失敗した場合。キー名と理由のみを保持し、値は含めない
 */
export function loadConfig(secrets: SecretProvider): Config {
  const result = ConfigSchema.safeParse({
    DATABASE_URL: secrets.get("DATABASE_URL"),
    PORT: secrets.get("PORT"),
    LOG_LEVEL: secrets.get("LOG_LEVEL"),
    NODE_ENV: secrets.get("NODE_ENV"),
    DB_HEALTH_TIMEOUT_MS: secrets.get("DB_HEALTH_TIMEOUT_MS"),
    SECRET_BACKEND: secrets.get("SECRET_BACKEND"),
    GOOGLE_CLOUD_PROJECT: secrets.get("GOOGLE_CLOUD_PROJECT"),
    DATABASE_URL_SECRET: secrets.get("DATABASE_URL_SECRET"),
    DB_POOLED: secrets.get("DB_POOLED"),
    CHATWORK_WEBHOOK_TOKEN: secrets.get("CHATWORK_WEBHOOK_TOKEN"),
    CHATWORK_API_TOKEN: secrets.get("CHATWORK_API_TOKEN"),
    SLACK_BOT_TOKEN: secrets.get("SLACK_BOT_TOKEN"),
    SLACK_SIGNING_SECRET: secrets.get("SLACK_SIGNING_SECRET"),
    SLACK_ALLOWED_REPLY_USER_IDS: secrets.get("SLACK_ALLOWED_REPLY_USER_IDS"),
    SLACK_DEFAULT_GROUP_CHANNEL_ID: secrets.get("SLACK_DEFAULT_GROUP_CHANNEL_ID"),
    SLACK_DEFAULT_DM_CHANNEL_ID: secrets.get("SLACK_DEFAULT_DM_CHANNEL_ID"),
  });

  if (!result.success) {
    throw new ConfigError(result.error.flatten().fieldErrors);
  }

  return result.data;
}
