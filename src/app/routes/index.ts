import { Hono } from "hono";
import { createChatworkWebhookRoute } from "@/app/routes/chatwork-webhook";
import { createHealthRoute } from "@/app/routes/health";
import { createSlackEventsRoute } from "@/app/routes/slack-events";
import { createSlackInteractionsRoute } from "@/app/routes/slack-interactions";
import type { AppDeps } from "@/app/server";

/**
 * アプリケーションルートを集約する。
 *
 * 公開エンドポイントは `/health` / `/chatwork/webhook` / `/slack/events` / `/slack/interactions`
 * のみに留める（最小化 / NFR-001）。Slack 系 2 ルートの認可は署名検証のみで担保する（CON-002）。
 *
 * @param deps ルートで利用する依存
 * @returns 集約済み Hono ルーター
 */
export function createRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.route("/", createHealthRoute(deps));
  routes.route("/", createChatworkWebhookRoute(deps));
  routes.route("/", createSlackEventsRoute(deps));
  routes.route("/", createSlackInteractionsRoute(deps));

  return routes;
}
