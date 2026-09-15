import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { GoogleChatPollRuntime } from "@/app/services/google-chat-poll-runtime";
import type { Logger } from "@/logger";

const EmptyPayloadSchema = z.object({}).strict();

/**
 * @param deps 外部取得専用の制御・認証秘密・安全なロガー
 * @returns 認証後に固定された接続を取得し、完了を待つルーター
 * @throws なし。外部入力と実行失敗は固定の HTTP 応答へ変換する
 */
export function createGoogleChatPollRoute(deps: {
  runtime: GoogleChatPollRuntime;
  token: string;
  logger: Logger;
}): Hono {
  const routes = new Hono();
  const expected = createHash("sha256").update(deps.token).digest();
  routes.post(
    "/internal/poll-google-chat",
    async (c, next) => {
      const authorization = c.req.header("authorization") ?? "";
      const parsed = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
      if (!parsed?.[1] || parsed[1].length > 256) return c.json({ error: "unauthorized" }, 401);
      const supplied = createHash("sha256").update(parsed[1]).digest();
      if (!timingSafeEqual(expected, supplied)) return c.json({ error: "unauthorized" }, 401);
      await next();
    },
    bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "invalid_request" }, 400) }),
    async (c) => {
      try {
        const body = await c.req.text();
        let payload: unknown = {};
        try {
          if (body !== "") payload = JSON.parse(body);
        } catch {
          return c.json({ error: "invalid_request" }, 400);
        }
        if (!EmptyPayloadSchema.safeParse(payload).success || new URL(c.req.url).search !== "")
          return c.json({ error: "invalid_request" }, 400);
        const result = await deps.runtime.run();
        if (result === "completed" || result === "interrupted") {
          return c.json({ ok: true, complete: result === "completed" });
        }
        return c.json({ error: "poll_unavailable" }, 503);
      } catch {
        deps.logger.error({ op: "google_chat.poll_http" }, "Google Chat polling request failed");
        return c.json({ error: "poll_unavailable" }, 503);
      }
    },
  );
  return routes;
}
