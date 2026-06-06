import { and, eq } from "drizzle-orm";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { buildConfirmBlocks } from "@/adapters/slack/confirm-message";
import type { SlackMessageEvent } from "@/adapters/slack/event-schema";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import type { DbClient } from "@/db/client";
import { chatworkMessages, chatworkRooms, outboundMessages } from "@/db/schema";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

/**
 * `handleSlackReply` の依存。アダプタ・DB・ロガーを DI で注入し、テスト時にモック差し替え可能に
 * する（forward-message の DI 流儀 / coding-rules テスト戦略）。
 */
export interface HandleSlackReplyDeps {
  /** Drizzle DB クライアント。 */
  db: DbClient;
  /** Chatwork API client（本フェーズの検出・確認投稿では未使用だが DI 一貫性のため受け取る）。 */
  chatworkClient: ChatworkClient;
  /** Slack client（確認メッセージ投稿に使用）。 */
  slackClient: SlackClient;
  /** 構造化ロガー（識別子のみ。本文・user 名・トークンは出さない / NFR-002）。 */
  logger: Logger;
}

/** `handleSlackReply` の入力。検証済み `message` イベント本体に `channel`（必須）を確定して渡す。 */
export interface SlackReplyEvent extends SlackMessageEvent {
  /** 投稿チャンネル ID（スキーマ上必須）。 */
  channel: string;
}

/** 確認メッセージの text フォールバック（blocks 非対応クライアント用 / Slack 推奨）。 */
const CONFIRM_FALLBACK_TEXT = "この内容を Chatwork に送信しますか？";

/**
 * Slack のスレッド返信を検出し、逆引きで返信先 Chatwork ルームを決め、送信確認メッセージを投稿する
 * （REQ-002/003/004 / 設計 §4.4）。即時送信せず `outbound_messages` を `pending` で作成し、確認 UI を
 * 同一スレッドに投稿する（誤爆防止 / `[MUST]` 送信前確認）。
 *
 * 処理手順:
 * 1. 対象判定: `thread_ts` あり / `bot_id` なし / `subtype` なし / `user` あり / `text` trim 後 非空。
 *    いずれか外れたら no-op で return（bot 自己反応・派生イベント・空本文を除外 / REQ-003）。
 * 2. 逆引き: `chatwork_messages` を `slack_channel_id = channel AND slack_ts = thread_ts` で 1 件
 *    SELECT し `chatwork_room_id` / `id`（source）を得る。該当なしは bridge 管理外として no-op。
 * 3. `chatwork_rooms.enabled` を確認。disabled は送信を作らず no-op（`[SHOULD]`）。
 * 4. `outbound_messages` を `pending`（`slack_user_id = event.user` 含む）で `onConflictDoNothing`
 *    （冪等キー `(slack_channel_id, slack_reply_ts)`）で作成。空配列（既存=Events 再送）は no-op
 *    （二重作成しない / NFR-004）。
 * 5. 確認メッセージをスレッド（`thread_ts`）に `blocks` 付きで投稿し、確認 `ts` を得る。
 * 6. `outbound_messages.slack_confirm_ts` を更新（後で `chat.update` するため）。
 * 7. Slack 投稿失敗時は作成した `pending` 行を best-effort で削除し、ユーザーが再返信すれば再度
 *    確認フローに乗れるようにする（UI 無し pending 残留で詰まるのを防ぐ / 設計 §4.4）。delete 失敗も
 *    握ってログのみ。
 *
 * forward-message と同様 **例外を投げない**（ルートは 200 前提）。内部失敗は識別子のみログする
 * （本文・user 名は出さない / NFR-002）。
 *
 * @param event 検証済み `message` イベント本体 + `channel`
 * @param deps DB・アダプタ・ロガー
 * @returns 処理完了。判定外・逆引き不一致・disabled・再送・投稿失敗はいずれも内部でログして正常 return
 */
