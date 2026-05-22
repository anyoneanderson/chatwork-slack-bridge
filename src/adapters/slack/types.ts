declare const slackChannelIdBrand: unique symbol;
declare const slackTsBrand: unique symbol;

/**
 * Slack チャンネル ID のブランド型。
 *
 * 素の `string` や `ChatworkRoomId` 等との取り違えをコンパイル時に防ぐ。
 * 値は `chat.postMessage` の `channel` 引数や `chatwork_messages.slack_channel_id` 列に対応する。
 */
export type SlackChannelId = string & { readonly [slackChannelIdBrand]: true };

/**
 * Slack メッセージのタイムスタンプ（`ts`）のブランド型。
 *
 * `chat.postMessage` の戻り値 `ts` と `chatwork_messages.slack_ts` 列に対応する。
 * チャンネル ID との取り違えを型で防ぐ。
 */
export type SlackTs = string & { readonly [slackTsBrand]: true };

/**
 * 文字列を `SlackChannelId` ブランド型に変換する。
 *
 * @param value チャンネル ID 文字列（config / DB 由来）
 * @returns ブランド付きの `SlackChannelId`
 */
export function toSlackChannelId(value: string): SlackChannelId {
  return value as SlackChannelId;
}

/**
 * 文字列を `SlackTs` ブランド型に変換する。
 *
 * @param value Slack の `ts` 文字列
 * @returns ブランド付きの `SlackTs`
 */
export function toSlackTs(value: string): SlackTs {
  return value as SlackTs;
}

/**
 * Slack へ投稿するメッセージのペイロード。
 *
 * 本フェーズ（forwarding）は本文＋メタを `text` として組み立てたトップレベル投稿のみで、
 * アクションボタン（Block Kit action elements）は含めない（REQ-008 / 設計 §4.7）。
 * `format` の出力がそのまま `SlackClient.postMessage` の引数になるよう、両者で共有する。
 */
export interface SlackMessage {
  /** 投稿本文。ルーム名・送信者・本文を整形した plain text。 */
  text: string;
}
