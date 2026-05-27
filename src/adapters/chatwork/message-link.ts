/** Chatwork の特定メッセージを開くディープリンクを生成する。 */
export function chatworkMessageUrl(roomId: string, messageId: string): string {
  return `https://www.chatwork.com/#!rid${roomId}-${messageId}`;
}
