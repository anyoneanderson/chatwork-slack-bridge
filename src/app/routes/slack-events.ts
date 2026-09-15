import { Hono } from "hono";

import { SlackEventEnvelopeSchema } from "@/adapters/slack/event-schema";
import { verifySlackSignature } from "@/adapters/slack/verify-signature";
import type { AppDeps } from "@/app/server";
import { type HandleSlackReplyDeps, handleSlackReply } from "@/app/services/handle-slack-reply";

/** `X-Slack-Request-Timestamp` ヘッダ名（リプレイ拒否のための送信時刻）。 */
const TIMESTAMP_HEADER = "X-Slack-Request-Timestamp";
/** `X-Slack-Signature` ヘッダ名（`v0=<hex>`）。 */
const SIGNATURE_HEADER = "X-Slack-Signature";

/**
 * Slack Events API 受信ルートを生成する（REQ-002 / 設計 §4.4）。
 *
 * 処理順:
 * 1. 署名検証のため raw body（パース前バイト列）を `arrayBuffer()` で取得する。
 * 2. `verifySlackSignature` で検証。失敗（欠落・リプレイ含む）は処理せず `401`（CON-002。署名前に
 *    DB/API に到達しない）。
 * 3. `JSON.parse` を try/catch。壊れた JSON は本文を出さずログし `200`（再送ストーム回避）。
 * 4. `SlackEventEnvelopeSchema.safeParse`。失敗は `200`（no-op）。
 * 5. `url_verification` は `challenge` をそのまま返す（Slack の初期登録）。
 * 6. `event_callback` & `event.type === "message"` は `handleSlackReply` を呼び `200`。それ以外は `200`。
 *
 * 公開エンドポイントの認可は署名検証のみで担保する（CON-002）。ログには本文・user 名・トークンを
 * 出さず、操作名・識別子のみを出す（NFR-002）。
 *
 * @param deps `AppDeps`（db / config / logger / adapters）
 * @returns `/slack/events` を持つ Hono ルーター
 */
export function createSlackEventsRoute(deps: AppDeps): Hono {
  const route = new Hono();

  // handle-slack-reply の依存を AppDeps から構築する（テスト時は AppDeps をモックして差し替え）。
  const handleDeps: HandleSlackReplyDeps = {
    db: deps.db,
    chatworkClient: deps.chatworkClient,
    slackClient: deps.slackClient,
    logger: deps.logger,
  };

  route.post("/slack/events", async (c) => {
    // 署名検証前に raw body を取得する（c.req.json() を先に呼ぶと raw body を失う）。
    const raw = Buffer.from(await c.req.arrayBuffer());
    const timestamp = c.req.header(TIMESTAMP_HEADER) ?? "";
    const signature = c.req.header(SIGNATURE_HEADER) ?? "";

    if (!verifySlackSignature(raw, timestamp, signature, deps.config.SLACK_SIGNING_SECRET)) {
      deps.logger.warn({ op: "slack.events.verify" }, "signature mismatch");
      return c.json({ error: "unauthorized" }, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      deps.logger.warn({ op: "slack.events.parse" }, "invalid json"); // 本文は出さない
      return c.json({ ok: true }, 200);
    }

    const parsed = SlackEventEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      deps.logger.warn({ op: "slack.events.parse" }, "invalid payload");
      return c.json({ ok: true }, 200); // 再送ストーム回避（不正は飲み込んで 200）
    }

    const envelope = parsed.data;
    if (envelope.type === "url_verification") {
      // Slack の初期登録チャレンジ。challenge をそのまま返す。
      return c.json({ challenge: envelope.challenge }, 200);
    }

    // event_callback。本フェーズは message イベントのみ処理する（スキーマで message に限定済み）。
    await handleSlackReply({ ...envelope.event, channel: envelope.event.channel }, handleDeps);
    return c.json({ ok: true }, 200);
  });

  return route;
}
