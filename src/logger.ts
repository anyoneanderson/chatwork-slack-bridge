import pino from "pino";

import type { Config } from "@/config/env";

export type LogLevel = Config["LOG_LEVEL"];
export type { Logger } from "pino";

/**
 * pino の構造化ロガーを生成する。
 *
 * @param level 出力する最小ログレベル
 * @returns 秘密情報を redact する pino Logger
 */
export function createLogger(level: LogLevel): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        "DATABASE_URL",
        "*.DATABASE_URL",
        "config.DATABASE_URL",
        "CHATWORK_WEBHOOK_TOKEN",
        "*.CHATWORK_WEBHOOK_TOKEN",
        "config.CHATWORK_WEBHOOK_TOKEN",
        "CHATWORK_API_TOKEN",
        "*.CHATWORK_API_TOKEN",
        "config.CHATWORK_API_TOKEN",
        "SLACK_BOT_TOKEN",
        "*.SLACK_BOT_TOKEN",
        "config.SLACK_BOT_TOKEN",
        "token",
        "*.token",
        "authorization",
        "*.authorization",
      ],
      censor: "[REDACTED]",
    },
  });
}
