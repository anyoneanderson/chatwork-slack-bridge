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
    const config = loadConfig(
      createSecretProvider({
        DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
      }),
    );

    expect(config).toEqual({
      DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
      PORT: 3000,
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      DB_HEALTH_TIMEOUT_MS: 2000,
    });
  });
});
