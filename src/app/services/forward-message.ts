import { eq } from "drizzle-orm";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import { toChatworkRoomId } from "@/adapters/chatwork/types";
import type { WebhookPayload } from "@/adapters/chatwork/webhook-schema";
import type { SlackClient } from "@/adapters/slack/client";
import { format } from "@/adapters/slack/format";
import { type SlackChannelId, toSlackChannelId } from "@/adapters/slack/types";
import { type ResolveTargetDeps, resolveTarget } from "@/app/services/resolve-target";
import type { DbClient } from "@/db/client";
import { chatworkMessages, chatworkRooms, type RoomType } from "@/db/schema";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

/** `message_created` の `webhook_event` 本体（送信者 ID は `account_id`）。 */
type WebhookEvent = WebhookPayload["webhook_event"];

/**
 * `forwardMessage` の依存。アダプタ・DB・ロガー・フォールバックチャンネルを DI で注入し、
 * テスト時にモック差し替え可能にする（NFR-004 / coding-rules テスト戦略）。
 */
export interface ForwardMessageDeps extends ResolveTargetDeps {
  /** Drizzle DB クライアント。 */
  db: DbClient;
  /** Chatwork API client（初見ルームのメタ取得に使用）。 */
  chatworkClient: ChatworkClient;
  /** Slack client（投稿に使用）。 */
  slackClient: SlackClient;
  /** 構造化ロガー（識別子のみ。本文・送信者名・トークンは出さない）。 */
  logger: Logger;
}

/** ルーム解決済みの最小ビュー（メッセージ保存・ルーティングに必要なフィールドのみ）。 */
interface ResolvedRoom {
  chatworkRoomId: string;
  roomType: RoomType;
  enabled: boolean;
  // resolveTarget へそのまま渡せるよう、null はそのまま・値はブランド化して保持する（DRY）。
  slackChannelId: SlackChannelId | null;
  roomName: string;
}

/**
 * Chatwork の `message_created` を受け、保存・ルーティング・Slack 投稿をオーケストレーションする
 * （REQ-005/006/008 / 設計 §4.5）。冪等性（NFR-006）・整合性方針（NFR-005）を担保する。
 *
 * 処理手順:
 * 1. ルーム解決を先に行う。`chatwork_rooms` を `room_id` で検索し、無ければ `chatworkClient.getRoom`
 *    でメタを取得して `enabled=true` / `slack_channel_id=null` で upsert し、upsert 後に DB から
 *    確定行を読み直す（FK 親行・種別を先に確定。`my` skip とルーティングはこの権威ある DB 行で判定）。
 *    初見ルームで `getRoom` が失敗した場合は親行を作れず FK を満たせないため、メッセージを保存せず
 *    構造化ログ（識別子のみ）を残して return する（Chatwork の再送に委ねる）。既知ルームはキャッシュを
 *    使い `getRoom` を呼ばないため、この失敗の影響を受けない。
 * 2. `room_type = my` なら保存も投稿もせず return（CON-003）。メタ行は手順1でキャッシュ済みのため
 *    再受信時は `getRoom` を呼ばず即 skip できる。
 * 3. `chatwork_messages` に `onConflictDoNothing` で INSERT し `returning` で挿入有無を判定する
 *    （親ルーム行があり FK を満たす）。既存（再送）なら空配列が返るので return（二重投稿しない）。
 * 4. `resolveTarget` で投稿先を決定。`disabled`（skip）なら保存のみで return。
 * 5. `post` なら `slackClient.postMessage` を呼び、戻り `ts` で `chatwork_messages` を UPDATE する。
 *
 * 整合性方針（NFR-005）: メッセージ INSERT（手順3）は Slack 投稿（手順5）より先にコミットされ、
 * Slack 投稿は外部呼び出しのため DB トランザクション外で行う。Slack 投稿が失敗してもメッセージは
 * DB に残り（`slack_ts` は null）、ops-safety フェーズの queue/リトライで再投稿できる。これは
 * 「getRoom 失敗で保存しない」ケース（FK を満たせない）とは区別される。
 * なお Slack 投稿は成功したが直後の `ts` UPDATE が失敗した場合は `slack_ts` が null のまま残るが、
 * これは「未投稿」ではなく「投稿済み・ts 未記録」である。`op: "forward.slack.ts_update"` の専用
 * ログで区別できるようにしており、ops-safety フェーズの再試行は **既に Slack へ投稿済み**として
 * 扱う必要がある（同じ内容を再投稿しない）。
 *
 * すべての失敗は内部で握り、本関数は例外を送出しない（ルートは常に 200 を返す前提。webhook 再送
 * ストーム回避）。
 *
 * @param event 検証済みの `message_created` イベント本体（`webhook_event`）
 * @param deps DB・アダプタ・ロガー・フォールバックチャンネル
 * @returns 処理完了。getRoom 失敗・重複・skip・Slack 失敗・ts UPDATE 失敗はいずれも内部でログして
 *   正常 return する（例外は投げない）
 */
