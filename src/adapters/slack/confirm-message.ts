import { escapeSlackText } from "@/adapters/slack/escape";
import type { SlackBlock, SlackMessage } from "@/adapters/slack/types";

/**
 * ［送信］ボタンの `action_id`（REQ-004）。`/slack/interactions` の分岐キー。マジック文字列を
 * 排除するため名前付き定数にする（coding-rules `[SHOULD]`）。
 */
export const SLACK_ACTION_SEND = "cw_send";

/**
 * ［キャンセル］ボタンの `action_id`（REQ-004）。`/slack/interactions` の分岐キー。
 */
export const SLACK_ACTION_CANCEL = "cw_cancel";

/** 確認メッセージの問いかけ文（固定）。 */
const CONFIRM_PROMPT = "この内容を Chatwork に送信しますか？";
/** ［送信］ボタンのラベル（固定）。 */
const SEND_LABEL = "送信";
/** ［キャンセル］ボタンのラベル（固定）。 */
const CANCEL_LABEL = "キャンセル";

/**
 * 送信確認メッセージの Block Kit ブロックを組み立てる（送信前確認 / REQ-004）。
 *
 * 構成は section（問いかけ + 引用本文）+ actions（［送信］primary /［キャンセル］）。両ボタンの
 * `value` には対象 `outbound_messages.id` を載せ、`/slack/interactions` で対象行を一意に特定する。
 *
 * `quotedBody` は Slack 返信＝外部由来テキストのため、**内部で `escapeSlackText` を適用**してから
 * 引用に埋め込む（`<!channel>` 等の通知インジェクション対策 / NFR-002 / メモリ
 * slack-control-char-escaping）。呼び出し側で二重エスケープしないこと。
 *
 * @param input.quotedBody 確認のために引用表示する返信本文（未エスケープの生テキスト）
 * @param input.outboundId 対象 `outbound_messages.id`（両ボタンの `value`）
 * @returns 確認メッセージの Block 配列
 */
export function buildConfirmBlocks(input: {
  quotedBody: string;
  outboundId: string;
}): SlackBlock[] {
  // 引用本文を Slack の引用記法（行頭 `> `）で表示する。外部由来のためエスケープ必須。
  const escaped = escapeSlackText(input.quotedBody);
  const quoted = escaped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${CONFIRM_PROMPT}\n${quoted}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: SEND_LABEL },
          action_id: SLACK_ACTION_SEND,
          value: input.outboundId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: CANCEL_LABEL },
          action_id: SLACK_ACTION_CANCEL,
          value: input.outboundId,
        },
      ],
    },
  ];
}

/**
 * 送信結果に応じた確認メッセージ更新の種別（`chat.update` の差し替え内容を決める）。
 *
 * いずれも「認可済みかつ状態遷移成功後」の結果表示のみ。未認可押下は共有確認メッセージを更新しない
 * ため、`forbidden` の種別は持たない（未認可押下は識別子ログのみで握る / REQ-006/009）。
 */
export type ResultKind = "sent" | "failed" | "cancelled";

/**
 * 送信結果に応じた更新メッセージ（✅/❌/🚫）を組み立てる（REQ-004 / REQ-006）。
 *
 * ボタン押下後に確認メッセージを `chat.update` で差し替える際の本文。`blocks` は付けない
 * （ボタン除去 = text のみに差し替え）。`switch` は `never` 網羅で将来の種別追加漏れを防ぐ。
 *
 * @param kind 結果種別（`sent` / `failed` / `cancelled`）
 * @returns 差し替え用の `SlackMessage`（`{ text }`）
 */
export function buildResultMessage(kind: ResultKind): SlackMessage {
  switch (kind) {
    case "sent":
      return { text: "✅ 送信しました" };
    case "failed":
      return { text: "❌ 送信に失敗しました。もう一度返信して操作し直してください" };
    case "cancelled":
      return { text: "🚫 キャンセルしました" };
    default: {
      // 網羅性チェック: 新しい kind を追加したらここでコンパイルエラーになる。
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
