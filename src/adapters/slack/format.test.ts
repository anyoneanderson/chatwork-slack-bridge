import { describe, expect, it } from "vitest";

import { CHATWORK_EMOTICONS } from "@/adapters/chatwork/chatwork-emoticons";
import { format } from "@/adapters/slack/format";

// DUMMY 値（実 ID・実本文・実ルーム名・実クライアント名を含まない / CON-005）。
const DUMMY_ROOM_NAME = "dummy room name";
const DUMMY_ACCOUNT_ID = "1234567";
const DUMMY_BODY = "dummy message body";
const DUMMY_ROOM_ID = "2002";
const DUMMY_MESSAGE_ID = "msg-3003";
const DUMMY_SENDER_NAME = "Dummy Sender";
/** 最終フォールバックラベル（src/adapters/slack/format.ts の UNKNOWN_SENDER_LABEL と整合）。 */
const UNKNOWN_SENDER_LABEL = "unknown";

/**
 * 既存テストの最小タッチ用ヘルパ。新規必須フィールド（`senderName` / `roomId` / `messageId`）の
 * デフォルトを補い、各テストは検証したいフィールド（`accountId` / `body`）のみを上書きする。
 * `senderName` のデフォルトは null（テストは account_id フォールバック挙動を検証するため）。
 */
function msg(overrides: { accountId: string | null; body: string; senderName?: string | null }): {
  accountId: string | null;
  senderName: string | null;
  body: string;
  roomId: string;
  messageId: string;
} {
  return {
    accountId: overrides.accountId,
    senderName: overrides.senderName ?? null,
    body: overrides.body,
    roomId: DUMMY_ROOM_ID,
    messageId: DUMMY_MESSAGE_ID,
  };
}

