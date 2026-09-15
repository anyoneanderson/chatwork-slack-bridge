import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";
import { SecretAccessError, type SecretKey, type SecretProvider } from "@/adapters/secrets/types";
import { withRetry } from "@/with-retry";
import { withTimeout } from "@/with-timeout";

/**
 * Secret Manager から取得する「秘密」キー。
 *
 * DATABASE_URL に加え、forwarding フェーズのトークン系秘密（Chatwork webhook / Chatwork API /
 * Slack Bot）と slack-reply フェーズの Slack signing secret を prefetch する。Slack チャンネル ID
 * は秘密ではなく設定値のため env に残す。
 */
const SECRET_MANAGER_KEYS = [
  "DATABASE_URL",
  "CHATWORK_WEBHOOK_TOKEN",
  "CHATWORK_API_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
] as const satisfies readonly SecretKey[];

type SecretManagerKey = (typeof SECRET_MANAGER_KEYS)[number];

/** Secret Manager 呼び出しの既定タイムアウト（ミリ秒）。 */
const DEFAULT_TIMEOUT_MS = 5000;

/** Secret Manager 呼び出しの追加リトライ回数（指数バックオフ・最大 2 回）。 */
const SECRET_ACCESS_RETRIES = 2;

/** `createGcpSecretProvider` の構築オプション。 */
export interface GcpSecretProviderOptions {
  /** GCP プロジェクト ID。 */
  projectId: string;
  /** 秘密キー → Secret Manager シークレット名のマッピング。 */
  secretNames: Record<SecretManagerKey, string>;
  /** 取得するシークレットバージョン。既定 'latest'。 */
  version?: string;
  /** Secret Manager 呼び出し 1 回あたりの上限ミリ秒。既定 5000。 */
  timeoutMs?: number;
}

/**
 * Secret Manager から対象シークレットを起動時にプリフェッチし、同期 `SecretProvider` を返す。
 *
 * 秘密キー（`DATABASE_URL` / `CHATWORK_WEBHOOK_TOKEN` / `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` /
 * `SLACK_SIGNING_SECRET`）は
 * メモリにキャッシュした値を返し、それ以外のキーは内部の
 * `EnvSecretProvider` にフォールバックする。Secret Manager 呼び出しは `withTimeout`
 * （既定 5000ms）と `withRetry`（指数バックオフ・最大 2 回）で囲む。認証は ADC を用いる。
 *
 * 取得値・シークレット名・接続文字列はログ・エラーに含めない。
 *
 * @param options プロジェクト ID・シークレット名マッピング・バージョン・タイムアウト
 * @returns プリフェッチ済みの同期 `SecretProvider`
 * @throws SecretAccessError 対象シークレットが missing / 空 payload の場合、または
 *   Secret Manager 呼び出しが（タイムアウト・NotFound・PermissionDenied・ネットワーク等で）
 *   リトライ後も失敗した場合。SDK の生エラーは re-throw せずキー区分のみを保持して包み直す
 *   （リソース名 `projects/.../secrets/<name>/...` をログ・エラーに漏らさない／NFR-001・NFR-007）。
 */
export async function createGcpSecretProvider(
  options: GcpSecretProviderOptions,
): Promise<SecretProvider> {
  const client = new SecretManagerServiceClient();
  const env = new EnvSecretProvider();
  const cache = new Map<SecretManagerKey, string>();
  const version = options.version ?? "latest";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (const key of SECRET_MANAGER_KEYS) {
    const name = `projects/${options.projectId}/secrets/${options.secretNames[key]}/versions/${version}`;

    let payload: string | undefined;
    try {
      // bounded timeout + retry（指数バックオフ・最大 2 回）でアクセス（NFR-007）。
      const [secretVersion] = await withRetry(
        () => withTimeout(client.accessSecretVersion({ name }), timeoutMs, "secret.access"),
        { retries: SECRET_ACCESS_RETRIES },
      );
      payload = secretVersion.payload?.data?.toString();
    } catch {
      // SDK の生エラーには `projects/.../secrets/<name>/...` のリソース名が含まれうるため、
      // そのまま re-throw せずキー区分のみを保持して包み直す（cause にも生エラー・name を残さない）。
      throw new SecretAccessError(key);
    }

    // missing / 空 payload は env フォールバックせず起動を中断する（壊れた Secret を成功扱いしない）。
    if (!payload) {
      // キー区分のみ保持。値・name はログ・エラーに残さない（NFR-001）。
      throw new SecretAccessError(key);
    }

    cache.set(key, payload);
  }

  return {
    get(key: SecretKey): string | undefined {
      // 秘密キーはプリフェッチ済みキャッシュのみ。それ以外は env にフォールバックする。
      if (isSecretManagerKey(key)) {
        return cache.get(key);
      }
      return env.get(key);
    },
  };
}

/**
 * 与えられたキーが Secret Manager 管理対象の秘密キーか判定する。
 *
 * @param key 判定対象のキー
 * @returns 秘密キーなら true
 */
function isSecretManagerKey(key: SecretKey): key is SecretManagerKey {
  return (SECRET_MANAGER_KEYS as readonly SecretKey[]).includes(key);
}
