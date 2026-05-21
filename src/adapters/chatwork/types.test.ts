import { describe, expect, it } from "vitest";

import {
  CHATWORK_EVENT_TYPES,
  ROOM_TYPES,
  toChatworkMessageId,
  toChatworkRoomId,
} from "@/adapters/chatwork/types";

// DUMMY 値（実 ID を含まない / CON-005）。
const DUMMY_ROOM_ID = "200";
const DUMMY_MESSAGE_ID = "1000000000000000000";

describe("chatwork types", () => {
  it("brands a room id without altering the underlying string value", () => {
    // Act
    const roomId = toChatworkRoomId(DUMMY_ROOM_ID);

    // Assert: ブランド付与は実行時には恒等であり、元の文字列値を保つ。
    expect(roomId).toBe(DUMMY_ROOM_ID);
  });

  it("brands a message id without altering the underlying string value", () => {
    // Act
    const messageId = toChatworkMessageId(DUMMY_MESSAGE_ID);

    // Assert
    expect(messageId).toBe(DUMMY_MESSAGE_ID);
  });

  it("declares message_created as a target event type and re-exports room types from the schema", () => {
    // Assert: イベント種別・ルーム種別が単一の出典から提供されることを確認する。
    expect(CHATWORK_EVENT_TYPES).toContain("message_created");
    expect(ROOM_TYPES).toEqual(["group", "direct", "my"]);
  });
});
