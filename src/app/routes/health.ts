import { Hono } from "hono";

import type { AppDeps } from "@/app/server";

/**
 * /health ルートを生成する。
 *
 * @param deps DB・設定・ロガーなどの依存
 * @returns health ルーター
 */
export function createHealthRoute(deps: AppDeps): Hono {
  const route = new Hono();

  route.get("/health", async (c) => {
    try {
      await deps.db.ping(deps.config.DB_HEALTH_TIMEOUT_MS);
      return c.json({ status: "ok", db: "ok" }, 200);
    } catch (err) {
      deps.logger.error({ op: "health.db_ping", err: serializeError(err) }, "db ping failed");
      return c.json({ status: "error", db: "down" }, 503);
    }
  });

  return route;
}

/**
 * health 失敗ログに必要な範囲だけを抽出する。
 *
 * @param err 捕捉したエラー
 * @returns 接続文字列を含めないエラー情報
 */
function serializeError(err: unknown): { name: string; message: string; op?: string } {
  if (err instanceof Error) {
    const serialized = { name: err.name, message: err.message };

    if ("op" in err && typeof err.op === "string") {
      return { ...serialized, op: err.op };
    }

    return serialized;
  }

  return { name: "UnknownError", message: "unknown error" };
}
