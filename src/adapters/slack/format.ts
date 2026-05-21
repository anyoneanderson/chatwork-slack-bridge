import type { SlackMessage } from "@/adapters/slack/types";

/**
 * Slack 投稿の整形に必要なメッセージフィールド。
 *
 * DB 行全体ではなく整形に必要な最小限のみを受け取る（疎結合・テスト容易性）。
 * 送信者名（`sender_name`）は webhook payload に含まれないため、本フェーズは送信者 ID
 * （`account_id`）ベースで表示する（ASM-002 / REQ-005）。
 */
export interface FormatMessageInput {
  /** 送信者の Chatwork アカウント ID。payload の `account_id`。null 可（取得できない場合）。 */
  accountId: string | null;
  /** メッセージ本文。 */
  body: string;
}

/**
 * Slack 投稿の整形に必要なルームのメタ情報。
 */
export interface FormatRoomInput {
  /** ルーム名（Chatwork API で取得しキャッシュした `room_name`）。 */
  name: string;
}

/** 送信者 ID が不明な場合の表示ラベル。 */
const UNKNOWN_SENDER_LABEL = "unknown";

/**
 * Slack のテキストに載せる前に、信頼できない外部テキストの制御文字をエスケープする。
 *
 * Chatwork メッセージ本文・ルーム名・送信者は外部（任意ユーザー）由来のため、`<!channel>` /
 * `<!here>` / `<!everyone>` / `<@U…>` 等の Slack 制御シーケンスがそのまま投稿先チャンネルで
 * 一斉メンション（broadcast）やメンションとして解釈されるのを防ぐ（通知インジェクション対策）。
 * Slack 推奨どおり `&` → `<` → `>` の順で置換する（`&` を最初に処理しないと、後続置換で生じた
 * `&amp;` 等の `&` を多重エスケープしてしまうため）。
 *
 * @param value エスケープ対象の信頼できないテキスト
 * @returns Slack 制御シーケンスを無効化したテキスト
 */
function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Chatwork メッセージを Slack 投稿用のテキストに整形する（REQ-008 / 設計 §4.7）。
 *
 * overview の表示例に倣い、`[Chatwork] <ルーム名>` のヘッダ・送信者・本文を組み立てる。
 * **アクションボタンは含めない**（本フェーズは本文＋メタの表示のみ。Block Kit の action
 * 要素は出さない）。本文・ルーム名は Slack 投稿先（信頼境界内）には載るが、ログには出さない
 * （NFR-003）。整形結果は `SlackClient.postMessage` がそのまま受け取れる `SlackMessage`。
 *
 * 外部由来の値（本文・ルーム名・送信者）は `escapeSlackText` でエスケープしてから合成する
 * （Slack 制御シーケンス / メンションインジェクション対策）。固定ラベルや区切り文字はエスケープしない。
 *
 * @param message 送信者 ID・本文（整形に必要な最小限のメッセージフィールド）
 * @param room ルームのメタ情報（ルーム名）
 * @returns Slack へ投稿する `SlackMessage`（`{ text }`）
 */
export function format(message: FormatMessageInput, room: FormatRoomInput): SlackMessage {
  const sender = escapeSlackText(message.accountId ?? UNKNOWN_SENDER_LABEL);
  const roomName = escapeSlackText(room.name);
  const body = escapeSlackText(message.body);
  const text = `[Chatwork] ${roomName}\n${sender}:\n${body}`;
  return { text };
}
