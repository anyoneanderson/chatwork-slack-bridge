import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";
import { createSecretProvider, SecretConfigError } from "@/adapters/secrets/factory";

// gcp backend のテストでは Secret Manager へ実アクセスしないよう provider を差し替える。
const createGcpSecretProviderMock = vi.hoisted(() => vi.fn());

vi.mock("@/adapters/secrets/gcp-secret-provider", () => ({
  createGcpSecretProvider: createGcpSecretProviderMock,
}));

const ENV_KEYS = ["SECRET_BACKEND", "GOOGLE_CLOUD_PROJECT", "DATABASE_URL_SECRET"] as const;
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

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

  it("throws SecretConfigError listing both reference keys when SECRET_BACKEND=gcp and both are missing", async () => {
    process.env.SECRET_BACKEND = "gcp";

    await expect(createSecretProvider()).rejects.toBeInstanceOf(SecretConfigError);

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      expect(configError.missingKeys).toEqual(["GOOGLE_CLOUD_PROJECT", "DATABASE_URL_SECRET"]);
    }
    expect(createGcpSecretProviderMock).not.toHaveBeenCalled();
  });

  it("throws SecretConfigError naming only GOOGLE_CLOUD_PROJECT when it is the sole missing key", async () => {
    process.env.SECRET_BACKEND = "gcp";
    process.env.DATABASE_URL_SECRET = "example-database-url-secret";

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      expect(configError.missingKeys).toEqual(["GOOGLE_CLOUD_PROJECT"]);
    }
  });

  it("throws SecretConfigError naming only DATABASE_URL_SECRET when it is the sole missing key", async () => {
    process.env.SECRET_BACKEND = "gcp";
    process.env.GOOGLE_CLOUD_PROJECT = "example-project";

    try {
      await createSecretProvider();
      throw new Error("createSecretProvider should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretConfigError);
      const configError = err as SecretConfigError;
      expect(configError.missingKeys).toEqual(["DATABASE_URL_SECRET"]);
    }
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
    }
  });

  it("delegates to createGcpSecretProvider with the configured project and secret name when SECRET_BACKEND=gcp", async () => {
    process.env.SECRET_BACKEND = "gcp";
    process.env.GOOGLE_CLOUD_PROJECT = "example-project";
    process.env.DATABASE_URL_SECRET = "example-database-url-secret";
    const expectedProvider = { get: vi.fn() };
    createGcpSecretProviderMock.mockResolvedValue(expectedProvider);

    const provider = await createSecretProvider();

    expect(provider).toBe(expectedProvider);
    expect(createGcpSecretProviderMock).toHaveBeenCalledWith({
      projectId: "example-project",
      secretNames: { DATABASE_URL: "example-database-url-secret" },
    });
  });
});
