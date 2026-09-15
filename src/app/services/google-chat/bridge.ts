import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { googleChatMessageLink } from "@/adapters/google-chat/message-link";
import {
  type GoogleChatClient,
  GoogleChatError,
  type GoogleChatMessage,
} from "@/adapters/google-chat/types";
import { SlackApiError, type SlackClient } from "@/adapters/slack/client";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import {
  confirmationMessage,
  plainMessage,
  slackReplyToPlainText,
} from "@/app/services/google-chat/presentation";
import type { SlackReplyEvent } from "@/app/services/handle-slack-reply";
import type { GoogleChatConfig } from "@/config/google-chat";
import type { DbClient } from "@/db/client";
import {
  googleChatDeliveryAttempts as attempts,
  googleChatConnections as connections,
  googleChatInbox as inbox,
  googleChatOutbox as outbox,
  googleChatThreads as threads,
} from "@/db/google-chat-schema";
import type { Logger } from "@/logger";

const LEASE_SECONDS = 120;
const PAGE_BATCH_LIMIT = 5;
const DELIVERY_BATCH_LIMIT = 100;
const MAX_REPLY_LENGTH = 10000;
const OVERLAP_MS = 60000;
type Transaction = Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0];
type Connection = typeof connections.$inferSelect;
type Outbound = typeof outbox.$inferSelect;

export interface GoogleChatBridgeDeps {
  db: DbClient;
  client: GoogleChatClient;
  slackClient: SlackClient;
  logger: Logger;
  config: GoogleChatConfig;
}

/**
 * 認証情報と許可ユーザー一覧を除き、接続先と取得開始時刻を照合する値を作る。
 * @param config 検証済みの Google Chat 設定
 * @returns 保存済み接続との比較に使う SHA-256 ハッシュ
 */
export function googleChatConfigIdentity(config: GoogleChatConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.accountEmail,
        config.spaceName,
        config.slackChannelId,
        config.startTime,
      ]),
    )
    .digest("hex");
}

/**
 * 永続化した取得位置と送信状態を使って Google Chat と Slack を接続する。
 * @param deps DB、API クライアント、ロガー、検証済み設定
 * @returns 定期取得、返信確認、送信ボタン操作の処理
 */
