import { Hono } from "hono";
import { createChatworkWebhookRoute } from "@/app/routes/chatwork-webhook";
import { createGoogleChatPollRoute } from "@/app/routes/google-chat-poll";
import { createHealthRoute } from "@/app/routes/health";
import { createSlackEventsRoute } from "@/app/routes/slack-events";
import { createSlackInteractionsRoute } from "@/app/routes/slack-interactions";
import type { AppDeps } from "@/app/server";

/**
 * アプリケーションルートを集約する。
 *
 * Webhook は署名認証し、外部取得モードでは専用トークン認証の取得先を追加する。
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

  if (deps.googleChatBridge && deps.googleChatPoll) {
    routes.route("/", createGoogleChatPollRoute({ ...deps.googleChatPoll, logger: deps.logger }));
  }

  return routes;
}
