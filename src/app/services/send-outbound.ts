import { and, eq } from "drizzle-orm";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import { toChatworkRoomId } from "@/adapters/chatwork/types";
import type { SlackClient } from "@/adapters/slack/client";
import { buildResultMessage } from "@/adapters/slack/confirm-message";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import type { DbClient } from "@/db/client";
import { deliveryAttempts, outboundMessages } from "@/db/schema";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

/**
 * `sendOutbound` / `cancelOutbound` の依存。アダプタ・DB・ロガー・allowlist を DI で注入する。
 */
export interface SendOutboundDeps {
  /** Drizzle DB クライアント。 */
  db: DbClient;
  /** Chatwork API client（メッセージ投稿に使用）。 */
  chatworkClient: ChatworkClient;
  /** Slack client（確認メッセージの結果更新に使用）。 */
  slackClient: SlackClient;
  /** 構造化ロガー（識別子のみ。本文・user 名・トークンは出さない / NFR-002）。 */
  logger: Logger;
  /** 任意の allowlist（空 = 本人のみ許可 / REQ-009）。 */
  allowedReplyUserIds: readonly string[];
}

/** ボタン押下（送信/キャンセル）の入力。`outboundId` は payload の value、`pressUserId` は押下者。 */
export interface OutboundActionInput {
  /** 対象 `outbound_messages.id`（payload の `value`）。 */
  outboundId: string;
  /** ボタンを押した Slack user id（認可に使う）。 */
  pressUserId: string;
}

/** 対象 outbound 行のうち認可・更新に必要な最小ビュー。 */
interface OutboundRow {
  id: bigint;
  status: string;
  slackChannelId: string;
  slackConfirmTs: string | null;
  slackUserId: string | null;
}

/**
 * 確認メッセージ（［送信］ボタン）押下を処理し、claim → Chatwork 投稿 → 結果記録 → 確認更新を行う
 * （REQ-006/009 / NFR-004/005 / 設計 §4.5）。
 *
 * 処理手順:
 * 1. 対象 SELECT（id で 1 件）。無ければ no-op で return。
 * 2. 認可: 押下者 == `slack_user_id`（返信本人）OR allowlist（非空時に含む）。不一致は共有確認
 *    メッセージを更新せず（chat.update も outbound も触らない）、識別子のみログして return する。
 *    確認メッセージはスレッド共有のため、未認可押下で更新すると他人の UI 破壊・結果上書きが起きる
 *    （DoS / 監査破壊 / 状態競合 / REQ-006/009）。
 * 　 これにより chat.update は「認可済みかつ状態遷移成功後（sent/failed/cancelled）」のみに限定される。
 * 3. claim: `status='pending'` のみを `sending` に条件付き UPDATE + `returning`。0 行は既に
 *    sending/sent/cancelled/failed とみなし return（二重送信防止 / NFR-004）。`failed` は終端で再 claim
 *    しない。
 * 4. Chatwork 投稿（tx 外）。成功は `tx{ outbound sent + chatwork_message_id / delivery_attempts
 *    success }` → 確認を「✅ 送信しました」に更新。失敗（`ChatworkApiError`）は `tx{ outbound failed +
 *    error_message / delivery_attempts failure(http_status/error_code) }` → 確認を「❌ 失敗」に更新。
 * 5. 確定 tx が落ちた稀ケースは `op=slack.outbound.commit_failed` で識別子ログ（sending 残留・二重投稿
 *    なし / NFR-005）。`chat.update` 失敗は識別子のみログ（DB 真実は確定済み）。
 *
 * never-throw（ルートは 200 前提）。`error_message` には本文・トークンを入れず識別子要約のみ
 * （例: `${err.op} status=${err.status}` / NFR-002）。
 *
 * @param input `outboundId`（対象行）と `pressUserId`（押下者）
 * @param deps DB・アダプタ・ロガー・allowlist
 * @returns 処理完了（すべての分岐で例外を投げず return）
 */
