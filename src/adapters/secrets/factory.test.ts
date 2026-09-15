import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";
import { createSecretProvider, SecretConfigError } from "@/adapters/secrets/factory";

// gcp backend のテストでは Secret Manager へ実アクセスしないよう provider を差し替える。
const createGcpSecretProviderMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/secrets/gcp-secret-provider", () => ({
  createGcpSecretProvider: createGcpSecretProviderMock,
}));

const ENV_KEYS = [
  "SECRET_BACKEND",
  "GOOGLE_CLOUD_PROJECT",
  "DATABASE_URL_SECRET",
  "CHATWORK_WEBHOOK_TOKEN_SECRET",
  "CHATWORK_API_TOKEN_SECRET",
  "SLACK_BOT_TOKEN_SECRET",
  "SLACK_SIGNING_SECRET_SECRET",
] as const;
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

// gcp backend で必須の Secret Manager シークレット名（DUMMY 値 / CON-005）。
// シークレット名であり秘密の実値ではないが、実プロビジョニング名は使わない。
const GCP_SECRET_NAME_ENV = {
  GOOGLE_CLOUD_PROJECT: "example-project",
  DATABASE_URL_SECRET: "example-database-url-secret",
  CHATWORK_WEBHOOK_TOKEN_SECRET: "example-chatwork-webhook-token-secret",
  CHATWORK_API_TOKEN_SECRET: "example-chatwork-api-token-secret",
  SLACK_BOT_TOKEN_SECRET: "example-slack-bot-token-secret",
  SLACK_SIGNING_SECRET_SECRET: "example-slack-signing-secret-secret",
} as const;

/** gcp backend で必須の参照キーを全て process.env に設定する。 */
function setAllGcpReferenceEnv() {
  process.env.SECRET_BACKEND = "gcp";
  for (const [key, value] of Object.entries(GCP_SECRET_NAME_ENV)) {
    process.env[key] = value;
  }
}

beforeEach(() => {
  createGcpSecretProviderMock.mockReset();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createSecretProvider", () => {
  it("returns EnvSecretProvider when SECRET_BACKEND is unset", async () => {
    const provider = await createSecretProvider();

    expect(provider).toBeInstanceOf(EnvSecretProvider);
    expect(createGcpSecretProviderMock).not.toHaveBeenCalled();
  });

  it("returns EnvSecretProvider when SECRET_BACKEND=env", async () => {
    process.env.SECRET_BACKEND = "env";

    const provider = await createSecretProvider();

    expect(provider).toBeInstanceOf(EnvSecretProvider);
  });

  it("throws SecretConfigError listing all reference keys when SECRET_BACKEND=gcp and all are missing", async () => {
    process.env.SECRET_BACKEND = "gcp";

    await expect(createSecretProvider()).rejects.toBeInstanceOf(SecretConfigError);

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      // forwarding フェーズで Secret Manager シークレット名 3 種が必須に追加された。
      expect(configError.missingKeys).toEqual([
        "GOOGLE_CLOUD_PROJECT",
        "DATABASE_URL_SECRET",
        "CHATWORK_WEBHOOK_TOKEN_SECRET",
        "CHATWORK_API_TOKEN_SECRET",
        "SLACK_BOT_TOKEN_SECRET",
        "SLACK_SIGNING_SECRET_SECRET",
      ]);
    }
    expect(createGcpSecretProviderMock).not.toHaveBeenCalled();
  });

  it("throws SecretConfigError naming only GOOGLE_CLOUD_PROJECT when it is the sole missing key", async () => {
    setAllGcpReferenceEnv();
    delete process.env.GOOGLE_CLOUD_PROJECT;

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      expect(configError.missingKeys).toEqual(["GOOGLE_CLOUD_PROJECT"]);
    }
  });

  it.each([
    "DATABASE_URL_SECRET",
    "CHATWORK_WEBHOOK_TOKEN_SECRET",
    "CHATWORK_API_TOKEN_SECRET",
    "SLACK_BOT_TOKEN_SECRET",
    "SLACK_SIGNING_SECRET_SECRET",
  ] as const)("throws SecretConfigError naming only %s when it is the sole missing forwarding secret key", async (missingKey) => {
    setAllGcpReferenceEnv();
    delete process.env[missingKey];

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      expect(configError.missingKeys).toEqual([missingKey]);
    }
    expect(createGcpSecretProviderMock).not.toHaveBeenCalled();
  });

  it("keeps reference values out of the error message", async () => {
    process.env.SECRET_BACKEND = "gcp";

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      const configError = err as SecretConfigError;
      // メッセージはキー名のみ。実値（プロジェクト ID・シークレット名）は含めない。
      expect(configError.message).toContain("GOOGLE_CLOUD_PROJECT");
      expect(configError.message).toContain("DATABASE_URL_SECRET");
      expect(configError.message).toContain("CHATWORK_WEBHOOK_TOKEN_SECRET");
      expect(configError.message).toContain("SLACK_BOT_TOKEN_SECRET");
      expect(configError.message).toContain("SLACK_SIGNING_SECRET_SECRET");
      // どのシークレット名の実値も含めない。
      for (const value of Object.values(GCP_SECRET_NAME_ENV)) {
        expect(configError.message).not.toContain(value);
      }
    }
  });

  it("delegates to createGcpSecretProvider with all configured secret names when SECRET_BACKEND=gcp", async () => {
    setAllGcpReferenceEnv();
    const expectedProvider = { get: vi.fn() };
    createGcpSecretProviderMock.mockResolvedValue(expectedProvider);

    const provider = await createSecretProvider();

    expect(provider).toBe(expectedProvider);
    expect(createGcpSecretProviderMock).toHaveBeenCalledWith({
      projectId: "example-project",
      secretNames: {
        DATABASE_URL: "example-database-url-secret",
        CHATWORK_WEBHOOK_TOKEN: "example-chatwork-webhook-token-secret",
        CHATWORK_API_TOKEN: "example-chatwork-api-token-secret",
        SLACK_BOT_TOKEN: "example-slack-bot-token-secret",
        SLACK_SIGNING_SECRET: "example-slack-signing-secret-secret",
      },
    });
  });

  it("returns EnvSecretProvider unaffected by env backend even when forwarding secret names are unset", async () => {
    process.env.SECRET_BACKEND = "env";

    const provider = await createSecretProvider();

    // env backend は Secret Manager シークレット名を要求しない（非破壊）。
    expect(provider).toBeInstanceOf(EnvSecretProvider);
    expect(createGcpSecretProviderMock).not.toHaveBeenCalled();
  });
});
