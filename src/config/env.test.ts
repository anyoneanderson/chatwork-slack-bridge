import { describe, expect, it } from "vitest";

import type { SecretKey, SecretProvider } from "@/adapters/secrets/types";
import { ConfigError, loadConfig } from "@/config/env";

function createSecretProvider(values: Partial<Record<SecretKey, string>>): SecretProvider {
  return {
    get(key) {
      return values[key];
    },
  };
}

// forwarding フェーズで必須となった 5 キー。すべて DUMMY 値（CON-005）。
// 実トークン・実チャンネル ID は使わない。
const FORWARDING_REQUIRED: Partial<Record<SecretKey, string>> = {
  CHATWORK_WEBHOOK_TOKEN: "dummy-chatwork-webhook-token",
  CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
  SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
  SLACK_DEFAULT_GROUP_CHANNEL_ID: "C0DUMMYGROUP",
  SLACK_DEFAULT_DM_CHANNEL_ID: "C0DUMMYDM",
};

// 検証が通る最小の有効入力（DATABASE_URL + 必須トークン/チャンネル）。
const VALID_BASE: Partial<Record<SecretKey, string>> = {
  DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
  ...FORWARDING_REQUIRED,
};

describe("loadConfig", () => {
  it("throws ConfigError when DATABASE_URL is missing", () => {
    expect(() => loadConfig(createSecretProvider({}))).toThrow(ConfigError);

    try {
      loadConfig(createSecretProvider({}));
      throw new Error("loadConfig should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      expect(configError.issues).toHaveProperty("DATABASE_URL");
    }
  });

  it("throws ConfigError when fields are type-invalid", () => {
    const invalidDatabaseUrl = "not-a-database-url";
    const invalidPort = "not-a-port";

    try {
      loadConfig(
        createSecretProvider({
          DATABASE_URL: invalidDatabaseUrl,
          PORT: invalidPort,
        }),
      );
      throw new Error("loadConfig should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      const serializedIssues = JSON.stringify(configError.issues);

      expect(configError.issues).toHaveProperty("DATABASE_URL");
      expect(configError.issues).toHaveProperty("PORT");
      expect(serializedIssues).not.toContain(invalidDatabaseUrl);
      expect(serializedIssues).not.toContain(invalidPort);
    }
  });

  it("returns typed Config with defaults when input is valid", () => {
    const config = loadConfig(createSecretProvider({ ...VALID_BASE }));

    expect(config).toEqual({
      DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
      PORT: 3000,
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      DB_HEALTH_TIMEOUT_MS: 2000,
      SECRET_BACKEND: "env",
      DB_POOLED: false,
      CHATWORK_WEBHOOK_TOKEN: "dummy-chatwork-webhook-token",
      CHATWORK_API_TOKEN: "dummy-chatwork-api-token",
      SLACK_BOT_TOKEN: "xoxb-dummy-slack-bot-token",
      SLACK_DEFAULT_GROUP_CHANNEL_ID: "C0DUMMYGROUP",
      SLACK_DEFAULT_DM_CHANNEL_ID: "C0DUMMYDM",
    });
  });

  it("throws ConfigError when SECRET_BACKEND=gcp but reference keys are missing", () => {
    try {
      loadConfig(
        createSecretProvider({
          ...VALID_BASE,
          SECRET_BACKEND: "gcp",
        }),
      );
      throw new Error("loadConfig should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      expect(configError.issues).toHaveProperty("GOOGLE_CLOUD_PROJECT");
      expect(configError.issues).toHaveProperty("DATABASE_URL_SECRET");
    }
  });

  it("returns Config when SECRET_BACKEND=gcp and reference keys are present", () => {
    const config = loadConfig(
      createSecretProvider({
        ...VALID_BASE,
        SECRET_BACKEND: "gcp",
        GOOGLE_CLOUD_PROJECT: "example-project",
        DATABASE_URL_SECRET: "example-database-url-secret",
        DB_POOLED: "true",
      }),
    );

    expect(config.SECRET_BACKEND).toBe("gcp");
    expect(config.DB_POOLED).toBe(true);
  });

  it("succeeds when all forwarding-required keys are present", () => {
    const config = loadConfig(createSecretProvider({ ...VALID_BASE }));

    expect(config.CHATWORK_WEBHOOK_TOKEN).toBe("dummy-chatwork-webhook-token");
    expect(config.CHATWORK_API_TOKEN).toBe("dummy-chatwork-api-token");
    expect(config.SLACK_BOT_TOKEN).toBe("xoxb-dummy-slack-bot-token");
    expect(config.SLACK_DEFAULT_GROUP_CHANNEL_ID).toBe("C0DUMMYGROUP");
    expect(config.SLACK_DEFAULT_DM_CHANNEL_ID).toBe("C0DUMMYDM");
  });

  it.each([
    "CHATWORK_WEBHOOK_TOKEN",
    "CHATWORK_API_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_DEFAULT_GROUP_CHANNEL_ID",
    "SLACK_DEFAULT_DM_CHANNEL_ID",
  ] as const)("throws ConfigError when required key %s is missing", (missingKey) => {
    const values = { ...VALID_BASE };
    delete values[missingKey];

    try {
      loadConfig(createSecretProvider(values));
      throw new Error("loadConfig should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      // ConfigError は欠落キー名のみを保持する。
      expect(configError.issues).toHaveProperty(missingKey);
    }
  });

  it("keeps forwarding secret values out of ConfigError when a value is invalid", () => {
    // 空文字（min(1) 違反）の DUMMY 値。エラーに値が漏れないことを確認する。
    const invalidToken = "";
    try {
      loadConfig(
        createSecretProvider({
          ...VALID_BASE,
          CHATWORK_WEBHOOK_TOKEN: invalidToken,
          SLACK_BOT_TOKEN: invalidToken,
        }),
      );
      throw new Error("loadConfig should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configError = err as ConfigError;
      const serialized = JSON.stringify(configError.issues);
      // キー名は持つが、有効な DUMMY トークン値は含めない（NFR / 秘密非ログ）。
      expect(configError.issues).toHaveProperty("CHATWORK_WEBHOOK_TOKEN");
      expect(configError.issues).toHaveProperty("SLACK_BOT_TOKEN");
      expect(serialized).not.toContain("dummy-chatwork-api-token");
      expect(serialized).not.toContain("xoxb-dummy-slack-bot-token");
    }
  });

  it('coerces DB_POOLED="false" to false (not truthy string coercion)', () => {
    const config = loadConfig(
      createSecretProvider({
        ...VALID_BASE,
        DB_POOLED: "false",
      }),
    );

    expect(config.DB_POOLED).toBe(false);
  });

  it('coerces DB_POOLED="0" to false', () => {
    const config = loadConfig(
      createSecretProvider({
        ...VALID_BASE,
        DB_POOLED: "0",
      }),
    );

    expect(config.DB_POOLED).toBe(false);
  });

  it('coerces DB_POOLED="1" to true', () => {
    const config = loadConfig(
      createSecretProvider({
        ...VALID_BASE,
        DB_POOLED: "1",
      }),
    );

    expect(config.DB_POOLED).toBe(true);
  });

  it("defaults DB_POOLED to false when unset", () => {
    const config = loadConfig(createSecretProvider({ ...VALID_BASE }));

    expect(config.DB_POOLED).toBe(false);
  });
});
