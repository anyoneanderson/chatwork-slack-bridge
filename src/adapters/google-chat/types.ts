import { z } from "zod";

export const GoogleChatMessageSchema = z.object({
  name: z.string(),
  threadName: z.string(),
  createTime: z.string().datetime({ offset: true }),
  text: z.string(),
  senderName: z.string(),
  senderId: z.string(),
  clientAssignedMessageId: z.string().optional(),
});
export type GoogleChatMessage = z.infer<typeof GoogleChatMessageSchema>;

export const GOOGLE_CHAT_ERROR_CODES = [
  "auth_revoked",
  "account_mismatch",
  "forbidden",
  "not_found",
  "rate_limited",
  "conflict",
  "unavailable",
  "invalid_response",
  "resource_mismatch",
  "invalid_input",
] as const;
export type GoogleChatErrorCode = (typeof GOOGLE_CHAT_ERROR_CODES)[number];

/** 外部応答や秘密を保持せず、再認証・再試行の判断に必要な分類のみを渡す。 */
export class GoogleChatError extends Error {
  /**
   * @param code 固定のエラー分類
   * @param status HTTP status（応答がある場合）
   * @returns 安全なエラー
   */
  constructor(
    public readonly code: GoogleChatErrorCode,
    public readonly status?: number,
  ) {
    super(`Google Chat request failed: ${code}`);
    this.name = "GoogleChatError";
  }

  /** 再試行できる読み取り失敗か。送信には自動再試行を適用しない。 */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable";
  }
}

export interface GoogleChatClient {
  /**
   * @param input 境界時刻と継続 token
   * @returns 指定 space の検証済みメッセージ
   * @throws GoogleChatError 認証・通信・検証失敗
   */
  listMessages(input: { after: string; before: string; pageToken?: string }): Promise<{
    messages: GoogleChatMessage[];
    nextPageToken?: string;
  }>;
  /**
   * @param input 確認済み返信と永続化した冪等 ID
   * @returns 作成済みメッセージ
   * @throws GoogleChatError 成否不明の場合も自動再送しない
   */
  createReply(input: {
    threadName: string;
    text: string;
    messageId: string;
    requestId: string;
  }): Promise<GoogleChatMessage>;
  /**
   * @param messageId custom ID または message resource name
   * @returns メッセージ。404 は undefined
   * @throws GoogleChatError 認証・通信・検証失敗
   */
  getMessage(messageId: string): Promise<GoogleChatMessage | undefined>;
}
