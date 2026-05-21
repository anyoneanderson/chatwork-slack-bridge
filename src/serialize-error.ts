export type SerializedError = {
  name: string;
  message: string;
  op?: string;
};

const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s"'<>)]*/gi;
const URL_USERINFO_PATTERN = /:\/\/[^/@\s]+:[^/@\s]+@/g;

/**
 * Error を安全に構造化ログへ載せる。
 *
 * DB ドライバの例外メッセージには接続文字列が埋め込まれることがあるため、
 * pino redact の path マスクに頼らず、ログへ渡す前にメッセージ内の認証情報を除去する。
 *
 * @param err 捕捉したエラー
 * @returns 秘密値を含めない最小限のエラー情報
 */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const serialized = { name: err.name, message: scrubSecretFragments(err.message) };

    if ("op" in err && typeof err.op === "string") {
      return { ...serialized, op: err.op };
    }

    return serialized;
  }

  return { name: "UnknownError", message: "unknown error" };
}

/**
 * ログメッセージ内に混入しうる接続文字列・認証情報を伏せる。
 *
 * @param message Error.message
 * @returns 認証情報を除去したメッセージ
 */
function scrubSecretFragments(message: string): string {
  return message
    .replace(POSTGRES_URL_PATTERN, "[REDACTED_URL]")
    .replace(URL_USERINFO_PATTERN, "://[REDACTED]@");
}
