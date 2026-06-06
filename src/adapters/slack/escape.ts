/**
 * Slack のテキストに載せる前に、信頼できない外部テキストの制御文字をエスケープする。
 *
 * Chatwork メッセージ本文・ルーム名・送信者は外部（任意ユーザー）由来のため、`<!channel>` /
 * `<!here>` / `<!everyone>` / `<@U…>` 等の Slack 制御シーケンスがそのまま投稿先チャンネルで
 * 一斉メンション（broadcast）やメンションとして解釈されるのを防ぐ（通知インジェクション対策）。
 * Slack 推奨どおり `&` → `<` → `>` の順で置換する（`&` を最初に処理しないと、後続置換で生じた
 * `&amp;` 等の `&` を多重エスケープしてしまうため）。
 *
 * `format.ts`（forwarding の投稿整形）と `confirm-message.ts`（送信確認 UI の引用本文）の双方が
 * 同一のエスケープを共有するため adapter 共通モジュールに切り出している（DRY / design §4.3, §6）。
 *
 * @param value エスケープ対象の信頼できないテキスト
 * @returns Slack 制御シーケンスを無効化したテキスト
 */
export function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