export async function forwardMessage(event: WebhookEvent, deps: ForwardMessageDeps): Promise<void> {
  const roomId = String(event.room_id);
  const messageId = event.message_id;

  // 手順1: ルーム解決（FK 親行・種別を先に確定）。getRoom 失敗時は保存せず return。
  const room = await resolveRoom(roomId, deps);
  if (room === null) {
    // 初見ルームで getRoom 失敗。FK を満たせないため保存しない（識別子のみログ・本文非出力）。
    deps.logger.warn(
      { op: "forward.room.unresolved", roomId, messageId },
      "skip: room metadata unavailable",
    );
    return;
  }

  // 手順2: my ルームは保存も投稿もせず終了（CON-003）。メタ行はキャッシュ済み。
  if (room.roomType === "my") {
    deps.logger.info({ op: "forward.skip.mychat", roomId, messageId }, "skip: my room");
    return;
  }

  // 手順3: メッセージ保存（冪等）。親ルーム行があり FK を満たす。
  const inserted = await deps.db.db
    .insert(chatworkMessages)
    .values({
      chatworkRoomId: roomId,
      chatworkMessageId: messageId,
      chatworkAccountId: String(event.account_id),
      // payload に送信者名は無い。Phase 3 は null（ASM-002 / REQ-005）。
      senderName: null,
      body: event.body,
      // send_time は epoch 秒。timestamptz 列へ Date に変換して保存する。
      sentAt: new Date(event.send_time * 1000),
      rawPayload: event,
    })
    .onConflictDoNothing({
      target: [chatworkMessages.chatworkRoomId, chatworkMessages.chatworkMessageId],
    })
    .returning({ id: chatworkMessages.id });

  const insertedRow = inserted[0];
  if (insertedRow === undefined) {
    // 既存（webhook 再送）。二重保存・二重投稿しない（NFR-006）。
    deps.logger.info({ op: "forward.dedup", roomId, messageId }, "skip: duplicate message");
    return;
  }
  const messageRowId = insertedRow.id;

  // 手順4: ルーティング判定。disabled は保存のみで終了。room は権威ある DB 行のため
  // slackChannelId はそのまま渡せる（resolveTarget が受け取る SlackChannelId | null）。
  const target = resolveTarget(
    {
      roomType: room.roomType,
      enabled: room.enabled,
      slackChannelId: room.slackChannelId,
    },
    deps,
  );
  if (target.kind === "skip") {
    deps.logger.info(
      { op: "forward.skip", roomId, messageId, reason: target.reason },
      "skip: not forwarded",
    );
    return;
  }

  // 手順5: Slack 投稿（DB トランザクション外）。失敗してもメッセージは保存済みで残る（NFR-005）。
  const channelId = target.channelId;
  let ts: string;
  try {
    const result = await deps.slackClient.postMessage(
      channelId,
      format({ accountId: String(event.account_id), body: event.body }, { name: room.roomName }),
    );
    ts = result.ts;
  } catch (err) {
    // 投稿失敗。保存は維持し（slack_ts=null）、識別子のみログ。リトライは ops-safety。
    deps.logger.error(
      { op: "forward.slack.post", roomId, messageId, channelId, err: serializeError(err) },
      "slack post failed; message kept for retry",
    );
    return;
  }

  // 投稿成功 → 該当メッセージ行に slack_channel_id / slack_ts を反映する。
  // UPDATE が失敗すると行は slack_ts=null のまま残るが、これは「未投稿」ではなく「投稿済み・ts 未記録」。
  // 専用 op でログし、ops-safety の再試行が **既に Slack 投稿済み**として扱えるようにする（再投稿防止）。
  // 例外は再送出しない（ルートは 200 を返す前提）。
  try {
    await deps.db.db
      .update(chatworkMessages)
      .set({ slackChannelId: channelId, slackTs: ts, updatedAt: new Date() })
      .where(eq(chatworkMessages.id, messageRowId));
  } catch (err) {
    deps.logger.error(
      {
        op: "forward.slack.ts_update",
        roomId,
        messageId,
        channelId,
        slackTs: ts,
        err: serializeError(err),
      },
      "posted to slack but failed to persist ts; ops-safety must treat as already posted",
    );
    return;
  }

  deps.logger.info(
    { op: "forward.posted", roomId, messageId, channelId, slackTs: ts },
    "forwarded to slack",
  );
}

