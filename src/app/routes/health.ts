import { Hono } from "hono";

import type { AppDeps } from "@/app/server";
import { serializeError } from "@/serialize-error";

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