export async function sendOutbound(
  input: OutboundActionInput,
  deps: SendOutboundDeps,
): Promise<void> {
  try {
    const id = parseOutboundId(input.outboundId);
    if (id === null) {
      deps.logger.warn({ op: "slack.outbound.bad_id" }, "skip: invalid outbound id");
      return;
    }

    const row = await selectOutbound(id, deps);
    if (row === null) {
      deps.logger.warn(
        { op: "slack.outbound.not_found", outboundId: id },
        "skip: outbound missing",
      );
      return;
    }

    // 手順2: 認可。NG は共有確認メッセージを更新せず（chat.update も outbound も触らない）、
    // 識別子のみログして return する。確認メッセージはスレッド共有のため、未認可押下で更新すると
    // 他人の pending UI 破壊・送信済/キャンセル済表示の上書き（DoS / 監査破壊 / 状態競合）が起きる。
    // chat.update は「認可済みかつ状態遷移成功後（sent/failed/cancelled）」のみに限定する（REQ-006/009）。
    if (!isAuthorized(input.pressUserId, row, deps)) {
      deps.logger.warn(
        {
          op: "slack.outbound.forbidden",
          outboundId: id,
          channelId: row.slackChannelId,
          pressUserId: input.pressUserId,
        },
        "unauthorized button press ignored",
      );
      return;
    }

    // 手順3: claim（pending のみ）。0 行は二重送信防止のため return。
    const claimed = await deps.db.db
      .update(outboundMessages)
      .set({ status: "sending", updatedAt: new Date() })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "pending")))
      .returning({
        chatworkRoomId: outboundMessages.chatworkRoomId,
        body: outboundMessages.body,
      });

    const claimedRow = claimed[0];
    if (claimedRow === undefined) {
      // 既に sending/sent/cancelled/failed。二重送信しない（NFR-004）。
      deps.logger.info(
        { op: "slack.outbound.claim_skip", outboundId: id, status: row.status },
        "skip: not claimable",
      );
      return;
    }

    // 手順4: Chatwork 投稿（tx 外）。
    let chatworkMessageId: string;
    try {
      const result = await deps.chatworkClient.postMessage(
        toChatworkRoomId(claimedRow.chatworkRoomId),
        claimedRow.body,
      );
      chatworkMessageId = result.chatworkMessageId;
    } catch (err) {
      // 投稿失敗 → failed + delivery failure を同一 tx で記録（NFR-005）。
      const status = err instanceof ChatworkApiError ? err.status : undefined;
      const op = err instanceof ChatworkApiError ? err.op : "chatwork.postMessage";
      // error_message は識別子要約のみ（本文・トークン非含有 / NFR-002）。
      const errorMessage = `${op} status=${status ?? "n/a"}`;
      try {
        await deps.db.db.transaction(async (tx) => {
          await tx
            .update(outboundMessages)
            .set({ status: "failed", errorMessage, updatedAt: new Date() })
            .where(eq(outboundMessages.id, id));
          await tx.insert(deliveryAttempts).values({
            outboundMessageId: id,
            result: "failure",
            httpStatus: status ?? null,
            errorCode: op,
          });
        });
      } catch (txErr) {
        // 確定 tx 失敗の稀ケース: sending のまま残留。専用 op でログ（二重投稿なし / NFR-005）。
        deps.logger.error(
          { op: "slack.outbound.commit_failed", outboundId: id, err: serializeError(txErr) },
          "failed to commit failure record; outbound stays sending",
        );
        return;
      }
      deps.logger.error(
        { op: "slack.outbound.failed", outboundId: id, status },
        "chatwork post failed",
      );
      await updateResult(row, "failed", deps);
      return;
    }

    // 投稿成功 → sent + delivery success を同一 tx で記録（NFR-005）。
    try {
      await deps.db.db.transaction(async (tx) => {
        await tx
          .update(outboundMessages)
          .set({ status: "sent", chatworkMessageId, updatedAt: new Date() })
          .where(eq(outboundMessages.id, id));
        await tx.insert(deliveryAttempts).values({
          outboundMessageId: id,
          result: "success",
        });
      });
    } catch {
      // 投稿は成功したが確定 tx が落ちた稀ケース: sending 残留・delivery 不在。専用 op でログ。
      // sending は claim 対象外のため二重投稿は起きない（NFR-005）。自動回復は #5。
      // tx エラー詳細はログに載せない（chatworkMessageId は識別子で安全 / NFR-002）。
      deps.logger.error(
        { op: "slack.outbound.commit_failed", outboundId: id, chatworkMessageId },
        "posted to chatwork but failed to commit success record; outbound stays sending",
      );
      return;
    }

    deps.logger.info(
      { op: "slack.outbound.sent", outboundId: id, chatworkMessageId },
      "sent to chatwork",
    );
    await updateResult(row, "sent", deps);
  } catch (err) {
    // never-throw（ルートは 200 前提）。
    deps.logger.error(
      { op: "slack.outbound.unexpected", err: serializeError(err) },
      "sendOutbound threw unexpectedly; ignoring",
    );
  }
}

/**
 * 確認メッセージ（［キャンセル］ボタン）押下を処理し、`pending` のみを `cancelled` にする
 * （REQ-006 / 設計 §4.5）。
 *
 * 認可（送信と同じ。NG は共有確認メッセージを更新せず識別子のみログして return）→
 * `update ... set status='cancelled' where id=? and status='pending' returning`。1 行更新できたら確認を
 * 「🚫 キャンセルしました」に更新。0 行は no-op（既に別状態）。never-throw。
 *
 * @param input `outboundId`（対象行）と `pressUserId`（押下者）
 * @param deps DB・アダプタ・ロガー・allowlist
 * @returns 処理完了（すべての分岐で例外を投げず return）
 */
