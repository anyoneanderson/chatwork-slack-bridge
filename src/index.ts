import { serve } from "@hono/node-server";

import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";
import { createApp } from "@/app/server";
import { ConfigError, loadConfig } from "@/config/env";
import { createDbClient } from "@/db/client";
import { createLogger } from "@/logger";
import { serializeError } from "@/serialize-error";

const bootstrapLogger = createLogger("info");
const secretProvider = new EnvSecretProvider();

let config: ReturnType<typeof loadConfig>;
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
const db = createDbClient(config.DATABASE_URL);
const app = createApp({ db, config, logger });

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
