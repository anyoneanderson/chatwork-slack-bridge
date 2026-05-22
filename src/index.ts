import { serve } from "@hono/node-server";

import { createChatworkClient } from "@/adapters/chatwork/client";
import { createSecretProvider } from "@/adapters/secrets/factory";
import type { SecretProvider } from "@/adapters/secrets/types";
import { createSlackClient } from "@/adapters/slack/client";
import { createApp } from "@/app/server";
import { type Config, ConfigError, loadConfig } from "@/config/env";
import { createDbClient } from "@/db/client";
import { createLogger } from "@/logger";
import { serializeError } from "@/serialize-error";

/**
 * 起動シーケンス。
 *
 * secret provider のプリフェッチ（gcp backend では非同期）を最初に行い、
 * 設定を検証してから DB クライアント・HTTP サーバーを起動する。
 * secret 初期化失敗 / 設定検証失敗時は値を含まない構造化ログを出して終了する。
 *
 * @returns 起動処理の完了
 */
async function main(): Promise<void> {
  const bootstrapLogger = createLogger("info");

  let secretProvider: SecretProvider;
  try {
    // env backend は同期、gcp backend は Secret Manager から await でプリフェッチ。
    secretProvider = await createSecretProvider();
  } catch (err) {
    // SecretConfigError / SecretAccessError はキー名・キー区分のみ保持。値は含めない。
    bootstrapLogger.fatal({ op: "secret.init", err: serializeError(err) }, "secret init failed");
    process.exit(1);
  }

  let config: Config;
  try {
    config = loadConfig(secretProvider);
  } catch (err) {
    if (err instanceof ConfigError) {
      bootstrapLogger.fatal(
        { op: "config.load", issues: formatConfigIssues(err.issues) },
        "invalid config",
      );
    } else {
      bootstrapLogger.fatal({ op: "config.load", err: serializeError(err) }, "config load failed");
    }
    process.exit(1);
  }

  const logger = createLogger(config.LOG_LEVEL);
  const db = createDbClient(config.DATABASE_URL, { pooled: config.DB_POOLED });
  // 外部サービス client はアダプタ経由で生成し、トークンは secret adapter 由来の config から注入する。
  const chatworkClient = createChatworkClient({ apiToken: config.CHATWORK_API_TOKEN });
  const slackClient = createSlackClient({ botToken: config.SLACK_BOT_TOKEN });
  const app = createApp({ db, config, logger, chatworkClient, slackClient });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.PORT,
    },
    (info) => {
      logger.info({ op: "server.start", port: info.port }, "server started");
    },
  );

  /**
   * SIGTERM/SIGINT 時に DB 接続を閉じてから終了する。
   *
   * @param signal 受信した終了シグナル
   * @returns 終了処理の完了
   */
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    logger.info({ op: "server.shutdown", signal }, "shutdown started");

    try {
      await db.close();
      server.close(() => {
        logger.info({ op: "server.shutdown", signal }, "shutdown completed");
        process.exit(0);
      });
    } catch (err) {
      logger.error({ op: "server.shutdown", signal, err: serializeError(err) }, "shutdown failed");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

/**
 * pino redact が field 名そのものを伏せないよう、設定エラーを配列へ整形する。
 *
 * @param issues ConfigError が保持する fieldErrors
 * @returns キー名と理由のみの設定エラー一覧
 */
function formatConfigIssues(
  issues: ConfigError["issues"],
): Array<{ field: string; reasons: readonly string[] }> {
  return Object.entries(issues)
    .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
    .map(([field, reasons]) => ({ field, reasons }));
}

void main();
