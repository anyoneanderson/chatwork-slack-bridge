import type { SlackMessage } from "@/adapters/slack/types";

/**
 * Slack のフォールバック表示用に予約文字をエスケープする。
 * @param text 表示する元の平文
 * @returns 予約文字を置換した文字列
 */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 外部の表示名と本文を、メンションとして解釈されない plain_text ブロックにする。
 * @param text 表示する平文
 * @returns 全文のブロックと長さを制限したフォールバック文
 * @throws Error 表示可能な文字数を超えた場合
 */
export function plainMessage(text: string): SlackMessage {
  // 操作ボタン用の余裕を残し、Slack による本文の切り詰めを避ける。
  if (text.length > 35000) throw new Error("Google Chat Slack display exceeds supported size");
  const blocks = [];
  for (let offset = 0; offset < text.length; offset += 2800) {
    blocks.push({
      type: "section",
      text: { type: "plain_text", text: text.slice(offset, offset + 2800), emoji: false },
    });
  }
  const fallback = escapeSlackText(text);
  return {
    text:
      fallback.length <= 35000
        ? fallback
        : "Google Chat のメッセージです。本文はメッセージの詳細表示で確認してください。",
    blocks,
  };
}

/**
 * 送信先と本文を示し、送信、キャンセル、結果照会のボタンを追加する。
 * @param id 保存済み返信の UUID
 * @param account 送信する Google アカウント
 * @param space 送信先スペースの表示名
 * @param body 確認後に送る平文
 * @returns Slack の送信確認メッセージ
 */
export function confirmationMessage(
  id: string,
  account: string,
  space: string,
  body: string,
): SlackMessage {
  const message = plainMessage(
    `Google Chat に送信しますか？\nスペース: ${space}\n送信アカウント: ${account}\n\n${body}`,
  );
  message.blocks?.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Google Chat に送信" },
        action_id: "gc_send",
        value: id,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "キャンセル" },
        action_id: "gc_cancel",
        value: id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "送信結果を照会" },
        action_id: "gc_check",
        value: id,
      },
    ],
  });
  return message;
}

/**
 * Slack の転送用書式を一度だけ復号し、メンションは API 照会せず ID の文字列にする。
 * @param text Slack イベントの書式付き本文
 * @returns 確認画面と Google Chat 送信に共用する平文
 */
export function slackReplyToPlainText(text: string): string {
  return text
    .replace(/<(https?:\/\/[^>|]+|mailto:[^>|]+)(?:\|[^>]*)?>/g, (_match, target: string) =>
      target.replace(/^mailto:/, ""),
    )
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#([A-Z0-9]+)(?:\|[^>]*)?>/g, "#$1")
    .replace(/<!([^>|]+)(?:\|[^>]*)?>/g, "[$1]")
    .replace(
      /&amp;|&lt;|&gt;/g,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity] ?? entity,
    );
}
