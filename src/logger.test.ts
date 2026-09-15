import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/logger";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns logger with requested level when level is valid", () => {
    const logger = createLogger("debug");

    expect(logger.level).toBe("debug");
  });

  it("redacts secret config keys so values never reach log output", () => {
    // createLogger は既定で process.stdout に書き出すため、write を捕捉して実出力を検証する。
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });

    const logger = createLogger("info");

    // DUMMY 秘密値（実トークン・実シークレットではない / CON-003）。
    const secrets = {
      DATABASE_URL: "postgres://u:dummy-db-pass@localhost:5432/bridge",
      CHATWORK_WEBHOOK_TOKEN: "dummy-chatwork-webhook-token",
      CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
      SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
      SLACK_SIGNING_SECRET: "dummy-slack-signing-secret",
    };

    // 素のキー / config.* / 任意ネスト（*.）の各経路を網羅して検証する。
    logger.info(secrets, "flat keys");
    logger.info({ config: secrets }, "config.* keys");
    logger.info({ nested: secrets }, "*. keys");

    const output = written.join("\n");
    for (const value of Object.values(secrets)) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain("[REDACTED]");
  });
});
