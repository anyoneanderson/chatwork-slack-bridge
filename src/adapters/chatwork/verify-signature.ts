import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Chatwork Webhook 署名を検証する（REQ-002）。
 *
 * 署名は `Base64( HMAC-SHA256( rawBody, base64decode(webhookToken) ) )`。
 * webhook トークンを base64 デコードした値を HMAC 鍵とし、パース前の raw body に対して
 * HMAC-SHA256 を計算する。受信署名（base64 デコード後のバイト列）と timing-safe に比較する。
 *
 * `timingSafeEqual` は長さ不一致で throw するため、比較前に長さを確認して安全に false を返す
 * （長さの違い自体は秘密ではなく、throw による情報漏れ・例外伝播を避ける目的）。署名欠落・
 * base64 不正・長さ不一致・不一致はすべて false を返し、トークン・本文はログ／例外に残さない。
 *
 * webhook トークンが未設定・不正 base64・空デコードの場合は HMAC 鍵が空になり、攻撃者が空鍵に
 * 対して署名を偽造できる fail-open になる。署名検証はセキュリティ境界（REQ-002 / NFR-001）の
 * ため、空鍵のときは HMAC を計算せず即 false を返して **fail closed** とする。
 *
 * @param rawBody リクエストボディのバイト列（パース前。署名は生バイトに対して計算される）
 * @param signature `X-ChatWorkWebhookSignature` ヘッダ値（base64）。欠落時は空文字を渡す
 * @param webhookToken Chatwork が発行した webhook トークン（base64）。secret adapter 経由で取得
 * @returns 署名が一致すれば true。欠落・不正 base64・長さ不一致・不一致・空/不正トークンなら false
 */
export function verifyChatworkSignature(
  rawBody: Buffer,
  signature: string,
  webhookToken: string,
): boolean {
  if (!signature) return false;

  // webhook トークンは base64 文字列。HMAC 鍵にはデコード後のバイト列を用いる。
  const key = Buffer.from(webhookToken, "base64");

  // トークン未設定・不正 base64・空デコードは空鍵となり、攻撃者が空鍵に対して署名を偽造できる
  // fail-open になる。HMAC を計算する前に弾いて fail closed にする（NFR-001）。
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key).update(rawBody).digest();

  // Buffer.from(..., "base64") は throw しないが、不正文字は無視されデコード結果が短くなる。
  // その場合は後続の長さチェックで弾かれる。
  const received = Buffer.from(signature, "base64");

  // 長さ不一致は timingSafeEqual が throw するため事前に弾く（throw による例外伝播を避ける）。
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}
