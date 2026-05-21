import { z } from "zod";

import type { SecretProvider } from "@/adapters/secrets/types";

export const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DB_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
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
  });

  if (!result.success) {
    throw new ConfigError(result.error.flatten().fieldErrors);
  }

  return result.data;
}