export async function cancelOutbound(
  input: OutboundActionInput,
  deps: SendOutboundDeps,
): Promise<void> {
  try {
    const id = parseOutboundId(input.outboundId);
    if (id === null) {
      deps.logger.warn({ op: "slack.outbound.bad_id" }, "skip: invalid outbound id");
      return;
    }

    const row = await selectOutbound(id, deps);
    if (row === null) {
      deps.logger.warn(
        { op: "slack.outbound.not_found", outboundId: id },
        "skip: outbound missing",
      );
      return;
    }

    // 認可 NG は共有確認メッセージを更新せず（chat.update も outbound も触らない）、識別子のみログして
    // return する（sendOutbound と同方針。未認可押下による共有 UI 破壊を防ぐ / REQ-006/009）。
    if (!isAuthorized(input.pressUserId, row, deps)) {
      deps.logger.warn(
        {
          op: "slack.outbound.forbidden",
          outboundId: id,
          channelId: row.slackChannelId,
          pressUserId: input.pressUserId,
        },
        "unauthorized button press ignored",
      );
      return;
    }

    const cancelled = await deps.db.db
      .update(outboundMessages)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.status, "pending")))
      .returning({ id: outboundMessages.id });

    if (cancelled[0] === undefined) {
      // 既に別状態。no-op。
      deps.logger.info(
        { op: "slack.outbound.cancel_skip", outboundId: id, status: row.status },
        "skip: not cancellable",
      );
      return;
    }

    deps.logger.info({ op: "slack.outbound.cancelled", outboundId: id }, "cancelled");
    await updateResult(row, "cancelled", deps);
  } catch (err) {
    deps.logger.error(
      { op: "slack.outbound.unexpected", err: serializeError(err) },
      "cancelOutbound threw unexpectedly; ignoring",
    );
  }
}

/**
 * outbound id 文字列（payload の value）を bigint に変換する。
 *
 * @param value payload の `value`（`outbound_messages.id` の文字列）
 * @returns 正常なら bigint、空・非数値は null
 */
function parseOutboundId(value: string): bigint | null {
  if (!/^[0-9]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * 対象 outbound 行を id で 1 件 SELECT する。
 *
 * @param id 対象 id
 * @param deps DB
 * @returns 認可・更新に必要な最小ビュー。無ければ null
 */
async function selectOutbound(id: bigint, deps: SendOutboundDeps): Promise<OutboundRow | null> {
  const rows = await deps.db.db
    .select({
      id: outboundMessages.id,
      status: outboundMessages.status,
      slackChannelId: outboundMessages.slackChannelId,
      slackConfirmTs: outboundMessages.slackConfirmTs,
      slackUserId: outboundMessages.slackUserId,
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.id, id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * 押下者が操作を許可されるか判定する（REQ-006/009）。
 *
 * 返信本人（`slack_user_id` 一致）OR allowlist（非空時に押下者を含む）。
 *
 * @param pressUserId 押下者の Slack user id
 * @param row 対象 outbound 行
 * @param deps allowlist を含む依存
 * @returns 許可なら true
 */
function isAuthorized(pressUserId: string, row: OutboundRow, deps: SendOutboundDeps): boolean {
  if (row.slackUserId !== null && pressUserId === row.slackUserId) {
    return true;
  }
  return deps.allowedReplyUserIds.length > 0 && deps.allowedReplyUserIds.includes(pressUserId);
}

/**
 * 確認メッセージを結果表示（✅/❌/🚫）に `chat.update` で差し替える。
 *
 * `slack_confirm_ts` が無い（確認投稿前に到達した稀ケース）場合は更新できないためログのみで skip。
 * 更新失敗は識別子のみログ（DB の真実は確定済み / NFR-005）。
 *
 * @param row 対象 outbound 行（channel / confirmTs を持つ）
 * @param kind 結果種別
 * @param deps Slack client・ロガー
 * @returns 完了（失敗してもログのみで return）
 */
async function updateResult(
  row: OutboundRow,
  kind: Parameters<typeof buildResultMessage>[0],
  deps: SendOutboundDeps,
): Promise<void> {
  if (row.slackConfirmTs === null) {
    deps.logger.warn(
      { op: "slack.outbound.no_confirm_ts", outboundId: row.id },
      "skip chat.update: confirm ts missing",
    );
    return;
  }
  try {
    await deps.slackClient.updateMessage(
      toSlackChannelId(row.slackChannelId),
      toSlackTs(row.slackConfirmTs),
      buildResultMessage(kind),
    );
  } catch (err) {
    deps.logger.error(
      { op: "slack.outbound.update", outboundId: row.id, err: serializeError(err) },
      "chat.update failed; DB state is authoritative",
    );
  }
}
