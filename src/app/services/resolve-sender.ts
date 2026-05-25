import { and, eq, sql } from "drizzle-orm";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { ChatworkRoomId } from "@/adapters/chatwork/types";
import type { DbClient } from "@/db/client";
import { chatworkRoomMembers } from "@/db/schema";
import type { Logger } from "@/logger";

/**
 * `resolveSenderName` の依存。アダプタ・DB・ロガーを DI で注入し、テスト時にモック差し替え
 *可能にする（NFR-004 / coding-rules テスト戦略）。
 */
export interface ResolveSenderDeps {
  /** Drizzle DB クライアント（メンバーキャッシュの参照／upsert）。 */
  db: DbClient;
  /** Chatwork API client（キャッシュミス時のメンバー一覧取得）。 */
  chatworkClient: ChatworkClient;
  /** 構造化ロガー（識別子のみ。本文・氏名・トークンは出さない / NFR-002）。 */
  logger: Logger;
}

/**
 * 送信者 `account_id` の表示名を解決する（REQ-002 / 設計 §4.2）。
 *
 * 解決順:
 * 1. `chatwork_room_members` キャッシュを `(room_id, account_id)` で SELECT し、ヒットすれば名前を返す。
 * 2. ミス時は `chatworkClient.getRoomMembers` でルームのメンバー一覧を取得し、取得できた全件を
 *    `onConflictDoUpdate` で upsert（名前変更追従・冪等 / NFR-004）してからキャッシュを再 SELECT する。
 * 3. それでも見つからない、または `getRoomMembers` が失敗した場合は `null` を返す（呼び出し側で
 *    `account_id` フォールバックする想定 / CON-001）。
 *
 * 設計上の重要な制約:
 * - **1メッセージあたりリフレッシュは最大1回**。再帰・再試行ループは行わない。
 * - **例外を投げない**。`getRoomMembers`・キャッシュ SELECT・upsert・再 SELECT のいずれが
 *   throw しても `null` を返し、forwarding を止めない（CON-001 forwarding 非破壊）。
 *   失敗詳細はログに出さず、識別子と `op` のみで「未解決」の事実を記録する。
 * - **ログは `op` と識別子のみ**。トークン・氏名・全件メンバーリスト・エラーメッセージ・スタックは
 *   ログに出さない（NFR-002）。
 *
 * @param roomId 送信者が属する Chatwork ルーム ID（ブランド型）
 * @param accountId 解決対象の送信者 `account_id`（文字列化済み）
 * @param deps DB クライアント・Chatwork client・ロガー
 * @returns 解決できた表示名。キャッシュ・API いずれでも解決できなければ `null`
 */
export async function resolveSenderName(
  roomId: ChatworkRoomId,
  accountId: string,
  deps: ResolveSenderDeps,
): Promise<string | null> {
  try {
    // 手順1: キャッシュ参照（毎回 API を叩かないため / レート制限回避）。
    const cached = await selectCachedName(roomId, accountId, deps);
    if (cached !== null) return cached;

    // 手順2: キャッシュミス → メンバー一覧を1回だけリフレッシュ（無限ループ防止）。
    const members = await deps.chatworkClient.getRoomMembers(roomId);

    // 取得した全件を upsert（名前変更にも追従。継続同期は無し＝ミス時のみ / 設計 §3.2）。
    // 空配列の場合は INSERT 自体を発行しない（postgres-js / drizzle が 0 行 INSERT で
    // 失敗する可能性を避け、無駄なクエリも省く）。
    if (members.length > 0) {
      await deps.db.db
        .insert(chatworkRoomMembers)
        .values(
          members.map((m) => ({
            chatworkRoomId: roomId,
            chatworkAccountId: m.accountId,
            name: m.name,
          })),
        )
        .onConflictDoUpdate({
          target: [chatworkRoomMembers.chatworkRoomId, chatworkRoomMembers.chatworkAccountId],
          set: { name: sql`excluded.name`, updatedAt: sql`now()` },
        });
    }

    // 手順3: upsert 後にキャッシュを再 SELECT。upsert で書き込んだ値を権威ある DB 行として読み直す
    // （API レスポンスを in-memory で持ち回らず、再 SELECT で「ヒット時と同じ経路」に合流させる）。
    const refreshed = await selectCachedName(roomId, accountId, deps);
    if (refreshed !== null) return refreshed;

    // 取得できたメンバー一覧に対象 account_id が含まれていなかった（退会済み・別ルーム発信等）。
    // 識別子と op のみで「未解決」の事実を記録し、null を返す（このパスは throw 経由ではないため
    // 外側 catch では拾えない＝専用ログ呼び出しが必要 / 二重ログにはならない）。
    deps.logger.info(
      { op: "forward.sender.unresolved", roomId, accountId },
      "sender name unresolved",
    );
    return null;
  } catch {
    // キャッシュ SELECT / `getRoomMembers` / upsert / 再 SELECT のいずれが throw しても
    // ここで握って null を返し、forwarding を止めない（CON-001）。
    // エラー詳細（メッセージ・スタック・氏名・メンバーリスト・トークン）はログに出さない（NFR-002）。
    deps.logger.info(
      { op: "forward.sender.unresolved", roomId, accountId },
      "sender name unresolved",
    );
    return null;
  }
}

/**
 * `chatwork_room_members` から `(room_id, account_id)` で名前を1行 SELECT する。
 *
 * @param roomId ルーム ID（ブランド型）
 * @param accountId 解決対象の送信者 `account_id`
 * @param deps DB クライアント
 * @returns 行が存在すれば `name`、無ければ `null`
 */
async function selectCachedName(
  roomId: ChatworkRoomId,
  accountId: string,
  deps: ResolveSenderDeps,
): Promise<string | null> {
  const rows = await deps.db.db
    .select({ name: chatworkRoomMembers.name })
    .from(chatworkRoomMembers)
    .where(
      and(
        eq(chatworkRoomMembers.chatworkRoomId, roomId),
        eq(chatworkRoomMembers.chatworkAccountId, accountId),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : row.name;
}
