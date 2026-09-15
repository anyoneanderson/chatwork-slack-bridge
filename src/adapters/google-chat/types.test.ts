import { describe, expect, it } from "vitest";
import { GOOGLE_CHAT_ERROR_CODES, GoogleChatError } from "@/adapters/google-chat/types";

describe("GoogleChatError", () => {
  it.each(GOOGLE_CHAT_ERROR_CODES)("exposes a fixed classification for %s", (code) => {
    const error = new GoogleChatError(code, 403);
    expect(error.message).toBe(`Google Chat request failed: ${code}`);
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(code === "rate_limited" || code === "unavailable");
    expect(error.cause).toBeUndefined();
  });
});
