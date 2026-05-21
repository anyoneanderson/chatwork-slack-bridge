import { Hono } from "hono";
import { createHealthRoute } from "@/app/routes/health";
import type { AppDeps } from "@/app/server";

/**
 * アプリケーションルートを集約する。
 *
 * @param deps ルートで利用する依存
 * @returns 集約済み Hono ルーター
 */
export function createRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.route("/", createHealthRoute(deps));

  return routes;
}