describe("format", () => {
  it("includes the room name, sender, and body in the formatted text when all fields are present", () => {
    // Arrange
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain(DUMMY_ROOM_NAME);
    expect(result.text).toContain(DUMMY_ACCOUNT_ID);
    expect(result.text).toContain(DUMMY_BODY);
  });

  it("falls back to 'unknown' as the sender when accountId is null", () => {
    // Arrange
    const message = msg({ accountId: null, body: DUMMY_BODY });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain("unknown");
    expect(result.text).toContain(DUMMY_ROOM_NAME);
    expect(result.text).toContain(DUMMY_BODY);
  });

  it("preserves the body verbatim for multi-line text that has no Slack control chars", () => {
    // Arrange: Slack 制御文字（& < >）を含まない本文は改変・切り詰めされず保持されること。
    //          改行・タブはエスケープ対象外。
    const multilineBody = "line one\nline two\tindented plain text";
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: multilineBody });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain(multilineBody);
  });

  it("escapes Slack control chars (& < >) in body, room name, and sender, ampersand first", () => {
    // Arrange: 信頼できない 3 セグメント（本文・ルーム名・送信者）すべてをエスケープすること。
    const message = msg({ accountId: "a<&>b", body: "x & y < z > w" });
    const room = { name: "room <&> name" };

    // Act
    const result = format(message, room);

    // Assert: 各セグメントがエスケープ済みの形で含まれる（& を最初に処理するので二重エスケープしない）。
    expect(result.text).toContain("x &amp; y &lt; z &gt; w"); // body
    expect(result.text).toContain("room &lt;&amp;&gt; name"); // room name
    expect(result.text).toContain("a&lt;&amp;&gt;b"); // sender
    // 生の制御文字も多重エスケープ痕（&amp;amp; / &amp;lt;）も残らないこと。
    expect(result.text).not.toContain("&amp;amp;");
    expect(result.text).not.toContain("&amp;lt;");
    expect(result.text).not.toContain("&amp;gt;");
  });

  it("does not escape the fixed [Chatwork] label or the \\n/: separators", () => {
    // Arrange: 固定ラベル・区切り文字はエスケープしない（信頼できる固定文字列）。
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain("[Chatwork] ");
    expect(result.text).toContain("\n");
    expect(result.text).toContain(":");
  });

  it("neutralizes Slack mention/broadcast injection from a malicious Chatwork body", () => {
    // Arrange: 悪意ある Chatwork 本文が Slack の一斉メンション/メンションを発火させないこと（通知インジェクション対策）。
    const maliciousBody = "<!channel> & <@U123>";
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: maliciousBody });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert: 生の制御シーケンスは出力に存在しない。
    expect(result.text).not.toContain("<!channel>");
    expect(result.text).not.toContain("<@U123>");
    // Assert: エスケープ済みの形が存在する（Slack はメンションとして解釈しない）。
    expect(result.text).toContain("&lt;!channel&gt; &amp; &lt;@U123&gt;");
  });

  it("preserves an empty body without throwing", () => {
    // Arrange: 本文が空文字でも整形できること（エッジケース）。
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: "" });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain(DUMMY_ROOM_NAME);
    expect(result.text).toContain(DUMMY_ACCOUNT_ID);
    expect(typeof result.text).toBe("string");
  });

  describe("sender display priority (REQ-002 / REQ-005)", () => {
    it("uses senderName when it is set (priority over accountId)", () => {
      // Arrange: senderName が設定されている場合は accountId より優先（設計 §2）。
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body: DUMMY_BODY,
        senderName: DUMMY_SENDER_NAME,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: 表示名が含まれ、accountId は送信者行に立たない（"<senderName>:\n" の形）。
      expect(result.text).toContain(`${DUMMY_SENDER_NAME}:`);
      expect(result.text).not.toContain(`${DUMMY_ACCOUNT_ID}:`);
    });

    it("falls back to accountId when senderName is null and accountId is set", () => {
      // Arrange: senderName=null → accountId へフォールバック（resolve-sender が解決できない場合）。
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body: DUMMY_BODY,
        senderName: null,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert
      expect(result.text).toContain(`${DUMMY_ACCOUNT_ID}:`);
    });

    it("falls back to UNKNOWN_SENDER_LABEL when both senderName and accountId are null", () => {
      // Arrange: 両方 null → 最終フォールバックラベル "unknown"。
      const message = msg({
        accountId: null,
        body: DUMMY_BODY,
        senderName: null,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: UNKNOWN_SENDER_LABEL が送信者行に立つ。
      expect(result.text).toContain(`${UNKNOWN_SENDER_LABEL}:`);
    });
  });

  describe("body goes through renderChatworkBody (REQ-007 / 設計 §4.3)", () => {
    it("converts [download:<id>]<name>[/download] to '📎 <name>' and known emoticons to unicode", () => {
      // Arrange: download タグ + 既知絵文字ショートコードが含まれた本文。
      const expectedBlush = CHATWORK_EMOTICONS["(blush)"];
      const body = "[download:1]name.pdf[/download] (blush)";
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body,
        senderName: DUMMY_SENDER_NAME,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: 整形済みのテキスト（タグは可読化、絵文字は unicode 化）。
      expect(result.text).toContain("📎 name.pdf");
      expect(result.text).toContain(expectedBlush);
      // 生のタグ・ショートコードは残らない。
      expect(result.text).not.toContain("[download:1]");
      expect(result.text).not.toContain("[/download]");
      expect(result.text).not.toContain("(blush)");
    });
  });

  describe("quote '>' preservation vs mid-line escaping (設計 §4.5)", () => {
    it("preserves line-leading '> ' for [qt] blocks (Slack quote rendering)", () => {
      // Arrange: [qt][qtmeta]<inner>[/qt] が複数行に展開され、各行頭に '> ' が付く。
      const body = "[qt][qtmeta aid=1]\nLine1\nLine2[/qt]";
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body,
        senderName: DUMMY_SENDER_NAME,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: 引用行頭は Slack 引用ブロックとして解釈される `> ` のまま（&gt; ではない）。
      expect(result.text).toContain("> Line1");
      expect(result.text).toContain("> Line2");
      expect(result.text).not.toContain("&gt; Line1");
      expect(result.text).not.toContain("&gt; Line2");
    });

    it("still escapes a mid-line '>' as '&gt;' (mention injection guard preserved)", () => {
      // Arrange: 本文中（行の途中）の '>' は外部由来の文字としてエスケープを維持する。
      const body = "if x > 0";
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body,
        senderName: DUMMY_SENDER_NAME,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: 行中 '>' は &gt; 化される（行頭復元の正規表現にマッチしない）。
      expect(result.text).toContain("if x &gt; 0");
      expect(result.text).not.toContain("if x > 0");
    });
  });

  describe("Chatwork deep link is appended verbatim (REQ-006)", () => {
    it("ends the text with the mrkdwn link to the source Chatwork message", () => {
      // Arrange
      const message = msg({
        accountId: DUMMY_ACCOUNT_ID,
        body: DUMMY_BODY,
        senderName: DUMMY_SENDER_NAME,
      });
      const room = { name: DUMMY_ROOM_NAME };

      // Act
      const result = format(message, room);

      // Assert: 最終行は `<https://...#!rid{room}-{message}|Chatworkで開く>` の固定形。
      const lines = result.text.split("\n");
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toBe(
        `<https://www.chatwork.com/#!rid${DUMMY_ROOM_ID}-${DUMMY_MESSAGE_ID}|Chatworkで開く>`,
      );
    });
  });

  it("returns a payload whose shape is exactly { text: string } with NO Block Kit / action keys", () => {
    // Arrange: 本フェーズはアクションボタン・Block Kit を含めない（REQ-008 / 設計 §4.7）。
    const message = msg({ accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY });
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert: ペイロードは厳密に { text: string } の 1 キーのみ。
    expect(Object.keys(result)).toEqual(["text"]);
    expect(typeof result.text).toBe("string");

    // Assert: Block Kit / action 関連のキーが一切存在しないこと。
    const payload = result as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty("blocks");
    expect(payload).not.toHaveProperty("attachments");
    expect(payload).not.toHaveProperty("actions");

    // Assert: JSON シリアライズにも Block Kit / action の痕跡が無いこと。
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("blocks");
    expect(serialized).not.toContain("attachments");
    expect(serialized).not.toContain('"actions"');
    expect(serialized).not.toContain("action_id");
  });
});
