import { Hono } from "hono";

import { SLACK_ACTION_CANCEL, SLACK_ACTION_SEND } from "@/adapters/slack/confirm-message";
import { BlockActionsSchema } from "@/adapters/slack/event-schema";
import { verifySlackSignature } from "@/adapters/slack/verify-signature";
import type { AppDeps } from "@/app/server";
import { cancelOutbound, type SendOutboundDeps, sendOutbound } from "@/app/services/send-outbound";

/** `X-Slack-Request-Timestamp` ヘッダ名（リプレイ拒否のための送信時刻）。 */
const TIMESTAMP_HEADER = "X-Slack-Request-Timestamp";
/** `X-Slack-Signature` ヘッダ名（`v0=<hex>`）。 */
const SIGNATURE_HEADER = "X-Slack-Signature";

/**
 * `SLACK_ALLOWED_REPLY_USER_IDS`（カンマ区切り任意）をパースして配列にする。
 *
 * 未設定（undefined）・空文字は空配列（= 本人のみ許可 / REQ-009）。前後空白を除去し空要素を落とす。
 *
 * @param value `config.SLACK_ALLOWED_REPLY_USER_IDS`
 * @returns trim 済みの Slack user id 配列
 */
function parseAllowedReplyUserIds(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Slack Interactivity（Block Kit ボタン）受信ルートを生成する（REQ-006 / 設計 §4.5）。
 *
 * 処理順:
 * 1. 署名検証のため raw body を取得し `verifySlackSignature` で検証。失敗は `401`（CON-002。署名前に
 *    DB/API に到達しない）。
 * 2. raw を `application/x-www-form-urlencoded` として `URLSearchParams` で解析し `payload` を取り出す。
 *    無ければ `200`。`JSON.parse` を try/catch（失敗は `200`）→ `BlockActionsSchema.safeParse`（失敗は
 *    `200`）。
 * 3. `actions[0].action_id` で分岐: `cw_send` → `sendOutbound` / `cw_cancel` → `cancelOutbound` /
 *    未知 → `200`。`value` 欠落時は `200` no-op。
 * 4. `200` を返す。
 *
 * 公開エンドポイントの認可は署名検証のみで担保する（CON-002）。ログには本文・user 名・トークンを
 * 出さず、操作名・識別子のみを出す（NFR-002）。
 *
 * @param deps `AppDeps`（db / config / logger / adapters）
 * @returns `/slack/interactions` を持つ Hono ルーター
 */
export function createSlackInteractionsRoute(deps: AppDeps): Hono {
  const route = new Hono();

  // send-outbound の依存を AppDeps + config から構築する（allowlist は config をパース）。
  const sendDeps: SendOutboundDeps = {
    db: deps.db,
    chatworkClient: deps.chatworkClient,
    slackClient: deps.slackClient,
    logger: deps.logger,
    allowedReplyUserIds: parseAllowedReplyUserIds(deps.config.SLACK_ALLOWED_REPLY_USER_IDS),
  };

  route.post("/slack/interactions", async (c) => {
    // 署名検証前に raw body を取得する。
    const raw = Buffer.from(await c.req.arrayBuffer());
    const timestamp = c.req.header(TIMESTAMP_HEADER) ?? "";
    const signature = c.req.header(SIGNATURE_HEADER) ?? "";

    if (!verifySlackSignature(raw, timestamp, signature, deps.config.SLACK_SIGNING_SECRET)) {
      deps.logger.warn({ op: "slack.interactions.verify" }, "signature mismatch");
      return c.json({ error: "unauthorized" }, 401);
    }

    // interactions は form-urlencoded の `payload` フィールドに JSON 文字列が入る（ASM-002）。
    const payloadRaw = new URLSearchParams(raw.toString("utf8")).get("payload");
    if (payloadRaw === null) {
      deps.logger.warn({ op: "slack.interactions.parse" }, "missing payload");
      return c.json({ ok: true }, 200);
    }

    let json: unknown;
    try {
      json = JSON.parse(payloadRaw);
    } catch {
      deps.logger.warn({ op: "slack.interactions.parse" }, "invalid json"); // 本文は出さない
      return c.json({ ok: true }, 200);
    }

    const parsed = BlockActionsSchema.safeParse(json);
    if (!parsed.success) {
      deps.logger.warn({ op: "slack.interactions.parse" }, "invalid payload");
      return c.json({ ok: true }, 200);
    }

    // スキーマ上 actions は min(1) だが、TS は配列要素を undefined 可能とみなすため明示的に確認する。
    const action = parsed.data.actions[0];
    if (action === undefined) {
      return c.json({ ok: true }, 200);
    }
    const pressUserId = parsed.data.user.id;
    if (action.value === undefined) {
      deps.logger.warn({ op: "slack.interactions.no_value" }, "skip: action without value");
      return c.json({ ok: true }, 200);
    }

    if (action.action_id === SLACK_ACTION_SEND) {
      await sendOutbound({ outboundId: action.value, pressUserId }, sendDeps);
    } else if (action.action_id === SLACK_ACTION_CANCEL) {
      await cancelOutbound({ outboundId: action.value, pressUserId }, sendDeps);
    }
    // 未知 action_id は no-op（200）。

    return c.json({ ok: true }, 200);
  });

  return route;
}
