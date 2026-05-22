import { Hono } from "hono";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { createRoutes } from "@/app/routes/index";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

/**
 * アプリ全体の依存。route / service へ DI し、テスト時にモック差し替え可能にする（NFR-004）。
 *
 * 外部サービス client（Chatwork / Slack）はアダプタ境界の型のみを公開し、実装（`@slack/web-api`
 * / `fetch`）は adapter 内に閉じる。
 */
export interface AppDeps {
  /** Drizzle DB クライアント。 */
  db: DbClient;
  /** 検証済み設定（トークン・チャンネル ID を含む）。 */
  config: Config;
  /** 構造化ロガー。 */
  logger: Logger;
  /** Chatwork API client（ルームメタ取得）。 */
  chatworkClient: ChatworkClient;
  /** Slack client（投稿）。 */
  slackClient: SlackClient;
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
