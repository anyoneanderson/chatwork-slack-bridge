import { eq } from "drizzle-orm";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import { extractAttachments } from "@/adapters/chatwork/extract-attachments";
import type { ChatworkRoomId } from "@/adapters/chatwork/types";
import type { SlackClient } from "@/adapters/slack/client";
import type { SlackChannelId, SlackTs } from "@/adapters/slack/types";
import type { DbClient } from "@/db/client";
import { chatworkMessageAttachments } from "@/db/schema";
import type { Logger } from "@/logger";
import { serializeError } from "@/serialize-error";

/** 添付ファイルサイズ上限のデフォルト（100MB / NFR-006）。`maxBytes` 未指定時に使う。 */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * `mirrorAttachments` の依存。アダプタ・DB・ロガー・サイズ上限を DI で注入し、テスト時に
 * モック差し替え可能にする（NFR-004 / coding-rules テスト戦略）。
 */
export interface MirrorAttachmentsDeps {
  /** Drizzle DB クライアント（既アップロード判定の SELECT・mapping の upsert）。 */
  db: DbClient;
  /** Chatwork API client（メタ取得・短命 URL からのバイト取得）。 */
  chatworkClient: ChatworkClient;
  /** Slack client（スレッドへのファイルアップロード）。 */
  slackClient: SlackClient;
  /** 構造化ロガー（識別子のみ。本文・URL・バイト・ファイル名・トークンは出さない / NFR-002）。 */
  logger: Logger;
  /**
   * ファイルサイズ上限（バイト）。未指定時は 100MB（NFR-006）。
   * テストで差し替え可能にするため DI で受ける（`[SHOULD]` マジックナンバー排除）。
   */
  maxBytes?: number;
}

/**
 * `mirrorAttachments` の入力。識別子は構造化ログ用（外部 ID）と FK 親（内部 PK）を区別して受ける。
 */
export interface MirrorAttachmentsInput {
  /** 対象 Chatwork ルーム ID（API 呼び出しに使う）。 */
  chatworkRoomId: ChatworkRoomId;
  /** Chatwork メッセージの外部 ID（構造化ログ用）。 */
  chatworkMessageId: string;
  /** FK 親（`chatwork_messages.id`。mapping の `chatwork_message_id` に保存）。 */
  messageRowId: bigint;
  /** Chatwork メッセージ本文（ここから file_id を抽出する。ログ非出力）。 */
  body: string;
  /** アップロード先 Slack チャンネル ID。 */
  slackChannelId: SlackChannelId;
  /** 本文投稿の `ts`（このスレッドに添付する）。 */
  slackThreadTs: SlackTs;
}

/**
 * Slack 本文投稿成功 + `slack_ts` UPDATE 成功後に呼ぶ添付ミラー処理（REQ-005 / 006 / 設計 §4.4）。
 *
 * 処理手順:
 * 1. `extractAttachments(body)` で本文から添付 file_id 群を抽出する。0 件なら即 return。
 * 2. `chatwork_message_attachments` を `chatworkMessageId`（FK 親 = 内部 PK）で SELECT し、既に
 *    アップロード済みの file_id を除外する（重複アップロード防止 / 設計 §3.2）。
 * 3. 未アップロードのみ**逐次**処理する（NFR-007 / 設計 §5）。各 file について:
 *    メタ取得（`getFileDownloadUrl`）→ サイズ事前判定（API メタ `filesize`）→ バイト取得
 *    （`downloadFile({ maxBytes })`。内部で Content-Length・実バイト長の二段検証も行う / NFR-006）→
 *    Slack アップロード（`uploadFile`。スレッド添付）→ mapping を `onConflictDoNothing` で記録。
 * 4. 件数サマリを構造化ログに残して終了する。
 *
 * 例外契約（CON-001 / NFR-005 / 設計 §4.4）:
 * - **例外を投げない（never-throw）**。`forwardMessage` と同じ「ルートは常に 200」契約を守り、
 *   呼び出し側の転送フローを止めない。
 * - **各 file の処理は per-file の try/catch で握る**。1 件が失敗しても他の添付処理は継続する
 *   （fallback ログのみ。本文側の `📎 ファイル名 (サイズ)` テキスト表示が原本への導線として残る）。
 * - **関数全体を外側 try/catch で囲む**。既アップロード判定の SELECT を含む for ループ外の処理が
 *   throw しても握り潰す（DB 障害時も mirror 全体を safely skip / sender-name Phase 3 で
 *   `resolveSenderName` の throw 漏れを Codex が捕捉した経緯と整合）。
 * - ログは `op` と識別子（roomId / messageId / fileId / channelId）のみ。本文・短命 URL・バイト・
 *   ファイル名・トークンは出さない（NFR-002）。
 *
 * @param input ルーム・メッセージ識別子・本文・投稿先（スレッド）
 * @param deps DB・アダプタ・ロガー・サイズ上限
 * @returns 処理完了。抽出 0 件・SELECT 失敗・各 file 失敗・全件処理のいずれも内部でログして
 *   正常 return する（例外は投げない）
 */
