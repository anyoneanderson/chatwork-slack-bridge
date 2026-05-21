import { Hono } from "hono";

import { createRoutes } from "@/app/routes/index";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

export interface AppDeps {
  db: DbClient;
  config: Config;
  logger: Logger;
}

/**
 * Hono アプリを生成し、共通エラーハンドラとルートを設定する。
 *
 * @param deps DB・設定・ロガーなどの依存
 * @returns Hono アプリ
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.route("/", createRoutes(deps));

  app.notFound((c) => {
    deps.logger.warn({ op: "http.not_found", method: c.req.method, path: c.req.path }, "not found");
    return c.json({ error: "not_found" }, 404);
  });

  app.onError((err, c) => {
    deps.logger.error(
      { op: "http.error", method: c.req.method, path: c.req.path, err: serializeError(err) },
      "unhandled error",
    );
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
