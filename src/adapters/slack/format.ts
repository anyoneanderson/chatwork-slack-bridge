import { chatworkMessageUrl } from "@/adapters/chatwork/message-link";
import { renderChatworkBody } from "@/adapters/chatwork/render-body";
import { escapeSlackText } from "@/adapters/slack/escape";
import type { SlackMessage } from "@/adapters/slack/types";

/**
 * Slack 投稿の整形に必要なメッセージフィールド。
 *
 * DB 行全体ではなく整形に必要な最小限のみを受け取る（疎結合・テスト容易性）。
 * 送信者名（`senderName`）は別途解決済み（`app/services/resolve-sender.ts`）。表示は
 * 「表示名 → account_id → unknown」の優先順でフォールバックする（REQ-005）。
 * `roomId` / `messageId` は Chatwork メッセージへのディープリンク生成に使う（REQ-006）。
 */
export interface FormatMessageInput {
  /** 送信者の Chatwork アカウント ID。payload の `account_id`。null 可（取得できない場合）。 */
  accountId: string | null;
  /** 解決済みの送信者表示名。解決できなければ null（accountId にフォールバック）。 */
  senderName: string | null;
  /** メッセージ本文（Chatwork 記法を含みうる。format 内で `renderChatworkBody` を適用する）。 */
  body: string;
  /** メッセージが属する Chatwork ルームの ID（ディープリンク用）。 */
  roomId: string;
  /** Chatwork メッセージ ID（ディープリンク用）。 */
  messageId: string;
}

/**
 * Slack 投稿の整形に必要なルームのメタ情報。
 */
export interface FormatRoomInput {
  /** ルーム名（Chatwork API で取得しキャッシュした `room_name`）。 */
  name: string;
}

/** 送信者 ID も表示名も無い場合の最終フォールバックラベル。 */
const UNKNOWN_SENDER_LABEL = "unknown";

/** Chatwork メッセージへのディープリンクに付けるラベル（固定文字列）。 */
const CHATWORK_LINK_LABEL = "Chatworkで開く";

/**
 * `escapeSlackText` 後の本文について、**各行の行頭**にある `&gt; ` を `> ` に戻す。
 *
 * `renderChatworkBody` は `[qt]…[/qt]` を Slack 引用記法（行頭 `> `）に変換するが、その後の
 * `escapeSlackText` で `>` が `&gt;` 化されると Slack 側で引用ブロックとして解釈されなくなる
 * （引用が壊れる）。一方で、本文中（行の途中）に現れた `>` は外部由来の文字としてエスケープを
 * 維持しなければならない（メンション/制御シーケンス対策）。
 *
 * そのため「行頭の `&gt; ` のみ」復元するこの後処理を入れる。`m` フラグの `^` で各行の先頭に
 * マッチさせ、行中の `&gt;` には触れない。
 *
 * @param escaped `escapeSlackText` 適用済みの本文
 * @returns 引用行頭の `> ` を復元したテキスト
 */
function restoreLeadingQuoteMarkers(escaped: string): string {
  return escaped.replace(/^&gt; /gm, "> ");
}

/**
 * Chatwork メッセージを Slack 投稿用のテキストに整形する（REQ-005 / 006 / 007 / 設計 §4.5）。
 *
 * 出力は 4 行構成の `text`:
 * ```
 * [Chatwork] <ルーム名>
 * <送信者>:
 * <本文（Chatwork 記法を Slack 向けに整形済み）>
 * <Chatworkメッセージへのリンク>
 * ```
 *
 * 送信者の表示優先順は `senderName ?? accountId ?? "unknown"`。本文は `renderChatworkBody` で
 * Chatwork 記法（絵文字ショートコード / `[info]` `[qt]` `[download]` …）を可読テキストへ変換
 * してから `escapeSlackText` を適用し、最後に **引用行頭 `&gt; ` のみ `> ` に復元**して Slack の
 * 引用ブロックを壊さないようにする（行中の `>` はエスケープのまま維持。設計 §4.5 参照）。
 *
 * リンクは bridge が組み立てる信頼値（`roomId` / `messageId` は DB 由来で秘密ではない）のため、
 * URL もラベル `Chatworkで開く` もエスケープしない（mrkdwn の `<…|…>` を成立させるため）。
 * 固定ラベル `[Chatwork] ` や区切り（`\n` / `:`）もエスケープしない。
 *
 * **アクションボタンは含めない**（本フェーズは本文＋メタの表示のみ。Block Kit の action
 * 要素は出さない）。本文・ルーム名・氏名は Slack 投稿先（信頼境界内）には載るが、ログには
 * 出さない（NFR-002）。整形結果は `SlackClient.postMessage` がそのまま受け取れる `SlackMessage`。
 *
 * @param message 送信者情報・本文・リンク生成に必要な ID（整形に必要な最小限のフィールド）
 * @param room ルームのメタ情報（ルーム名）
 * @returns Slack へ投稿する `SlackMessage`（`{ text }`）
 */
export function format(message: FormatMessageInput, room: FormatRoomInput): SlackMessage {
  const sender = escapeSlackText(message.senderName ?? message.accountId ?? UNKNOWN_SENDER_LABEL);
  const roomName = escapeSlackText(room.name);
  const renderedBody = restoreLeadingQuoteMarkers(
    escapeSlackText(renderChatworkBody(message.body)),
  );
  const link = chatworkMessageUrl(message.roomId, message.messageId);
  const text =
    `[Chatwork] ${roomName}\n` +
    `${sender}:\n` +
    `${renderedBody}\n` +
    `<${link}|${CHATWORK_LINK_LABEL}>`;
  return { text };
}
