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
const CHATWORK_WEBHOOK_TOKEN_SECRET = "example-chatwork-webhook-token-secret";
const CHATWORK_API_TOKEN_SECRET = "example-chatwork-api-token-secret";
const SLACK_BOT_TOKEN_SECRET = "example-slack-bot-token-secret";
const SLACK_SIGNING_SECRET_SECRET = "example-slack-signing-secret-secret";
const DATABASE_URL_VALUE = "postgres://bridge_user:bridge_pass@db.example.com:5432/bridge";
// DUMMY token values（実トークンではない / CON-005）。
const CHATWORK_WEBHOOK_TOKEN_VALUE = "dummy-chatwork-webhook-token";
const CHATWORK_API_TOKEN_VALUE = "dummy-chatwork-api-token";
const SLACK_BOT_TOKEN_VALUE = "xoxb-dummy-slack-bot-token";
const SLACK_SIGNING_SECRET_VALUE = "dummy-slack-signing-secret";

// Secret Manager で prefetch する秘密キーと、それに対応するシークレット名・期待値。
// 注: createGcpSecretProvider は SECRET_MANAGER_KEYS の順序でアクセスする。
const SECRET_NAMES = {
  DATABASE_URL: DATABASE_URL_SECRET,
  CHATWORK_WEBHOOK_TOKEN: CHATWORK_WEBHOOK_TOKEN_SECRET,
  CHATWORK_API_TOKEN: CHATWORK_API_TOKEN_SECRET,
  SLACK_BOT_TOKEN: SLACK_BOT_TOKEN_SECRET,
  SLACK_SIGNING_SECRET: SLACK_SIGNING_SECRET_SECRET,
} as const;

const SECRET_VALUES = {
  DATABASE_URL: DATABASE_URL_VALUE,
  CHATWORK_WEBHOOK_TOKEN: CHATWORK_WEBHOOK_TOKEN_VALUE,
  CHATWORK_API_TOKEN: CHATWORK_API_TOKEN_VALUE,
  SLACK_BOT_TOKEN: SLACK_BOT_TOKEN_VALUE,
  SLACK_SIGNING_SECRET: SLACK_SIGNING_SECRET_VALUE,
} as const;

type PrefetchedKey = keyof typeof SECRET_NAMES;
const PREFETCHED_KEYS = Object.keys(SECRET_NAMES) as PrefetchedKey[];

const originalLogLevel = process.env.LOG_LEVEL;

/** accessSecretVersion の戻り値（payload.data を持つ secret version）を組み立てる。 */
function secretVersionResponse(data: string | undefined) {
  return [{ payload: data === undefined ? null : { data: Buffer.from(data) } }];
}

function buildOptions() {
  return {
    projectId: PROJECT_ID,
    secretNames: { ...SECRET_NAMES },
  };
}

/**
 * 全ての prefetch 対象シークレットに対し、シークレット名から正しい値を返すモックを仕込む。
 * createGcpSecretProvider の `name` 引数からシークレット名を逆引きして対応値を返す。
 */
