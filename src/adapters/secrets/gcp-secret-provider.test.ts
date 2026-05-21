import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGcpSecretProvider } from "@/adapters/secrets/gcp-secret-provider";
import { SecretAccessError } from "@/adapters/secrets/types";

// @google-cloud/secret-manager の SDK クライアントをモックし、ネットワーク非依存にする。
const accessSecretVersionMock = vi.hoisted(() => vi.fn());
const secretManagerClientCtor = vi.hoisted(() =>
  vi.fn(function SecretManagerServiceClientMock() {
    return { accessSecretVersion: accessSecretVersionMock };
  }),
);

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: secretManagerClientCtor,
}));

const PROJECT_ID = "example-project";
const DATABASE_URL_SECRET = "example-database-url-secret";
const DATABASE_URL_VALUE = "postgres://bridge_user:bridge_pass@db.example.com:5432/bridge";

const originalLogLevel = process.env.LOG_LEVEL;

/** accessSecretVersion の戻り値（payload.data を持つ secret version）を組み立てる。 */
function secretVersionResponse(data: string | undefined) {
  return [{ payload: data === undefined ? null : { data: Buffer.from(data) } }];
}

function buildOptions() {
  return {
    projectId: PROJECT_ID,
    secretNames: { DATABASE_URL: DATABASE_URL_SECRET },
  };
}

beforeEach(() => {
  accessSecretVersionMock.mockReset();
  secretManagerClientCtor.mockClear();
});

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
});

describe("createGcpSecretProvider", () => {
  it("returns the prefetched DATABASE_URL value via synchronous get", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(DATABASE_URL_VALUE));

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("DATABASE_URL")).toBe(DATABASE_URL_VALUE);
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(1);
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${DATABASE_URL_SECRET}/versions/latest`,
    });
  });

  it("requests the configured version when version option is provided", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(DATABASE_URL_VALUE));

    await createGcpSecretProvider({ ...buildOptions(), version: "3" });

    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${DATABASE_URL_SECRET}/versions/3`,
    });
  });

  it("falls back to env for non-secret keys", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(DATABASE_URL_VALUE));
    process.env.LOG_LEVEL = "debug";

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("LOG_LEVEL")).toBe("debug");
  });

  it("returns undefined for non-secret keys absent from env", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(DATABASE_URL_VALUE));
    delete process.env.LOG_LEVEL;

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("LOG_LEVEL")).toBeUndefined();
  });

  it("throws SecretAccessError when payload is empty", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(""));

    await expect(createGcpSecretProvider(buildOptions())).rejects.toBeInstanceOf(SecretAccessError);
  });

  it("throws SecretAccessError when payload is missing", async () => {
    accessSecretVersionMock.mockResolvedValue(secretVersionResponse(undefined));

    const promise = createGcpSecretProvider(buildOptions());

    await expect(promise).rejects.toBeInstanceOf(SecretAccessError);
    await promise.catch((err: unknown) => {
      const accessError = err as SecretAccessError;
      expect(accessError.key).toBe("DATABASE_URL");
      // 失敗時のエラーに値・シークレット名を残さない（NFR-001）。
      expect(accessError.message).not.toContain(DATABASE_URL_SECRET);
      expect(accessError.message).not.toContain(DATABASE_URL_VALUE);
    });
  });

  it("retries on a transient failure and then succeeds", async () => {
    accessSecretVersionMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(secretVersionResponse(DATABASE_URL_VALUE));

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("DATABASE_URL")).toBe(DATABASE_URL_VALUE);
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(2);
  });

  it("wraps a persistent SDK failure in SecretAccessError without leaking the secret name", async () => {
    vi.useFakeTimers();

    // SDK の生エラーにはリソース名（projects/.../secrets/<name>/...）が含まれうる。
    const sdkError = new Error(
      `5 NOT_FOUND: Secret [projects/p/secrets/${DATABASE_URL_SECRET}/versions/latest] not found`,
    );
    accessSecretVersionMock.mockRejectedValue(sdkError);

    const promise = createGcpSecretProvider(buildOptions());
    const captured = promise.catch((err: unknown) => err);
    // バックオフ待機を全て消化させ、リトライを打ち切らせる。
    await vi.runAllTimersAsync();

    const err = (await captured) as SecretAccessError;
    expect(err).toBeInstanceOf(SecretAccessError);
    expect(err.key).toBe("DATABASE_URL");

    // 例外のメッセージ・直列化全体・cause にシークレット名を残さない（NFR-001 / NFR-007）。
    const serialized = JSON.stringify({
      message: err.message,
      name: err.name,
      key: err.key,
      cause: (err as { cause?: unknown }).cause ?? null,
      stack: err.stack,
    });
    expect(err.message).not.toContain(DATABASE_URL_SECRET);
    expect(serialized).not.toContain(DATABASE_URL_SECRET);
    expect((err as { cause?: unknown }).cause).toBeUndefined();

    // retries:2 → 初回 + リトライ 2 回 = 最大 3 回で打ち切り。
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });
});