export async function mirrorAttachments(
  input: MirrorAttachmentsInput,
  deps: MirrorAttachmentsDeps,
): Promise<void> {
  const { chatworkRoomId, chatworkMessageId, messageRowId, body, slackChannelId, slackThreadTs } =
    input;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  // 外側 try/catch（二重防御）。既アップロード判定 SELECT・抽出周辺など for ループ外の予期しない
  // 例外もここで握り、mirror 全体を safely skip する（never-throw 契約 / 設計 §4.4）。
  try {
    // 手順1: 本文から添付 file_id を抽出する（純粋関数 / I/O 無し）。
    const refs = extractAttachments(body);
    if (refs.length === 0) {
      // 添付なし。Chatwork / Slack / DB を一切呼ばずに終了する。
      return;
    }

    // 手順2: 既アップロード判定。同一 message 配下の既存 file_id を 1 回の SELECT で取得し、
    // 除外集合を作る（設計 §3.2）。この SELECT が失敗しても外側 catch でカバーされ、mirror 全体を
    // 安全側に倒して skip する。
    const uploaded = await deps.db.db
      .select({ fileId: chatworkMessageAttachments.chatworkFileId })
      .from(chatworkMessageAttachments)
      .where(eq(chatworkMessageAttachments.chatworkMessageId, messageRowId));
    const uploadedSet = new Set(uploaded.map((row) => row.fileId));

    const todo = refs.filter((ref) => !uploadedSet.has(ref.fileId));

    // 手順3: 未アップロードのみ逐次処理する。1 件の失敗で他を巻き込まないよう per-file で握る。
    let okCount = 0;
    for (const ref of todo) {
      try {
        // メタ取得（短命 URL を含む。URL・ファイル名はログに出さない）。
        const info = await deps.chatworkClient.getFileDownloadUrl(chatworkRoomId, ref.fileId);

        // サイズ三段防御 1 段目: API メタの `filesize` で事前判定（NFR-006）。
        // 超過時は Slack を呼ばず fallback ログのみ。他の添付処理は継続する。
        if (info.filesize > maxBytes) {
          deps.logger.info(
            {
              op: "forward.mirror.too_large",
              roomId: chatworkRoomId,
              messageId: chatworkMessageId,
              fileId: ref.fileId,
            },
            "attachment exceeds size limit; left as text fallback",
          );
          continue;
        }

        // バイト取得（短命 URL から。downloadFile 内で Content-Length・実バイト長を maxBytes と再照合）。
        const file = await deps.chatworkClient.downloadFile(info.downloadUrl, { maxBytes });

        // Slack スレッドへアップロード（MIME は実体ヘッダ優先・無ければ API メタ）。
        const up = await deps.slackClient.uploadFile({
          channelId: slackChannelId,
          threadTs: slackThreadTs,
          filename: info.filename,
          mimeType: file.mimeType ?? info.mimeType,
          bytes: file.bytes,
        });

        // mapping を冪等に記録（unique 制約 + onConflictDoNothing で二重 insert を防止 / NFR-004）。
        await deps.db.db
          .insert(chatworkMessageAttachments)
          .values({
            chatworkMessageId: messageRowId,
            chatworkFileId: ref.fileId,
            slackFileId: up.slackFileId,
            slackChannelId,
            slackThreadTs,
          })
          .onConflictDoNothing({
            target: [
              chatworkMessageAttachments.chatworkMessageId,
              chatworkMessageAttachments.chatworkFileId,
            ],
          });

        okCount += 1;
        deps.logger.info(
          {
            op: "forward.mirror.uploaded",
            roomId: chatworkRoomId,
            messageId: chatworkMessageId,
            fileId: ref.fileId,
          },
          "attachment mirrored to slack thread",
        );
      } catch (err) {
        // 該当ファイルのみ失敗。mapping は書かれず、他の添付処理は継続する（fallback ログのみ）。
        // エラーは serializeError 経由（ChatworkApiError / SlackApiError は識別子・status のみ保持）。
        deps.logger.error(
          {
            op: "forward.mirror.failed",
            roomId: chatworkRoomId,
            messageId: chatworkMessageId,
            fileId: ref.fileId,
            err: serializeError(err),
          },
          "attachment mirror failed; left as text fallback",
        );
      }
    }

    deps.logger.info(
      {
        op: "forward.mirror.done",
        roomId: chatworkRoomId,
        messageId: chatworkMessageId,
        total: refs.length,
        attempted: todo.length,
        ok: okCount,
      },
      "attachment mirror finished",
    );
  } catch (err) {
    // 既アップロード判定 SELECT・抽出周辺など for ループ外の予期しない例外。安全側に倒して
    // mirror 全体を skip し、forwarding フローを止めない（never-throw 契約 / 設計 §4.4）。
    deps.logger.error(
      {
        op: "forward.mirror.skipped",
        roomId: chatworkRoomId,
        messageId: chatworkMessageId,
        err: serializeError(err),
      },
      "attachment mirror skipped due to unexpected error; forward flow kept alive",
    );
  }
}