function mockAllSecretsResolve() {
  accessSecretVersionMock.mockImplementation((req: { name: string }) => {
    const entry = PREFETCHED_KEYS.find((key) =>
      req.name.includes(`/secrets/${SECRET_NAMES[key]}/`),
    );
    if (!entry) {
      throw new Error("unexpected secret name");
    }
    return Promise.resolve(secretVersionResponse(SECRET_VALUES[entry]));
  });
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
    mockAllSecretsResolve();

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("DATABASE_URL")).toBe(DATABASE_URL_VALUE);
    // DATABASE_URL + forwarding トークン 3 種 + slack-reply の signing secret を prefetch（計 5 回）。
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(5);
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${DATABASE_URL_SECRET}/versions/latest`,
    });
  });

  it("prefetches and caches the forwarding token secrets via synchronous get", async () => {
    mockAllSecretsResolve();

    const provider = await createGcpSecretProvider(buildOptions());

    // 新トークン系秘密がキャッシュから同期的に返ること（DUMMY 値 / CON-005）。
    expect(provider.get("CHATWORK_WEBHOOK_TOKEN")).toBe(CHATWORK_WEBHOOK_TOKEN_VALUE);
    expect(provider.get("CHATWORK_API_TOKEN")).toBe(CHATWORK_API_TOKEN_VALUE);
    expect(provider.get("SLACK_BOT_TOKEN")).toBe(SLACK_BOT_TOKEN_VALUE);

    // 各トークンのシークレット名で Secret Manager を呼ぶこと。
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${CHATWORK_WEBHOOK_TOKEN_SECRET}/versions/latest`,
    });
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${CHATWORK_API_TOKEN_SECRET}/versions/latest`,
    });
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${SLACK_BOT_TOKEN_SECRET}/versions/latest`,
    });
    // slack-reply フェーズの signing secret も prefetch + キャッシュされる（DUMMY 値 / CON-003）。
    expect(provider.get("SLACK_SIGNING_SECRET")).toBe(SLACK_SIGNING_SECRET_VALUE);
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${SLACK_SIGNING_SECRET_SECRET}/versions/latest`,
    });
  });

  it("falls back to env for the Slack channel-id keys (config values, not Secret Manager secrets)", async () => {
    mockAllSecretsResolve();
    // チャンネル ID は秘密ではなく設定値のため env から取得する（DUMMY 値 / CON-005）。
    process.env.SLACK_DEFAULT_GROUP_CHANNEL_ID = "C0DUMMYGROUP";
    process.env.SLACK_DEFAULT_DM_CHANNEL_ID = "C0DUMMYDM";

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("SLACK_DEFAULT_GROUP_CHANNEL_ID")).toBe("C0DUMMYGROUP");
    expect(provider.get("SLACK_DEFAULT_DM_CHANNEL_ID")).toBe("C0DUMMYDM");

    delete process.env.SLACK_DEFAULT_GROUP_CHANNEL_ID;
    delete process.env.SLACK_DEFAULT_DM_CHANNEL_ID;
  });

  it("requests the configured version when version option is provided", async () => {
    mockAllSecretsResolve();

    await createGcpSecretProvider({ ...buildOptions(), version: "3" });

    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${DATABASE_URL_SECRET}/versions/3`,
    });
    expect(accessSecretVersionMock).toHaveBeenCalledWith({
      name: `projects/${PROJECT_ID}/secrets/${SLACK_BOT_TOKEN_SECRET}/versions/3`,
    });
  });

  it("falls back to env for non-secret keys", async () => {
    mockAllSecretsResolve();
    process.env.LOG_LEVEL = "debug";

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("LOG_LEVEL")).toBe("debug");
  });

  it("returns undefined for non-secret keys absent from env", async () => {
    mockAllSecretsResolve();
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
    // 最初の DATABASE_URL アクセスのみ一過性失敗 → リトライ成功。残りキーは通常解決させる。
    let firstAttempt = true;
    accessSecretVersionMock.mockImplementation((req: { name: string }) => {
      if (req.name.includes(`/secrets/${DATABASE_URL_SECRET}/`) && firstAttempt) {
        firstAttempt = false;
        return Promise.reject(new Error("transient"));
      }
      const entry = PREFETCHED_KEYS.find((key) =>
        req.name.includes(`/secrets/${SECRET_NAMES[key]}/`),
      );
      if (!entry) {
        throw new Error("unexpected secret name");
      }
      return Promise.resolve(secretVersionResponse(SECRET_VALUES[entry]));
    });

    const provider = await createGcpSecretProvider(buildOptions());

    expect(provider.get("DATABASE_URL")).toBe(DATABASE_URL_VALUE);
    // 5 キー prefetch + DATABASE_URL の 1 回リトライ = 6 回。
    expect(accessSecretVersionMock).toHaveBeenCalledTimes(6);
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
