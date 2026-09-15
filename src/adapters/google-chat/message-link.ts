import { z } from "zod";
import { GoogleChatError } from "@/adapters/google-chat/types";

const MessageNameSchema = z
  .string()
  .regex(/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
const ThreadNameSchema = z.string().regex(/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/);

/**
 * Google Chat の画面で元のメッセージを開く URL を作る。
 * @param messageName API の message resource name
 * @param threadName API の thread resource name
 * @returns 同じ space の thread と message を指定する URL
 * @throws GoogleChatError resource name が不正または space が一致しない場合
 */
export function googleChatMessageLink(messageName: string, threadName: string): string {
  if (
    !MessageNameSchema.safeParse(messageName).success ||
    !ThreadNameSchema.safeParse(threadName).success
  ) {
    throw new GoogleChatError("resource_mismatch");
  }
  const messageParts = messageName.split("/");
  const threadParts = threadName.split("/");
  if (messageParts[1] !== threadParts[1]) throw new GoogleChatError("resource_mismatch");
  // API の複合 message ID は thread.message のため末尾を画面の message ID に使う。
  const messageId = messageParts[3]?.split(".").at(-1);
  return `https://chat.google.com/room/${messageParts[1]}/${threadParts[3]}/${messageId}?cls=10`;
}
