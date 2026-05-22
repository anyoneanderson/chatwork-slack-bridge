import { Hono } from "hono";
import { createChatworkWebhookRoute } from "@/app/routes/chatwork-webhook";
import { createHealthRoute } from "@/app/routes/health";
import type { AppDeps } from "@/app/server";

/**
 * アプリケーションルートを集約する。
 *
 * 公開エンドポイントは `/health` と `/chatwork/webhook` のみに留める（最小化 / NFR-001）。
 *
 * @param deps ルートで利用する依存
 * @returns 集約済み Hono ルーター
 */
export function createRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.route("/", createHealthRoute(deps));
  routes.route("/", createChatworkWebhookRoute(deps));

  return routes;
}
