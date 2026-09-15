import { describe, expect, it, vi } from "vitest";

import type { SecretKey, SecretProvider } from "@/adapters/secrets/types";
import { GoogleChatConfigError, loadGoogleChatConfig } from "@/config/google-chat";

const VALID: Record<string, string> = {
  GOOGLE_CHAT_ENABLED: "true",
  GOOGLE_CHAT_ACCOUNT_EMAIL: "Dummy@Example.test",
  GOOGLE_CHAT_SPACE_NAME: "spaces/DUMMYSPACE",
  GOOGLE_CHAT_SPACE_DISPLAY_NAME: "Dummy space",
  GOOGLE_CHAT_SLACK_CHANNEL_ID: "C0DUMMYCHAT",
  GOOGLE_CHAT_START_TIME: "2026-01-01T00:00:00Z",
  GOOGLE_CHAT_CREDENTIALS: JSON.stringify({
    client_id: "dummy-client",
    client_secret: "dummy-secret",
    refresh_token: "dummy-refresh",
  }),
};
function provider(values: Record<string, string | undefined>): SecretProvider {
  return { get: vi.fn((key: SecretKey) => values[key]) };
}

describe("Google Chat sender name configuration", () => {
  function withSenderNames(senderNames: unknown) {
    return provider({
      ...VALID,
      GOOGLE_CHAT_CREDENTIALS: JSON.stringify({
        client_id: "dummy-client",
        client_secret: "dummy-secret",
        refresh_token: "dummy-refresh",
        sender_names: senderNames,
      }),
    });
  }

  it("loads trimmed sender names keyed by exact Google user resources", () => {
    expect(
      loadGoogleChatConfig(withSenderNames({ "users/DUMMY_1-2": "  Dummy sender  " }))?.credentials
        .senderNames,
    ).toEqual({ "users/DUMMY_1-2": "Dummy sender" });
  });

  it("keeps sender names optional for existing credentials", () => {
    expect(loadGoogleChatConfig(provider(VALID))?.credentials.senderNames).toBeUndefined();
  });

  it("accepts a sender display name at the 200 character boundary", () => {
    const name = "a".repeat(200);
    expect(
      loadGoogleChatConfig(withSenderNames({ "users/DUMMY": name }))?.credentials.senderNames,
    ).toEqual({ "users/DUMMY": name });
  });

  it.each([
    null,
    [],
    { DUMMY: "Dummy sender" },
    { "users/DUMMY/extra": "Dummy sender" },
    { "users/..": "Dummy sender" },
    { "users/DUMMY?value=1": "Dummy sender" },
    { "users/DUMMY": "   " },
    { "users/DUMMY": "a".repeat(201) },
    { "users/DUMMY": 123 },
  ])("rejects malformed sender mapping without exposing its content", (mapping) => {
    try {
      loadGoogleChatConfig(withSenderNames(mapping));
      expect.fail("expected sender name configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleChatConfigError);
      expect((error as Error).message).toBe("Invalid Google Chat configuration");
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain("Dummy sender");
      expect(serialized).not.toContain("dummy-secret");
      expect(serialized).not.toContain("dummy-refresh");
    }
  });
});

describe("loadGoogleChatConfig", () => {
  it.each([
    undefined,
    "false",
    "0",
  ])("leaves legacy startup untouched when enabled is %s", (enabled) => {
    const secrets = provider({ GOOGLE_CHAT_ENABLED: enabled, GOOGLE_CHAT_CREDENTIALS: "invalid" });
    expect(loadGoogleChatConfig(secrets)).toBeUndefined();
    expect(secrets.get).toHaveBeenCalledTimes(1);
    expect(secrets.get).toHaveBeenCalledWith("GOOGLE_CHAT_ENABLED");
  });

  it("normalizes the account and explicit reply allowlist when enabled", () => {
    expect(
      loadGoogleChatConfig(
        provider({ ...VALID, GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS: " U0DUMMY , ,W0DUMMY " }),
      ),
    ).toEqual({
      accountEmail: "dummy@example.test",
      spaceName: "spaces/DUMMYSPACE",
      spaceDisplayName: "Dummy space",
      slackChannelId: "C0DUMMYCHAT",
      startTime: "2026-01-01T00:00:00Z",
      pollIntervalMs: 60000,
      pollMode: "timer",
      allowedReplyUserIds: ["U0DUMMY", "W0DUMMY"],
      credentials: {
        clientId: "dummy-client",
        clientSecret: "dummy-secret",
        refreshToken: "dummy-refresh",
      },
    });
  });

  it("defaults replies to an empty allowlist when none is configured", () => {
    expect(loadGoogleChatConfig(provider(VALID))?.allowedReplyUserIds).toEqual([]);
  });

  it.each([
    ["GOOGLE_CHAT_ENABLED", "yes"],
    ["GOOGLE_CHAT_ACCOUNT_EMAIL", "invalid"],
    ["GOOGLE_CHAT_SPACE_NAME", "spaces/DUMMY/../../other"],
    ["GOOGLE_CHAT_SPACE_DISPLAY_NAME", " "],
    ["GOOGLE_CHAT_SLACK_CHANNEL_ID", "https://example.test"],
    ["GOOGLE_CHAT_START_TIME", "yesterday"],
    ["GOOGLE_CHAT_POLL_INTERVAL_MS", "9999"],
    ["GOOGLE_CHAT_POLL_INTERVAL_MS", "2147483648"],
    ["GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS", "everyone"],
    ["GOOGLE_CHAT_CREDENTIALS", "{secret-bait"],
    ["GOOGLE_CHAT_CREDENTIALS", '{"client_id":"dummy"}'],
  ])("rejects invalid %s without echoing its value", (key, value) => {
    try {
      loadGoogleChatConfig(provider({ ...VALID, [key]: value }));
      expect.fail("expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleChatConfigError);
      expect((error as Error).message).toBe("Invalid Google Chat configuration");
      expect(JSON.stringify(error)).not.toContain("dummy-secret");
      expect(JSON.stringify(error)).not.toContain("dummy-refresh");
    }
  });

  it.each(
    Object.keys(VALID).filter((key) => key !== "GOOGLE_CHAT_ENABLED"),
  )("rejects missing %s when enabled", (key) => {
    expect(() => loadGoogleChatConfig(provider({ ...VALID, [key]: undefined }))).toThrow(
      GoogleChatConfigError,
    );
  });
});

describe("Google Chat configuration diagnostics", () => {
  it.each([
    "GOOGLE_CHAT_ACCOUNT_EMAIL",
    "GOOGLE_CHAT_SPACE_NAME",
    "GOOGLE_CHAT_SLACK_CHANNEL_ID",
    "GOOGLE_CHAT_START_TIME",
    "GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS",
    "GOOGLE_CHAT_ENABLED",
    "GOOGLE_CHAT_CREDENTIALS",
  ])("reports only the field and validation code for %s", (field) => {
    let failure: unknown;
    try {
      loadGoogleChatConfig(provider({ ...VALID, [field]: "PRIVATE_CONFIG_VALUE" }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GoogleChatConfigError);
    expect(failure).toMatchObject({ issues: [{ field, code: expect.any(String) }] });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_CONFIG_VALUE");
  });
  it("does not expose a sender mapping key or value through nested Zod issues", () => {
    let failure: unknown;
    try {
      loadGoogleChatConfig(
        provider({
          ...VALID,
          GOOGLE_CHAT_CREDENTIALS: JSON.stringify({
            client_id: "PRIVATE_CLIENT",
            client_secret: "PRIVATE_SECRET",
            refresh_token: "PRIVATE_REFRESH",
            sender_names: { "users/PRIVATE_ID/invalid": "PRIVATE_NAME" },
          }),
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GoogleChatConfigError);
    expect(failure).toMatchObject({
      issues: [{ field: "GOOGLE_CHAT_CREDENTIALS", code: expect.any(String) }],
    });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_");
  });
});

describe("Google Chat polling mode", () => {
  const token = "dummy-poll-token-".repeat(3);

  it("defaults to the portable timer without requiring an invocation token", () => {
    expect(loadGoogleChatConfig(provider(VALID))).toMatchObject({ pollMode: "timer" });
  });

  it.each([
    "",
    "invalid stale placeholder",
  ])("ignores unused token placeholders in timer mode", (value) => {
    const secrets = provider({ ...VALID, GOOGLE_CHAT_POLL_TOKEN: value });
    expect(loadGoogleChatConfig(secrets)).toMatchObject({ pollMode: "timer" });
    expect(secrets.get).not.toHaveBeenCalledWith("GOOGLE_CHAT_POLL_TOKEN");
  });

  it("loads the external invocation token through the secret provider", () => {
    const secrets = provider({
      ...VALID,
      GOOGLE_CHAT_POLL_MODE: "external",
      GOOGLE_CHAT_POLL_TOKEN: token,
    });
    expect(loadGoogleChatConfig(secrets)).toMatchObject({ pollMode: "external", pollToken: token });
    expect(secrets.get).toHaveBeenCalledWith("GOOGLE_CHAT_POLL_TOKEN");
  });

  it.each([
    undefined,
    "",
    "short",
    "x".repeat(257),
    "private token ".repeat(4),
    "秘密".repeat(32),
  ])("rejects external mode with an unusable token without exposing its value", (value) => {
    let failure: unknown;
    try {
      loadGoogleChatConfig(
        provider({ ...VALID, GOOGLE_CHAT_POLL_MODE: "external", GOOGLE_CHAT_POLL_TOKEN: value }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GoogleChatConfigError);
    expect(failure).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "GOOGLE_CHAT_POLL_TOKEN" }),
      ]),
    });
    expect(JSON.stringify(failure)).not.toContain("private token");
    expect(JSON.stringify(failure)).not.toContain("dummy-secret");
  });

  it("rejects an unknown mode instead of starting a timer accidentally", () => {
    expect(() =>
      loadGoogleChatConfig(provider({ ...VALID, GOOGLE_CHAT_POLL_MODE: "cron" })),
    ).toThrow(GoogleChatConfigError);
  });
});
