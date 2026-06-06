import { createHmac, timingSafeEqual } from "node:crypto";

/** リプレイ拒否のための許容時刻ずれ（秒）。Slack 公式推奨の 5 分。 */
const MAX_SKEW_SECONDS = 300;

/** Slack 署名のバージョンプレフィックス（`v0:<ts>:<body>` の base 文字列に用いる）。 */
const SIGNATURE_VERSION_PREFIX = "v0=";

/**
 * Slack 署名の厳密形式。`v0=` + 小文字 hex 64 桁固定（HMAC-SHA256 = 32 bytes）。
 *
 * `Buffer.from(hex, "hex")` は不正文字・末尾ゴミ（例: `<正規64hex>zz` / 末尾空白）を黙って
 * 切り捨て、正規バイト数にデコードしうる。その結果 trailing garbage 付き署名が長さチェックを
 * 通過してバイパスされる恐れがあるため、デコード前に署名全体を完全一致で検証する。
 * 大文字 hex・空白・余分文字・桁数違いはすべて拒否する（NFR-001 / fail closed）。
 */
const SIGNATURE_PATTERN = /^v0=[0-9a-f]{64}$/;

/**
 * timestamp の厳密形式。1 文字以上の数字のみ（小数点・符号・非数字混入を拒否）。
 *
 * `Number.parseInt` は `"1700000000abc"` / `"1700000000.5"` のような不正値を黙って受理して
 * しまうため、正規表現で数字列のみに限定したうえで `Number.isSafeInteger` で安全な整数のみ採用する。
 */
const TIMESTAMP_PATTERN = /^[0-9]+$/;

/**
 * Slack request 署名を検証する（REQ-001）。
 *
 * 署名は `v0=HMAC-SHA256( signingSecret, "v0:" + timestamp + ":" + rawBody )` の hex。
 * 署名対象の base 文字列は `"v0:" + timestamp + ":"` の prefix と raw body（生バイト）の連結であり、
 * raw body は Buffer のため prefix 文字列を update してから rawBody を update して正しく連結する
 * （`update(Buffer)` は連結ではなく rawBody のバイトをそのまま使う）。受信署名（`v0=` を剥がした
 * hex のバイト列）と timing-safe に比較する。
 *
 * 署名は `Buffer.from(hex)` の前に `/^v0=[0-9a-f]{64}$/` で完全一致検証し、末尾ゴミ・大文字・空白・
 * 桁数違いを拒否する（緩い hex デコードによるバイパス防止 / NFR-001）。timestamp も `/^[0-9]+$/` +
 * `Number.isSafeInteger` で厳密に整数化し、非数字混入・小数を拒否する。`timestamp` が現在時刻から
 * ±300 秒を超えてずれている場合はリプレイとして HMAC を計算せず false を返す。
 *
 * fail closed: signing secret が空なら HMAC を計算せず即 false。署名欠落・形式不正・長さ不一致・
 * 不一致もすべて false を返す（chatwork 署名検証と同方針 / NFR-001）。`timingSafeEqual` は長さ
 * 不一致で throw するため、比較前に長さを確認して安全に false を返す。例外は投げず常に boolean を
 * 返し、signing secret・token・raw body はログ／例外に残さない（ログを出さない純粋関数 / NFR-002）。
 *
 * @param rawBody リクエストボディのバイト列（パース前。署名は生バイトに対して計算される）
 * @param timestamp `X-Slack-Request-Timestamp` ヘッダ値（unix 秒の文字列）。欠落時は空文字を渡す
 * @param signature `X-Slack-Signature` ヘッダ値（`v0=<hex>`）。欠落時は空文字を渡す
 * @param signingSecret Slack signing secret（secret adapter 経由で取得）
 * @param nowSeconds 現在時刻（unix 秒）。テスト容易性のため引数で受ける（既定 Date.now()/1000）
 * @returns 署名一致かつスキュー内なら true。欠落・不正・リプレイ・不一致・空鍵なら false
 */
export function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  signingSecret: string,
  nowSeconds?: number,
): boolean {
  // 署名は `v0=` + 小文字 hex 64 桁の完全一致のみ受理する。末尾ゴミ・大文字・空白・桁数違いは
  // ここで弾き、緩い hex デコードによるバイパスを防ぐ（NFR-001）。欠落（空文字）も不一致で false。
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  // signing secret 未設定は空鍵となり攻撃者が署名を偽造できる fail-open になる。
  // HMAC を計算する前に弾いて fail closed にする（NFR-001）。
  if (!signingSecret) return false;

  // timestamp は数字列のみ + 安全な整数のみ採用する。非数字混入・小数・欠落（空文字）は false。
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return false;

  // base 文字列は `"v0:" + timestamp + ":"` の prefix と raw body（生バイト）の連結。
  // rawBody は Buffer のため prefix を update してから rawBody を update して正しく連結する。
  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest();

  // 署名は完全一致検証済みのため、`v0=` を剥がした 64 hex は必ず 32 bytes にデコードされる。
  const receivedHex = signature.slice(SIGNATURE_VERSION_PREFIX.length);
  const received = Buffer.from(receivedHex, "hex");

  // 長さ不一致は timingSafeEqual が throw するため事前に弾く（throw による例外伝播を避ける）。
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}
