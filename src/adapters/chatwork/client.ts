import type { ChatworkRoomId } from "@/adapters/chatwork/types";
import { ROOM_TYPES, type RoomType } from "@/db/schema";

/** Chatwork API のデフォルトベース URL。 */
const DEFAULT_BASE_URL = "https://api.chatwork.com/v2";

/**
 * Chatwork API 呼び出しの失敗を表す（REQ-006）。
 *
 * トークン・レスポンス本文・ルーム名は **保持しない**。操作名と（あれば）HTTP ステータスのみを
 * 持ち、`serializeError` 経由で構造化ログに載せても秘密・本文が漏れないようにする（NFR-003）。
 */
export class ChatworkApiError extends Error {
  /** 失敗した操作名（構造化ログの `op` に対応）。 */
  public readonly op: string;
  /** HTTP ステータスコード。ネットワーク失敗・不正レスポンス時は undefined。 */
  public readonly status: number | undefined;

  /**
   * 失敗した操作名と HTTP ステータスを保持する。
   *
   * @param op 失敗した操作名（例: `chatwork.getRoom`）
   * @param status HTTP ステータスコード（取得できない場合は省略）
   * @returns ChatworkApiError インスタンス
   */
  constructor(op: string, status?: number) {
    super(
      status === undefined
        ? `Chatwork API call failed: ${op}`
        : `Chatwork API call failed: ${op} (status ${status})`,
    );
    this.name = "ChatworkApiError";
    this.op = op;
    this.status = status;
  }
}

/** Chatwork ルームのメタ情報（`getRoom` の戻り値）。 */
export interface ChatworkRoom {
  /** ルーム ID。 */
  roomId: ChatworkRoomId;
  /** ルーム名。 */
  name: string;
  /** ルーム種別（`group` / `direct` / `my`）。 */
  type: RoomType;
}

/** Chatwork API の薄い client。外部 API 依存は adapter 内に閉じる（NFR-004）。 */
export interface ChatworkClient {
  /**
   * ルーム情報を取得する（`GET /rooms/{room_id}`）。
   *
   * @param roomId 取得対象のルーム ID
   * @returns ルームの名前・種別
   * @throws ChatworkApiError 認可エラー・レート制限・ネットワーク失敗・不正レスポンス・
   *   未知のルーム種別時。エラーにはトークン・レスポンス本文を含めない（操作名／ステータスのみ）
   */
  getRoom(roomId: ChatworkRoomId): Promise<ChatworkRoom>;
}

/** `GET /rooms/{room_id}` レスポンスのうち本フェーズで使うフィールドの型ガード入力。 */
function isRoomResponseShape(value: unknown): value is { name: string; type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string" &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

/**
 * レスポンスの `type` 文字列が `ROOM_TYPES` のいずれかであることを検証する。
 *
 * @param type レスポンスの `type` フィールド
 * @returns 既知の種別なら true
 */
function isKnownRoomType(type: string): type is RoomType {
  return (ROOM_TYPES as readonly string[]).includes(type);
}

/**
 * Chatwork API の薄い client を生成する（REQ-006）。
 *
 * `GET {baseUrl}/rooms/{room_id}` を `X-ChatWorkToken` ヘッダ付きで呼び、レスポンスの
 * `{ name, type }` を `ChatworkRoom` にマッピングする。SDK は使わず `fetch` で実装する
 * （overview 指定の薄い自前 client）。`apiToken` は secret adapter 経由で受け取り、ログ・
 * エラーに出さない。
 *
 * @param deps `apiToken`（`CHATWORK_API_TOKEN`。secret adapter 経由）と任意の `baseUrl`
 * @returns `ChatworkClient` 実装
 */
export function createChatworkClient(deps: { apiToken: string; baseUrl?: string }): ChatworkClient {
  const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    async getRoom(roomId: ChatworkRoomId): Promise<ChatworkRoom> {
      const op = "chatwork.getRoom";
      const url = `${baseUrl}/rooms/${encodeURIComponent(roomId)}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { "X-ChatWorkToken": deps.apiToken },
        });
      } catch {
        // ネットワーク失敗。生エラーは握りつぶし、操作名のみを伝える（トークン・URL を漏らさない）。
        throw new ChatworkApiError(op);
      }

      if (!response.ok) {
        // 認可エラー（401/403）・レート制限（429）・サーバエラー等。本文は読まない／含めない。
        throw new ChatworkApiError(op, response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // 2xx だが JSON として解釈できないレスポンス。
        throw new ChatworkApiError(op, response.status);
      }

      if (!isRoomResponseShape(body)) {
        throw new ChatworkApiError(op, response.status);
      }

      if (!isKnownRoomType(body.type)) {
        // 未知の種別はルーティング不能のため失敗扱い。種別文字列自体は秘密ではないが、
        // 本文流出を避けるためエラーには載せない。
        throw new ChatworkApiError(op, response.status);
      }

      return { roomId, name: body.name, type: body.type };
    },
  };
}