export async function handleSlackReply(
  event: SlackReplyEvent,
  deps: HandleSlackReplyDeps,
): Promise<void> {
  try {
    // 手順1: 対象判定。bot 自己反応・派生イベント・空本文を除外する（REQ-003）。
    const threadTs = event.thread_ts;
    const user = event.user;
    const text = event.text?.trim() ?? "";
    if (
      threadTs === undefined ||
      event.bot_id !== undefined ||
      event.subtype !== undefined ||
      user === undefined ||
      text.length === 0
    ) {
      return; // no-op（対象外）。ログは出さない（大量の非対象イベントでノイズになるため）。
    }

    const channel = event.channel;

    // 手順2: 逆引き。slack_channel_id = channel AND slack_ts = thread_ts で 1 件。
    const messageRows = await deps.db.db
      .select({
        sourceId: chatworkMessages.id,
        chatworkRoomId: chatworkMessages.chatworkRoomId,
      })
      .from(chatworkMessages)
      .where(
        and(eq(chatworkMessages.slackChannelId, channel), eq(chatworkMessages.slackTs, threadTs)),
      )
      .limit(1);

    const sourceRow = messageRows[0];
    if (sourceRow === undefined) {
      // bridge 管理外のスレッド（forwarding が投稿していない）。no-op。
      deps.logger.info(
        { op: "slack.reply.no_source", channel, threadTs },
        "skip: no source message",
      );
      return;
    }
    const roomId = sourceRow.chatworkRoomId;

    // 手順3: ルームの enabled を確認。disabled は送信を作らない（`[SHOULD]`）。
    const roomRows = await deps.db.db
      .select({ enabled: chatworkRooms.enabled })
      .from(chatworkRooms)
      .where(eq(chatworkRooms.chatworkRoomId, roomId))
      .limit(1);

    const roomRow = roomRows[0];
    if (roomRow === undefined || roomRow.enabled === false) {
      deps.logger.info(
        { op: "slack.reply.disabled", channel, threadTs, roomId },
        "skip: room disabled or missing",
      );
      return;
    }

    // 手順4: outbound を pending で作成（冪等）。slack_user_id に返信本人を記録する（認可用 / REQ-006/009）。
    const inserted = await deps.db.db
      .insert(outboundMessages)
      .values({
        chatworkRoomId: roomId,
        sourceChatworkMessageId: sourceRow.sourceId,
        slackChannelId: channel,
        slackThreadTs: threadTs,
        slackReplyTs: event.ts,
        slackUserId: user,
        body: text,
      })
      .onConflictDoNothing({
        target: [outboundMessages.slackChannelId, outboundMessages.slackReplyTs],
      })
      .returning({ id: outboundMessages.id });

    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      // 既存（Events 再送）。確認メッセージを二重作成しない（NFR-004）。
      deps.logger.info(
        { op: "slack.reply.dedup", channel, threadTs, replyTs: event.ts },
        "skip: duplicate reply",
      );
      return;
    }
    const outboundId = insertedRow.id;

    // 手順5: 確認メッセージをスレッドに投稿（blocks 付き）。失敗時は手順7 で pending を片付ける。
    let confirmTs: ReturnType<typeof toSlackTs>;
    try {
      const result = await deps.slackClient.postMessage(
        toSlackChannelId(channel),
        {
          text: CONFIRM_FALLBACK_TEXT,
          blocks: buildConfirmBlocks({ quotedBody: text, outboundId: String(outboundId) }),
        },
        { threadTs: toSlackTs(threadTs) },
      );
      confirmTs = result.ts;
    } catch (err) {
      // 投稿失敗。作成した pending を best-effort で削除して詰まりを防ぐ（再返信で再フロー可能）。
      deps.logger.error(
        { op: "slack.reply.confirm_post", channel, threadTs, outboundId, err: serializeError(err) },
        "confirm post failed; cleaning up pending",
      );
      await deletePending(outboundId, channel, threadTs, deps);
      return;
    }

    // 手順6: 確認メッセージの ts を記録（後の chat.update 対象）。
    await deps.db.db
      .update(outboundMessages)
      .set({ slackConfirmTs: confirmTs, updatedAt: new Date() })
      .where(eq(outboundMessages.id, outboundId));

    deps.logger.info(
      { op: "slack.reply.confirm", channel, threadTs, outboundId, confirmTs },
      "confirm posted",
    );
  } catch (err) {
    // never-throw: 予期せぬ例外も握ってログのみ（ルートは 200 前提 / 本文・user 名は出さない）。
    deps.logger.error(
      { op: "slack.reply.unexpected", channel: event.channel, err: serializeError(err) },
      "handleSlackReply threw unexpectedly; ignoring",
    );
  }
}

/**
 * 確認投稿失敗時に作成済みの pending 行を best-effort で削除する。
 *
 * delete 自体が失敗しても握ってログのみ（never-throw の補助。詰まり防止の best-effort）。
 *
 * @param outboundId 削除対象の outbound id
 * @param channel ログ用チャンネル ID
 * @param threadTs ログ用スレッド ts
 * @param deps DB・ロガー
 * @returns 完了（失敗してもログのみで return）
 */
async function deletePending(
  outboundId: bigint,
  channel: string,
  threadTs: string,
  deps: HandleSlackReplyDeps,
): Promise<void> {
  try {
    await deps.db.db.delete(outboundMessages).where(eq(outboundMessages.id, outboundId));
  } catch (err) {
    deps.logger.error(
      { op: "slack.reply.cleanup", channel, threadTs, outboundId, err: serializeError(err) },
      "failed to delete pending after confirm post failure",
    );
  }
}
