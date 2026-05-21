import { describe, expect, it } from "vitest";

import { format } from "@/adapters/slack/format";

// DUMMY 値（実 ID・実本文・実ルーム名・実クライアント名を含まない / CON-005）。
const DUMMY_ROOM_NAME = "dummy room name";
const DUMMY_ACCOUNT_ID = "1234567";
const DUMMY_BODY = "dummy message body";

describe("format", () => {
  it("includes the room name, sender, and body in the formatted text when all fields are present", () => {
    // Arrange
    const message = { accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY };
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
    const message = { accountId: null, body: DUMMY_BODY };
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
    const message = { accountId: DUMMY_ACCOUNT_ID, body: multilineBody };
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain(multilineBody);
  });

  it("escapes Slack control chars (& < >) in body, room name, and sender, ampersand first", () => {
    // Arrange: 信頼できない 3 セグメント（本文・ルーム名・送信者）すべてをエスケープすること。
    const message = { accountId: "a<&>b", body: "x & y < z > w" };
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
    const message = { accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY };
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
    const message = { accountId: DUMMY_ACCOUNT_ID, body: maliciousBody };
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
    const message = { accountId: DUMMY_ACCOUNT_ID, body: "" };
    const room = { name: DUMMY_ROOM_NAME };

    // Act
    const result = format(message, room);

    // Assert
    expect(result.text).toContain(DUMMY_ROOM_NAME);
    expect(result.text).toContain(DUMMY_ACCOUNT_ID);
    expect(typeof result.text).toBe("string");
  });

  it("returns a payload whose shape is exactly { text: string } with NO Block Kit / action keys", () => {
    // Arrange: 本フェーズはアクションボタン・Block Kit を含めない（REQ-008 / 設計 §4.7）。
    const message = { accountId: DUMMY_ACCOUNT_ID, body: DUMMY_BODY };
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
