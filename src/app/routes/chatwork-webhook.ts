import { Hono } from "hono";

import { verifyChatworkSignature } from "@/adapters/chatwork/verify-signature";
import { WebhookPayloadSchema } from "@/adapters/chatwork/webhook-schema";
import { toSlackChannelId } from "@/adapters/slack/types";
import type { AppDeps } from "@/app/server";
import { type ForwardMessageDeps, forwardMessage } from "@/app/services/forward-message";

/** Chatwork webhook 署名ヘッダ名（Chatwork が付与する固定ヘッダ）。 */
const SIGNATURE_HEADER = "X-ChatWorkWebhookSignature";

/** 本フェーズで処理する唯一のイベント種別（それ以外は no-op）。 */
const HANDLED_EVENT_TYPE = "message_created";

/**
 * Chatwork Webhook 受信ルートを生成する（REQ-001 / 設計 §4.6）。
 *
 * 処理順:
 * 1. 署名検証のため raw body（パース前のバイト列）を `arrayBuffer()` で取得する（CON-001）。
 * 2. `verifyChatworkSignature` で署名検証。失敗（欠落含む）は処理せず `401`（CON-002）。
 * 3. `JSON.parse` を try/catch で捕捉。壊れた JSON は本文を出さずログし `200`（再送ストーム回避）。
 * 4. `WebhookPayloadSchema.safeParse`。検証失敗は `200`（no-op）。
 * 5. `webhook_event_type` が `message_created` 以外は `200`（no-op）。
 * 6. それ以外は `forwardMessage` を呼び `200`。
 *
 * 公開エンドポイントの認可は署名検証のみで担保する（CON-002）。ログには本文・送信者名・
 * トークンを出さず、操作名・識別子のみを出す（NFR-003）。
 *
 * @param deps `AppDeps`（db / config / logger / adapters）。route の DI 元
 * @returns `/chatwork/webhook` を持つ Hono ルーター
 */
export function createChatworkWebhookRoute(deps: AppDeps): Hono {
  const route = new Hono();

  // forward-message の依存を AppDeps + config から構築する（テスト時は AppDeps をモックして差し替え）。
  const forwardDeps: ForwardMessageDeps = {
    db: deps.db,
    chatworkClient: deps.chatworkClient,
    slackClient: deps.slackClient,
    logger: deps.logger,
    defaultGroupChannelId: toSlackChannelId(deps.config.SLACK_DEFAULT_GROUP_CHANNEL_ID),
    defaultDmChannelId: toSlackChannelId(deps.config.SLACK_DEFAULT_DM_CHANNEL_ID),
  };

  route.post("/chatwork/webhook", async (c) => {
    // 署名検証前に raw body を取得する（c.req.json() を先に呼ぶと raw body を失う / CON-001）。
    const raw = Buffer.from(await c.req.arrayBuffer());
    const signature = c.req.header(SIGNATURE_HEADER) ?? "";

    if (!verifyChatworkSignature(raw, signature, deps.config.CHATWORK_WEBHOOK_TOKEN)) {
      deps.logger.warn({ op: "chatwork.webhook.verify" }, "signature mismatch");
      return c.json({ error: "unauthorized" }, 401);
    }

    // 署名通過後でも本文が壊れた JSON の可能性があるため検証境界として捕捉する（捕捉漏れの 500 を防ぐ）。
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      deps.logger.warn({ op: "chatwork.webhook.parse" }, "invalid json"); // 本文は出さない
      return c.json({ ok: true }, 200);
    }

    const parsed = WebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      deps.logger.warn({ op: "chatwork.webhook.parse" }, "invalid payload");
      return c.json({ ok: true }, 200); // 再送ストーム回避（不正は飲み込んで 200）
    }

    if (parsed.data.webhook_event_type !== HANDLED_EVENT_TYPE) {
      return c.json({ ok: true }, 200); // 対象外イベントは no-op
    }

    await forwardMessage(parsed.data.webhook_event, forwardDeps);
    return c.json({ ok: true }, 200);
  });

  return route;
}
