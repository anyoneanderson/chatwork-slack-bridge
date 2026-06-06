import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "@/adapters/slack/verify-signature";

// DUMMY signing secret（実シークレットではない / CON-003）。
const DUMMY_SIGNING_SECRET = "dummy-slack-signing-secret";
// DUMMY raw body（本文・実 ID を含まない / CON-003）。署名は parse 前の生バイトに対して計算される。
const DUMMY_RAW_BODY = Buffer.from('{"type":"event_callback"}', "utf8");
// 固定の現在時刻（unix 秒）。テストは引数で now を渡してスキュー判定を決定的にする。
const FIXED_NOW = 1_700_000_000;
// 境界テスト用の許容スキュー（実装の MAX_SKEW_SECONDS と一致）。
const MAX_SKEW_FIXTURE = 300;
// FIXED_NOW と同じ（スキュー 0）。
const VALID_TIMESTAMP = String(FIXED_NOW);

/**
 * テスト内で期待署名を算出する（実装と独立に Slack 署名アルゴリズムを再現する）。
 * アルゴリズム: `v0=` + hex( HMAC-SHA256( signingSecret, "v0:" + timestamp + ":" + rawBody ) )。
 * prefix 文字列と rawBody を順に update して正しく連結する（実装と同方法 / design §4.1）。
 */
function computeSignature(rawBody: Buffer, timestamp: string, signingSecret: string): string {
  const hex = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest("hex");
  return `v0=${hex}`;
}

