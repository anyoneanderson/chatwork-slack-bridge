import { describe, expect, it } from "vitest";

import { chatworkMessageUrl } from "@/adapters/chatwork/message-link";

// 注意: テスト本文に実 room/message ID は含めない（CON-002 / ダミー値のみ）。

describe("chatworkMessageUrl", () => {
  it("returns the deep link in the form '#!rid{room}-{message}'", () => {
    // Arrange
    const roomId = "2002";
    const messageId = "msg-3003";

    // Act
    const url = chatworkMessageUrl(roomId, messageId);

    // Assert
    expect(url).toBe("https://www.chatwork.com/#!rid2002-msg-3003");
  });

  it("interpolates other dummy inputs verbatim (no encoding applied)", () => {
    // Arrange
    const roomId = "100";
    const messageId = "999";

    // Act
    const url = chatworkMessageUrl(roomId, messageId);

    // Assert
    expect(url).toBe("https://www.chatwork.com/#!rid100-999");
  });

  it("is pure: identical inputs yield identical outputs", () => {
    // Arrange
    const roomId = "42";
    const messageId = "7";

    // Act
    const first = chatworkMessageUrl(roomId, messageId);
    const second = chatworkMessageUrl(roomId, messageId);

    // Assert
    expect(first).toBe(second);
  });
});
