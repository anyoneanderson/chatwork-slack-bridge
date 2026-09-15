import { describe, expect, it } from "vitest";
import { googleChatMessageLink } from "@/adapters/google-chat/message-link";

describe("googleChatMessageLink", () => {
  it("keeps the configured space and thread when linking a compound message ID", () => {
    expect(
      googleChatMessageLink("spaces/DUMMY/messages/THREAD.MESSAGE", "spaces/DUMMY/threads/THREAD"),
    ).toBe("https://chat.google.com/room/DUMMY/THREAD/MESSAGE?cls=10");
  });
  it.each([
    ["spaces/OTHER/messages/MESSAGE", "spaces/DUMMY/threads/THREAD"],
    ["spaces/DUMMY/messages/..", "spaces/DUMMY/threads/THREAD"],
    ["spaces/DUMMY/messages/MESSAGE", "spaces/DUMMY/threads/.."],
    ["spaces/DUMMY/messages/MESSAGE?secret=1", "spaces/DUMMY/threads/THREAD"],
    ["https://example.test/MESSAGE", "spaces/DUMMY/threads/THREAD"],
  ])("rejects invalid or mismatched link resources", (message, thread) => {
    expect(() => googleChatMessageLink(message, thread)).toThrow("resource_mismatch");
  });
});
