import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyChatworkSignature } from "@/adapters/chatwork/verify-signature";

// DUMMY webhook トークン（base64 文字列。実トークンではない / CON-005）。
// Chatwork の webhook トークンは base64 で発行されるため、ここでもダミーを base64 文字列で表す。
const DUMMY_WEBHOOK_TOKEN = Buffer.from("dummy-webhook-token-bytes").toString("base64");
// DUMMY raw body（本文・実 ID を含まない / CON-005）。署名は parse 前の生バイトに対して計算される。
const DUMMY_RAW_BODY = Buffer.from('{"webhook_event_type":"message_created"}', "utf8");

/**
 * テスト内で期待署名を算出する（実装と独立に Chatwork 署名アルゴリズムを再現する）。
 * アルゴリズム: Base64( HMAC-SHA256( rawBody, base64decode(token) ) )。
 * これにより「base64 鍵デコード」「raw body 対象」を実値ベクタとして固定する（design 6 / NFR-002）。
 */
function computeSignature(rawBody: Buffer, base64Token: string): string {
  const key = Buffer.from(base64Token, "base64");
  return createHmac("sha256", key).update(rawBody).digest("base64");
}

describe("verifyChatworkSignature", () => {
  it("returns true when the signature matches the pinned HMAC-SHA256 vector", () => {
    // Arrange: 実装と独立に base64 鍵デコード + raw body HMAC で期待署名を算出する。
    const signature = computeSignature(DUMMY_RAW_BODY, DUMMY_WEBHOOK_TOKEN);

    // Act
    const result = verifyChatworkSignature(DUMMY_RAW_BODY, signature, DUMMY_WEBHOOK_TOKEN);

    // Assert: アルゴリズム（base64 鍵デコード・raw body HMAC・base64 出力）を固定する。
    expect(result).toBe(true);
  });

  it("returns false when the request body is tampered after signing", () => {
    // Arrange: 別 body 用に算出した署名を、改竄後の body で検証する。
    const signatureForOriginal = computeSignature(DUMMY_RAW_BODY, DUMMY_WEBHOOK_TOKEN);
    const tamperedBody = Buffer.from('{"webhook_event_type":"message_deleted"}', "utf8");

    // Act
    const result = verifyChatworkSignature(tamperedBody, signatureForOriginal, DUMMY_WEBHOOK_TOKEN);

    // Assert
    expect(result).toBe(false);
  });

  it("returns false when the signature header is empty (missing header)", () => {
    // Arrange & Act: ヘッダ欠落はルート側で空文字として渡される想定。
    const result = verifyChatworkSignature(DUMMY_RAW_BODY, "", DUMMY_WEBHOOK_TOKEN);

    // Assert
    expect(result).toBe(false);
  });

  it("returns false when the signature is not valid base64 garbage of wrong length", () => {
    // Arrange: 不正・非 base64 文字列。デコード結果が期待長と一致しないため拒否される。
    const result = verifyChatworkSignature(DUMMY_RAW_BODY, "!!!not-base64!!!", DUMMY_WEBHOOK_TOKEN);

    // Assert
    expect(result).toBe(false);
  });

  it("returns false and does not throw when the signature length differs from the expected digest", () => {
    // Arrange: 正しい鍵・body だが、明らかに長さの異なる（短い）base64 署名。
    // 長さ事前チェックが timingSafeEqual の throw を防ぐことを確認する。
    const shortSignature = Buffer.from("short").toString("base64");

    // Act & Assert: throw せず false を返す。
    expect(() =>
      verifyChatworkSignature(DUMMY_RAW_BODY, shortSignature, DUMMY_WEBHOOK_TOKEN),
    ).not.toThrow();
    expect(verifyChatworkSignature(DUMMY_RAW_BODY, shortSignature, DUMMY_WEBHOOK_TOKEN)).toBe(
      false,
    );
  });

  it("returns false when a valid-length signature is computed with a different token", () => {
    // Arrange: 別トークンで算出した署名（長さは一致するが鍵が異なる）。
    const otherToken = Buffer.from("other-dummy-token").toString("base64");
    const signatureForOtherToken = computeSignature(DUMMY_RAW_BODY, otherToken);

    // Act
    const result = verifyChatworkSignature(
      DUMMY_RAW_BODY,
      signatureForOtherToken,
      DUMMY_WEBHOOK_TOKEN,
    );

    // Assert
    expect(result).toBe(false);
  });

  it("fails closed and returns false when the webhook token is an empty string (zero-byte key)", () => {
    // Arrange: トークン未設定（空文字）は base64 デコードで空鍵になる。攻撃者が空鍵で署名を偽造
    // できる fail-open を防ぐため、HMAC 計算前に弾いて false を返す（NFR-001 / second-opinion fix）。
    // 何らかの「署名」を与えても通らないことを確認する。
    const attackerSignature = computeSignature(DUMMY_RAW_BODY, "");

    // Act
    const result = verifyChatworkSignature(DUMMY_RAW_BODY, attackerSignature, "");

    // Assert
    expect(result).toBe(false);
  });

  it("fails closed when a token decodes to zero bytes via non-base64 garbage", () => {
    // Arrange: base64 として有効な文字を含まない文字列はデコード結果が 0 バイトになる。
    // この場合も空鍵となるため fail closed で false を返す。
    const emptyDecodingToken = "@@@"; // base64 デコードで 0 バイト
    expect(Buffer.from(emptyDecodingToken, "base64").length).toBe(0);
    const attackerSignature = computeSignature(DUMMY_RAW_BODY, emptyDecodingToken);

    // Act
    const result = verifyChatworkSignature(DUMMY_RAW_BODY, attackerSignature, emptyDecodingToken);

    // Assert
    expect(result).toBe(false);
  });
});
