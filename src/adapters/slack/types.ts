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
 * Slack Block Kit のブロック（`chat.postMessage` / `chat.update` の `blocks` 要素 / REQ-008）。
 *
 * `@slack/web-api` は `blocks` を `(KnownBlock | Block)[]` で受け取るが、`@slack/types` は
 * 直接の依存ではなく（transitive）型解決が脆いため、ここでは Slack の Block 基底（`type` を
 * 必須に持つオブジェクト）と互換な最小の構造型として定義する。`confirm-message.ts` が組み立てた
 * ブロックはこの型で `SlackMessage.blocks` に載り、adapter（`client.ts`）が SDK 境界で受け渡す。
 * 任意の Block Kit フィールドを許容するため index signature を持たせる（型安全と SDK 互換のバランス）。
 */
export interface SlackBlock {
  /** ブロック種別（`section` / `actions` など）。Slack の `Block` 基底と同じく必須。 */
  type: string;
  /** 任意の Block Kit フィールド（`text` / `elements` / `block_id` など）。 */
  [key: string]: unknown;
}

/**
 * Slack へ投稿するメッセージのペイロード。
 *
 * `format`（forwarding）の出力は `text` のみで、`SlackClient.postMessage` の引数として共有される。
 * slack-reply 以降の確認 UI 用に `blocks` を**任意**追加する（既存の `{ text }` のみの利用は不変 /
 * REQ-008 / CON-001）。`blocks` 併用時も `text` はフォールバック表示として常に渡す。
 */
export interface SlackMessage {
  /** 投稿本文。ルーム名・送信者・本文を整形した plain text。 */
  text: string;
  /** 確認 UI 等の Block Kit ブロック（任意。未指定なら text のみ / REQ-008）。 */
  blocks?: SlackBlock[];
}

/**
 * Slack へファイルをアップロードする際の入力（attachment-mirror / REQ-003）。
 *
 * `bytes` は呼び出し側の都合で `Uint8Array` を受け取り、adapter 内部で
 * `Buffer.from(bytes)` に変換してから `files.uploadV2` に渡す（`@slack/web-api` の
 * `file` 引数型は `Buffer | Stream | string` で `Uint8Array` 直渡し不可 / ASM-003）。
 * 本フェーズはスレッド添付確定のため `threadTs` を必ず付与する（REQ-005）。
 *
 * `filename`・`bytes` は秘密／本文に準じる扱いとし、エラー・ログには出さない（NFR-002）。
 */
export interface SlackUploadFileInput {
  /** アップロード先チャンネル ID。 */
  channelId: SlackChannelId;
  /** 本文投稿の `ts`（この ts のスレッドにファイルを添付する）。 */
  threadTs: SlackTs;
  /** アップロードするファイル名（ログ非出力）。 */
  filename: string;
  /** Chatwork 由来の MIME タイプ（取得できなければ null）。 */
  mimeType: string | null;
  /** ファイル本体のバイト列（ログ非出力。adapter 内で `Buffer.from` に変換）。 */
  bytes: Uint8Array;
}