describe("verifySlackSignature", () => {
  it("returns true for a valid signature within the skew window", () => {
    const signature = computeSignature(DUMMY_RAW_BODY, VALID_TIMESTAMP, DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      signature,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(true);
  });

  it("returns false when the request body is tampered after signing", () => {
    const signatureForOriginal = computeSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      DUMMY_SIGNING_SECRET,
    );
    const tamperedBody = Buffer.from('{"type":"url_verification"}', "utf8");

    const result = verifySlackSignature(
      tamperedBody,
      VALID_TIMESTAMP,
      signatureForOriginal,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false when the signature header is empty (missing header)", () => {
    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      "",
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("fails closed and returns false when the signing secret is empty (zero-length key)", () => {
    // 空鍵で偽造した署名を与えても通らないことを確認する（fail closed / NFR-001）。
    const attackerSignature = computeSignature(DUMMY_RAW_BODY, VALID_TIMESTAMP, "");

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      attackerSignature,
      "",
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false when the timestamp is outside the +/-300s skew window (replay)", () => {
    // 署名自体は古い timestamp に対して正当だが、現在時刻から 301 秒過去のためリプレイとして拒否する。
    const oldTimestamp = String(FIXED_NOW - 301);
    const signature = computeSignature(DUMMY_RAW_BODY, oldTimestamp, DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      oldTimestamp,
      signature,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false when the timestamp is in the future beyond the skew window", () => {
    const futureTimestamp = String(FIXED_NOW + 301);
    const signature = computeSignature(DUMMY_RAW_BODY, futureTimestamp, DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      futureTimestamp,
      signature,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns true at the exact skew boundary (300s)", () => {
    const boundaryTimestamp = String(FIXED_NOW - MAX_SKEW_FIXTURE);
    const signature = computeSignature(DUMMY_RAW_BODY, boundaryTimestamp, DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      boundaryTimestamp,
      signature,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(true);
  });

  it("returns false when the timestamp is empty (missing header)", () => {
    const signature = computeSignature(DUMMY_RAW_BODY, "", DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      "",
      signature,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false when the timestamp is not a number (NaN)", () => {
    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      "not-a-timestamp",
      computeSignature(DUMMY_RAW_BODY, "not-a-timestamp", DUMMY_SIGNING_SECRET),
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false and does not throw when the hex length differs from the expected digest", () => {
    // 正しい prefix だが、明らかに長さの異なる短い hex。長さ事前チェックが timingSafeEqual の throw を防ぐ。
    const shortSignature = "v0=abcd";

    expect(() =>
      verifySlackSignature(
        DUMMY_RAW_BODY,
        VALID_TIMESTAMP,
        shortSignature,
        DUMMY_SIGNING_SECRET,
        FIXED_NOW,
      ),
    ).not.toThrow();
    expect(
      verifySlackSignature(
        DUMMY_RAW_BODY,
        VALID_TIMESTAMP,
        shortSignature,
        DUMMY_SIGNING_SECRET,
        FIXED_NOW,
      ),
    ).toBe(false);
  });

  it("returns false when the v0= prefix is missing even if the hex matches", () => {
    // prefix 無しの bare hex は署名形式が不正のため拒否する。
    const signatureWithPrefix = computeSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      DUMMY_SIGNING_SECRET,
    );
    const bareHex = signatureWithPrefix.slice("v0=".length);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      bareHex,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("returns false when a valid-length signature is computed with a different signing secret", () => {
    const otherSecret = "other-dummy-signing-secret";
    const signatureForOtherSecret = computeSignature(DUMMY_RAW_BODY, VALID_TIMESTAMP, otherSecret);

    const result = verifySlackSignature(
      DUMMY_RAW_BODY,
      VALID_TIMESTAMP,
      signatureForOtherSecret,
      DUMMY_SIGNING_SECRET,
      FIXED_NOW,
    );

    expect(result).toBe(false);
  });

  it("uses the current clock when nowSeconds is omitted", () => {
    // now を省略すると Date.now() ベース。現在時刻の timestamp なら検証が通る。
    const nowTs = String(Math.floor(Date.now() / 1000));
    const signature = computeSignature(DUMMY_RAW_BODY, nowTs, DUMMY_SIGNING_SECRET);

    const result = verifySlackSignature(DUMMY_RAW_BODY, nowTs, signature, DUMMY_SIGNING_SECRET);

    expect(result).toBe(true);
  });

  describe("strict signature-format validation (bypass hardening)", () => {
    // 正当署名を起点に、緩い hex デコードを突くバリエーションがすべて拒否されることを確認する。
    const validSignature = computeSignature(DUMMY_RAW_BODY, VALID_TIMESTAMP, DUMMY_SIGNING_SECRET);

    function verify(signature: string): boolean {
      return verifySlackSignature(
        DUMMY_RAW_BODY,
        VALID_TIMESTAMP,
        signature,
        DUMMY_SIGNING_SECRET,
        FIXED_NOW,
      );
    }

    it("accepts the canonical valid signature (sanity check for the variants below)", () => {
      // 完全一致パターンの基準。Buffer.from(hex) が末尾ゴミを切り捨てる挙動を確認する。
      expect(verify(validSignature)).toBe(true);
      // 64hex + "zz" でも Buffer.from は 32 bytes にデコードしてしまう（だから事前検証が必要）。
      expect(Buffer.from(`${validSignature.slice("v0=".length)}zz`, "hex").length).toBe(32);
    });

    it("rejects a signature with trailing hex garbage (valid + 'zz')", () => {
      expect(verify(`${validSignature}zz`)).toBe(false);
    });

    it("rejects a signature with a trailing space", () => {
      expect(verify(`${validSignature} `)).toBe(false);
    });

    it("rejects a signature with leading whitespace", () => {
      expect(verify(` ${validSignature}`)).toBe(false);
    });

    it("rejects an uppercase-hex signature", () => {
      expect(verify(validSignature.toUpperCase())).toBe(false);
    });

    it("rejects an uppercase 'V0=' version prefix", () => {
      const upperPrefix = `V0=${validSignature.slice("v0=".length)}`;
      expect(verify(upperPrefix)).toBe(false);
    });

    it("rejects a 63-hex (too short) signature", () => {
      const hex63 = validSignature.slice("v0=".length, "v0=".length + 63);
      expect(hex63).toHaveLength(63);
      expect(verify(`v0=${hex63}`)).toBe(false);
    });

    it("rejects a 65-hex (too long) signature", () => {
      const hex65 = `${validSignature.slice("v0=".length)}a`;
      expect(hex65).toHaveLength(65);
      expect(verify(`v0=${hex65}`)).toBe(false);
    });

    it("rejects a bare hex without the v0= prefix even if it matches", () => {
      expect(verify(validSignature.slice("v0=".length))).toBe(false);
    });
  });

  describe("strict timestamp validation", () => {
    function verifyWithTimestamp(timestamp: string): boolean {
      // 各 timestamp に対して正当な署名を算出したうえで検証する（拒否理由が timestamp 形式に絞られる）。
      const signature = computeSignature(DUMMY_RAW_BODY, timestamp, DUMMY_SIGNING_SECRET);
      return verifySlackSignature(
        DUMMY_RAW_BODY,
        timestamp,
        signature,
        DUMMY_SIGNING_SECRET,
        Number(timestamp.replace(/[^0-9]/g, "")) || FIXED_NOW,
      );
    }

    it("rejects a timestamp with trailing non-digit characters", () => {
      // "<unix秒>abc" は Number.parseInt なら受理されるが、厳密検証で拒否する。
      expect(verifyWithTimestamp(`${VALID_TIMESTAMP}abc`)).toBe(false);
    });

    it("rejects a decimal timestamp", () => {
      expect(verifyWithTimestamp(`${VALID_TIMESTAMP}.5`)).toBe(false);
    });

    it("rejects a timestamp with leading whitespace", () => {
      expect(verifyWithTimestamp(` ${VALID_TIMESTAMP}`)).toBe(false);
    });
  });
});