export function createGoogleChatBridge({
  db: { db },
  client,
  slackClient,
  logger,
  config,
}: GoogleChatBridgeDeps) {
  const identity = googleChatConfigIdentity(config);
  const channel = toSlackChannelId(config.slackChannelId);
  const allowed = (user: string) => config.allowedReplyUserIds.includes(user);
  const matches = (connection: Connection) =>
    connection.enabled &&
    connection.provider === "google-chat" &&
    connection.configIdentity === identity &&
    connection.accountEmail === config.accountEmail &&
    connection.spaceName === config.spaceName &&
    connection.slackChannelId === config.slackChannelId;

  const isTerminalError = (code: string) =>
    ["auth_revoked", "account_mismatch", "forbidden", "resource_mismatch"].includes(code);

  async function stopConnection(
    tx: Pick<DbClient["db"], "update">,
    connectionId: bigint,
    code: string,
    token?: string,
  ) {
    if (!isTerminalError(code)) return false;
    const [stopped] = await tx
      .update(connections)
      .set({
        enabled: false,
        errorCode: code,
        notificationStatus: "sending",
      })
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.enabled, true),
          eq(connections.configIdentity, identity),
          eq(connections.provider, "google-chat"),
          eq(connections.accountEmail, config.accountEmail),
          eq(connections.spaceName, config.spaceName),
          eq(connections.slackChannelId, config.slackChannelId),
          ...(token
            ? [eq(connections.leaseToken, token), sql`${connections.leaseUntil} > now()`]
            : []),
        ),
      )
      .returning();
    return stopped !== undefined;
  }

  async function notifyStopped(connectionId: bigint, code: string) {
    try {
      await slackClient.postMessage(
        channel,
        plainMessage(
          `Google Chat の取得と返信を停止しました（${code}）。アカウント・スペースの権限を確認し、必要なら再認証して、運用手順に従って接続を再有効化してください。送信結果が不明な返信は再送せず、再有効化後に結果を照会してください。`,
        ),
      );
      await db
        .update(connections)
        .set({ notificationStatus: "sent" })
        .where(eq(connections.id, connectionId));
    } catch {
      await db
        .update(connections)
        .set({ notificationStatus: "unknown" })
        .where(eq(connections.id, connectionId));
      logger.error(
        { op: "google_chat.stop_notification", code: "delivery_unknown" },
        "Google Chat stop notification requires operator reconciliation",
      );
    }
  }

  async function lockLease(tx: Transaction, id: bigint, token: string) {
    const [connection] = await tx
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, id),
          eq(connections.leaseToken, token),
          sql`${connections.leaseUntil} > now()`,
        ),
      )
      .for("update");
    if (!connection || !matches(connection)) throw new Error("Google Chat lease unavailable");
    await tx
      .update(connections)
      .set({ leaseUntil: sql`now() + ${LEASE_SECONDS} * interval '1 second'` })
      .where(eq(connections.id, id));
    return connection;
  }

  async function stagePage(tx: Transaction, connection: Connection, messages: GoogleChatMessage[]) {
    for (const message of messages) {
      if (new Date(message.createTime).getTime() < new Date(config.startTime).getTime()) continue;
      const [thread] = await tx
        .insert(threads)
        .values({
          connectionId: connection.id,
          threadName: message.threadName,
          slackChannelId: config.slackChannelId,
        })
        .onConflictDoUpdate({
          target: [threads.connectionId, threads.threadName],
          set: { threadName: message.threadName },
        })
        .returning();
      if (!thread) throw new Error("Google Chat thread missing");
      const echoConditions = [eq(outbox.googleMessageName, message.name)];
      if (message.clientAssignedMessageId)
        echoConditions.push(eq(outbox.messageId, message.clientAssignedMessageId));
      const [echo] = await tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.connectionId, connection.id),
            inArray(outbox.status, ["sending", "sent", "unknown"]),
            or(...echoConditions),
          ),
        )
        .limit(1);
      await tx
        .insert(inbox)
        .values({
          connectionId: connection.id,
          threadId: thread.id,
          messageName: message.name,
          body: message.text,
          senderName: message.senderName,
          createTime: new Date(message.createTime),
          status: echo ? "suppressed" : "pending",
        })
        .onConflictDoNothing();
    }
  }

  async function deliver(
    connectionId: bigint,
    token: string,
    signal?: AbortSignal,
  ): Promise<number> {
    let lastPostAt = 0;
    for (let count = 0; count < DELIVERY_BATCH_LIMIT; count++) {
      if (signal?.aborted) return 1000;
      const delay = Math.max(0, lastPostAt + 1000 - Date.now());
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) return 1000;
      const claimed = await db.transaction(async (tx) => {
        await lockLease(tx, connectionId, token);
        if (signal?.aborted) return undefined;
        // Slack 投稿の結果が不明な行があれば、重複投稿を避けるため転送を停止する。
        const [blocked] = await tx
          .select({ id: inbox.id })
          .from(inbox)
          .where(
            and(
              eq(inbox.connectionId, connectionId),
              inArray(inbox.status, ["sending", "unknown"]),
            ),
          )
          .limit(1);
        if (blocked) return undefined;
        const [message] = await tx
          .select()
          .from(inbox)
          .where(and(eq(inbox.connectionId, connectionId), eq(inbox.status, "pending")))
          .orderBy(asc(inbox.createTime), asc(inbox.messageName))
          .limit(1)
          .for("update");
        if (!message) return undefined;
        const [thread] = await tx
          .select()
          .from(threads)
          .where(eq(threads.id, message.threadId))
          .for("update");
        if (!thread) throw new Error("Google Chat thread missing");
        // 外部送信を確定する前に、本文とリンクを組み立てて検証する。
        let content: ReturnType<typeof plainMessage>;
        try {
          content = plainMessage(
            `Google Chat · ${config.spaceDisplayName}\n${message.senderName}\n\n${message.body}`,
          );
          content.blocks?.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `<${googleChatMessageLink(message.messageName, thread.threadName)}|Google Chat で開く>`,
            },
          });
        } catch {
          await tx
            .update(inbox)
            .set({ errorCode: "slack_payload_invalid" })
            .where(eq(inbox.id, message.id));
          logger.error(
            { op: "google_chat.slack_forward", code: "slack_payload_invalid" },
            "Google Chat display requires operator correction",
          );
          return undefined;
        }
        if (signal?.aborted) return undefined;
        await tx
          .update(inbox)
          .set({ status: "sending", errorCode: null })
          .where(eq(inbox.id, message.id));
        await tx
          .insert(attempts)
          .values({ inboxId: message.id, operation: "slack_forward", result: "started" });
        return { message, thread, content };
      });
      if (!claimed) return 1000;
      const { message, thread, content } = claimed;
      // 送信確定後でも、停止要求で未送信なら再試行できる状態へ戻す。
      if (signal?.aborted) {
        await db
          .update(inbox)
          .set({ status: "pending" })
          .where(and(eq(inbox.id, message.id), eq(inbox.status, "sending")));
        return 1000;
      }
      try {
        lastPostAt = Date.now();
        const posted = await slackClient.postMessage(
          channel,
          content,
          thread.slackRootTs ? { threadTs: toSlackTs(thread.slackRootTs) } : undefined,
        );
        await db.transaction(async (tx) => {
          await tx
            .update(inbox)
            .set({ status: "sent", slackTs: posted.ts })
            .where(and(eq(inbox.id, message.id), eq(inbox.status, "sending")));
          if (!thread.slackRootTs)
            await tx
              .update(threads)
              .set({ slackRootTs: posted.ts })
              .where(eq(threads.id, thread.id));
          await tx
            .insert(attempts)
            .values({ inboxId: message.id, operation: "slack_forward", result: "success" });
        });
      } catch (error) {
        const definite = error instanceof SlackApiError && error.kind !== "unknown";
        const code = definite
          ? error.kind === "rate_limited"
            ? "slack_rate_limited"
            : "slack_rejected"
          : "slack_delivery_unknown";
        await db.transaction(async (tx) => {
          await tx
            .update(inbox)
            .set({ status: definite ? "pending" : "unknown", errorCode: code })
            .where(and(eq(inbox.id, message.id), eq(inbox.status, "sending")));
          await tx.insert(attempts).values({
            inboxId: message.id,
            operation: "slack_forward",
            result: definite ? "rejected" : "unknown",
          });
        });
        logger.error(
          { op: "google_chat.slack_forward", code },
          "Google Chat forwarding stopped for this poll",
        );
        return error instanceof SlackApiError && error.kind === "rate_limited"
          ? Math.max(1000, (error.retryAfterSeconds ?? 60) * 1000)
          : 1000;
      }
    }
    return 1000;
  }

  /**
   * 保存済みの取得位置から新着を取得し、未転送の本文を Slack へ送る。
   * @param options ページと送信の境界で確認する停止シグナル
   * @returns 今回の取得と転送が終了すると完了
   */
  async function poll(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return;
    let releaseDelayMs = 0;
    const token = randomUUID();
    let connectionId: bigint | undefined;
    try {
      await db
        .insert(connections)
        .values({
          slot: "default",
          accountEmail: config.accountEmail,
          spaceName: config.spaceName,
          slackChannelId: config.slackChannelId,
          configIdentity: identity,
          cursor: new Date(config.startTime),
        })
        .onConflictDoNothing();
      const [connection] = await db
        .update(connections)
        .set({ leaseToken: token, leaseUntil: sql`now() + ${LEASE_SECONDS} * interval '1 second'` })
        .where(
          and(
            eq(connections.slot, "default"),
            eq(connections.configIdentity, identity),
            eq(connections.enabled, true),
            sql`(${connections.leaseUntil} is null or ${connections.leaseUntil} <= now())`,
          ),
        )
        .returning();
      if (!connection) {
        const [existing] = await db
          .select({ configIdentity: connections.configIdentity })
          .from(connections)
          .where(eq(connections.slot, "default"));
        if (existing && existing.configIdentity !== identity)
          logger.error(
            { op: "google_chat.config_mismatch", code: "config_mismatch" },
            "Google Chat saved destination differs from configuration",
          );
        return;
      }
      connectionId = connection.id;
      if (new Date(config.startTime).getTime() >= Date.now()) return;
      for (let page = 0; page < PAGE_BATCH_LIMIT; page++) {
        if (signal?.aborted) break;
        const window = await db.transaction(async (tx) => {
          const current = await lockLease(tx, connection.id, token);
          const after =
            current.windowAfter ??
            new Date(
              Math.max(new Date(config.startTime).getTime(), current.cursor.getTime() - OVERLAP_MS),
            );
          const before = current.windowBefore ?? new Date();
          await tx
            .update(connections)
            .set({ windowAfter: after, windowBefore: before })
            .where(eq(connections.id, current.id));
          return { after, before, pageToken: current.pageToken };
        });
        if (signal?.aborted) break;
        const response = await client.listMessages({
          after: window.after.toISOString(),
          before: window.before.toISOString(),
          ...(window.pageToken ? { pageToken: window.pageToken } : {}),
        });
        await db.transaction(async (tx) => {
          const current = await lockLease(tx, connection.id, token);
          await stagePage(tx, current, response.messages);
          await tx
            .update(connections)
            .set(
              response.nextPageToken
                ? { pageToken: response.nextPageToken }
                : { pageToken: null, windowAfter: null, windowBefore: null, cursor: window.before },
            )
            .where(eq(connections.id, current.id));
        });
        if (!response.nextPageToken) {
          releaseDelayMs = await deliver(connection.id, token, signal);
          break;
        }
      }
    } catch (error) {
      const code = error instanceof GoogleChatError ? error.code : "poll_failed";
      logger.error(
        { op: "google_chat.poll", code },
        "Google Chat poll failed; durable checkpoint retained",
      );
      if (connectionId !== undefined) {
        if (isTerminalError(code)) {
          if (await stopConnection(db, connectionId, code, token))
            await notifyStopped(connectionId, code);
        } else {
          await db
            .update(connections)
            .set({
              errorCode: code,
              // ページトークンが期限切れなら、保存済みの同じ期間を先頭から読み直す。
              ...(code === "invalid_input" ? { pageToken: null } : {}),
            })
            .where(
              and(
                eq(connections.id, connectionId),
                eq(connections.leaseToken, token),
                eq(connections.enabled, true),
                eq(connections.configIdentity, identity),
                sql`${connections.leaseUntil} > now()`,
              ),
            );
        }
      }
    } finally {
      if (connectionId !== undefined)
        await db
          .update(connections)
          .set({
            leaseToken: null,
            leaseUntil: releaseDelayMs
              ? sql`now() + ${releaseDelayMs} * interval '1 millisecond'`
              : null,
          })
          .where(and(eq(connections.id, connectionId), eq(connections.leaseToken, token)));
    }
  }

  async function updateResult(row: Outbound, text: string) {
    if (!row.slackConfirmTs) return;
    try {
      const message = plainMessage(text);
      if (row.status === "unknown" || row.status === "sending")
        message.blocks?.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "送信結果を照会" },
              action_id: "gc_check",
              value: row.id,
            },
          ],
        });
      await slackClient.updateMessage(channel, toSlackTs(row.slackConfirmTs), message);
    } catch {
      logger.error(
        { op: "google_chat.confirm_update", code: "slack_update_failed" },
        "Google Chat status display failed",
      );
    }
  }

  /**
   * Google Chat に対応する Slack スレッドへの返信を保存し、送信確認を表示する。
   * @param event 署名検証と入力検証を通過した Slack の返信イベント
   * @returns Google Chat が管理するスレッドなら true
   */
  async function handleReply(event: SlackReplyEvent): Promise<boolean> {
    if (!event.thread_ts || event.channel !== config.slackChannelId) return false;
    const [thread] = await db
      .select()
      .from(threads)
      .where(
        and(eq(threads.slackChannelId, event.channel), eq(threads.slackRootTs, event.thread_ts)),
      )
      .limit(1);
    if (!thread) return false;
    if (event.bot_id || event.subtype || !event.user || !event.text?.trim() || !allowed(event.user))
      return true;
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, thread.connectionId));
    if (!connection || !matches(connection)) return true;
    const body = slackReplyToPlainText(event.text);
    const tooLarge = body.length > MAX_REPLY_LENGTH || Buffer.byteLength(body, "utf8") > 30000;
    const values: typeof outbox.$inferInsert = {
      connectionId: connection.id,
      threadId: thread.id,
      threadName: thread.threadName,
      slackChannelId: event.channel,
      slackRootTs: event.thread_ts,
      slackReplyTs: event.ts,
      slackUserId: event.user,
      body: tooLarge ? "" : body,
      messageId: `client-${randomUUID()}`,
      requestId: randomUUID(),
      status: tooLarge ? "cancelled" : "pending",
      errorCode: tooLarge ? "reply_too_large" : null,
    };
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(outbox).values(values).onConflictDoNothing().returning();
      if (created)
        await tx
          .insert(attempts)
          .values({ outboxId: created.id, operation: "slack_confirm", result: "started" });
      return created;
    });
    if (!row) return true;
    try {
      const posted = await slackClient.postMessage(
        channel,
        tooLarge
          ? plainMessage(
              "返信が長すぎるため送信できません。10,000文字・30,000バイト以内に分けて入力してください。",
            )
          : confirmationMessage(row.id, config.accountEmail, config.spaceDisplayName, row.body),
        { threadTs: toSlackTs(row.slackRootTs) },
      );
      await db.transaction(async (tx) => {
        await tx.update(outbox).set({ slackConfirmTs: posted.ts }).where(eq(outbox.id, row.id));
        await tx
          .insert(attempts)
          .values({ outboxId: row.id, operation: "slack_confirm", result: "success" });
      });
    } catch {
      await db.transaction(async (tx) => {
        await tx
          .update(outbox)
          .set({ errorCode: "confirmation_delivery_unknown" })
          .where(eq(outbox.id, row.id));
        await tx
          .insert(attempts)
          .values({ outboxId: row.id, operation: "slack_confirm", result: "unknown" });
      });
      logger.error(
        { op: "google_chat.confirm", code: "delivery_unknown" },
        "Google Chat confirmation delivery requires operator reconciliation",
      );
    }
    return true;
  }

  async function recordSent(row: Outbound, message: GoogleChatMessage) {
    if (
      message.threadName !== row.threadName ||
      message.text !== row.body ||
      !message.name.startsWith(`${config.spaceName}/messages/`)
    )
      throw new Error("Google Chat reply mismatch");
    await db.transaction(async (tx) => {
      await tx
        .update(outbox)
        .set({ status: "sent", googleMessageName: message.name, errorCode: null })
        .where(and(eq(outbox.id, row.id), inArray(outbox.status, ["sending", "unknown"])));
      await tx
        .insert(attempts)
        .values({ outboxId: row.id, operation: "google_reply", result: "success" });
    });
    await updateResult({ ...row, status: "sent" }, "Google Chat に送信しました。");
  }

  /**
   * 入力者の認可を再確認し、送信、キャンセル、結果照会を実行する。
   * @param actionId 送信確認の操作 ID
   * @param outboundId 保存済み返信の UUID
   * @param userId 操作した Slack ユーザー ID
   * @returns 操作と結果の保存が終了すると完了
   */
  async function handleAction(actionId: string, outboundId: string, userId: string): Promise<void> {
    if (
      !["gc_send", "gc_cancel", "gc_check"].includes(actionId) ||
      !z.uuid().safeParse(outboundId).success ||
      !allowed(userId)
    )
      return;
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(outbox).where(eq(outbox.id, outboundId)).for("update");
      if (!row || row.slackUserId !== userId) return undefined;
      const [connection] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, row.connectionId))
        .for("update");
      const [thread] = await tx.select().from(threads).where(eq(threads.id, row.threadId));
      if (
        !connection ||
        !matches(connection) ||
        !thread ||
        thread.connectionId !== connection.id ||
        thread.threadName !== row.threadName ||
        thread.slackRootTs !== row.slackRootTs ||
        thread.slackChannelId !== row.slackChannelId ||
        row.slackChannelId !== config.slackChannelId
      )
        return undefined;
      if (actionId === "gc_check")
        return row.status === "sending" || row.status === "unknown" ? row : undefined;
      if (row.status !== "pending") return undefined;
      const status = actionId === "gc_cancel" ? "cancelled" : "sending";
      const [updated] = await tx
        .update(outbox)
        .set({ status })
        .where(and(eq(outbox.id, row.id), eq(outbox.status, "pending")))
        .returning();
      if (updated && status === "sending")
        await tx
          .insert(attempts)
          .values({ outboxId: row.id, operation: "google_reply", result: "started" });
      return updated;
    });
    if (!claimed) return;
    if (actionId === "gc_cancel") {
      await updateResult(claimed, "Google Chat への送信をキャンセルしました。");
      return;
    }
    try {
      if (actionId === "gc_check") {
        const existing = await client.getMessage(claimed.messageId);
        if (existing) await recordSent(claimed, existing);
        else
          await updateResult(
            claimed,
            "送信結果は未確認です。再送は行いません。時間を置いて再照会するか、運用担当者に確認してください。",
          );
      } else {
        const sent = await client.createReply({
          threadName: claimed.threadName,
          text: claimed.body,
          messageId: claimed.messageId,
          requestId: claimed.requestId,
        });
        await recordSent(claimed, sent);
      }
    } catch (error) {
      const code = error instanceof GoogleChatError ? error.code : "google_delivery_unknown";
      const stopped = await db.transaction(async (tx) => {
        await tx
          .update(outbox)
          .set({ status: "unknown", errorCode: code })
          .where(and(eq(outbox.id, claimed.id), inArray(outbox.status, ["sending", "unknown"])));
        await tx.insert(attempts).values({
          outboxId: claimed.id,
          operation: actionId === "gc_check" ? "google_reconcile" : "google_reply",
          result: "unknown",
        });
        return stopConnection(tx, claimed.connectionId, code);
      });
      if (stopped) await notifyStopped(claimed.connectionId, code);
      logger.error({ op: "google_chat.reply", code }, "Google Chat reply requires reconciliation");
      await updateResult(
        { ...claimed, status: "unknown" },
        isTerminalError(code)
          ? `Google Chat の接続を停止しました（${code}）。権限確認・再認証と接続の再有効化後に送信結果を照会してください。結果が不明なため再送は行いません。`
          : "Google Chat の送信結果を確認できません。再送せず、送信結果を照会してください。",
      );
    }
  }

  return { poll, handleReply, handleAction };
}

export type GoogleChatBridge = ReturnType<typeof createGoogleChatBridge>;