/**
 * ルームを `chatwork_room_id` で 1 行 SELECT し、`ResolvedRoom` にマッピングする。
 *
 * @param roomId 文字列化したルーム ID
 * @param deps DB クライアント
 * @returns 解決済みルーム。行が存在しなければ `null`
 */
async function selectRoom(roomId: string, deps: ForwardMessageDeps): Promise<ResolvedRoom | null> {
  const rows = await deps.db.db
    .select({
      chatworkRoomId: chatworkRooms.chatworkRoomId,
      roomType: chatworkRooms.roomType,
      enabled: chatworkRooms.enabled,
      slackChannelId: chatworkRooms.slackChannelId,
      roomName: chatworkRooms.roomName,
    })
    .from(chatworkRooms)
    .where(eq(chatworkRooms.chatworkRoomId, roomId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    chatworkRoomId: row.chatworkRoomId,
    roomType: row.roomType as RoomType,
    enabled: row.enabled,
    // DB の slack_channel_id（null は種別集約フォールバック）。値はブランド化して保持する。
    slackChannelId: row.slackChannelId === null ? null : toSlackChannelId(row.slackChannelId),
    roomName: row.roomName,
  };
}

/**
 * ルームを解決する。DB キャッシュにあればそれを返し、初見なら `getRoom` で取得して upsert したうえで
 * **DB から確定行を読み直して返す**（設計 §4.5 手順1 / 2）。
 *
 * 返す行は常に DB の権威ある行であり、`my` skip 判定とルーティング（`enabled` / `slack_channel_id`）は
 * この行で行う。初回 SELECT と upsert の間に別プロセス／運用者が同じルームを `disabled` や紐付け済み
 * （`slack_channel_id` 設定）として作成していた場合でも、getRoom 由来の in-memory 値（`enabled=true` /
 * `channel=null`）で上書きせず、実際の DB 設定に従う（誤って集約チャンネルへ投稿しない）。
 *
 * 初見ルームで `getRoom` が失敗した場合は親 `chatwork_rooms` 行を作れず FK を満たせないため、`null` を
 * 返して呼び出し側に「保存しない」ことを伝える。既知ルームはキャッシュを使い `getRoom` を呼ばないため、
 * この失敗の影響を受けない。upsert 直後の再 SELECT が（通常起こり得ないが）行を返さなかった場合も、
 * 安全側に倒して `null`（保存しない）とし、ログを残す。
 *
 * @param roomId 文字列化したルーム ID
 * @param deps DB・Chatwork client・ロガー
 * @returns DB の権威ある解決済みルーム。初見で取得失敗・再 SELECT 不能の場合は `null`
 */
async function resolveRoom(roomId: string, deps: ForwardMessageDeps): Promise<ResolvedRoom | null> {
  // 既知ルームは DB キャッシュをそのまま使う（getRoom を呼ばない）。
  const cached = await selectRoom(roomId, deps);
  if (cached !== null) return cached;

  // 初見ルーム: Chatwork API でメタを取得する。失敗時は保存不能のため null を返す。
  let meta: Awaited<ReturnType<ChatworkClient["getRoom"]>>;
  try {
    meta = await deps.chatworkClient.getRoom(toChatworkRoomId(roomId));
  } catch (err) {
    deps.logger.error(
      {
        op: "forward.getRoom",
        roomId,
        // ChatworkApiError は識別子・ステータスのみ保持（本文・トークン非含有）。
        status: err instanceof ChatworkApiError ? err.status : undefined,
        err: serializeError(err),
      },
      "getRoom failed; message not saved",
    );
    return null;
  }

  // FK 親行を確定するため、メッセージ INSERT より前に rooms を upsert する（enabled=true / channel=null）。
  // 競合（同一ルームの並行初見、または運用者による先行作成）は onConflictDoNothing で吸収し、
  // getRoom 由来の値で既存行を上書きしない。
  await deps.db.db
    .insert(chatworkRooms)
    .values({
      chatworkRoomId: roomId,
      roomName: meta.name,
      roomType: meta.type,
      slackChannelId: null,
      enabled: true,
    })
    .onConflictDoNothing({ target: chatworkRooms.chatworkRoomId });

  // upsert 後に DB の確定行を読み直す。これにより、競合で先に作られた行（disabled / 紐付け済み）が
  // あればその実設定に従い、in-memory の getRoom 値で誤ルーティングしない。
  const resolved = await selectRoom(roomId, deps);
  if (resolved === null) {
    // upsert が存在を保証するため通常起こり得ないが、安全側に倒して保存しない。
    deps.logger.error(
      { op: "forward.room.reselect_missing", roomId },
      "room row missing after upsert; message not saved",
    );
    return null;
  }
  return resolved;
}
