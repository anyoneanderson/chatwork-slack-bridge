import { describe, expect, it } from "vitest";
import {
  confirmationMessage,
  plainMessage,
  slackReplyToPlainText,
} from "@/app/services/google-chat/presentation";

describe("Google Chat の Slack 表示", () => {
  it("外部本文や表示名のメンション・リンク記法を plain_text に保つ", () => {
    const externalText =
      "Dummy <!channel> & <@UDUMMY>\n<https://example.test/untrusted|Google Chat で開く>";
    const message = plainMessage(externalText);
    expect(message.blocks).toEqual([
      {
        type: "section",
        text: { type: "plain_text", text: externalText, emoji: false },
      },
    ]);
    expect(message.text).toBe(
      "Dummy &lt;!channel&gt; &amp; &lt;@UDUMMY&gt;\n&lt;https://example.test/untrusted|Google Chat で開く&gt;",
    );
    // メッセージリンク生成は resource を検証する専用ヘルパが担当する。
    // 外部テキストの URL は mrkdwn・ボタンの URL へ変換しない。
    expect(
      message.blocks?.some((block) => block.type === "actions" || block.type === "context"),
    ).toBe(false);
  });

  it("確認画面のスペース名・アカウント・返信本文も plain_text に保つ", () => {
    const message = confirmationMessage(
      "dummy-outbound",
      "<@UDUMMY>",
      "<!here>",
      "<https://example.test|dummy> & reply",
    );
    expect(message.blocks?.[0]).toEqual({
      type: "section",
      text: {
        type: "plain_text",
        text: "Google Chat に送信しますか？\nスペース: <!here>\n送信アカウント: <@UDUMMY>\n\n<https://example.test|dummy> & reply",
        emoji: false,
      },
    });
    expect(message.text).not.toMatch(/<|>/);
    expect(message.blocks?.[1]).toMatchObject({
      type: "actions",
      elements: [
        { action_id: "gc_send", value: "dummy-outbound" },
        { action_id: "gc_cancel", value: "dummy-outbound" },
        { action_id: "gc_check", value: "dummy-outbound" },
      ],
    });
  });

  it("35000文字は本文を欠落させず Slack の section 上限内に分割する", () => {
    const text = "a".repeat(35000);
    const message = plainMessage(text);
    expect(message.text).toBe(text);
    const parts = (message.blocks ?? []).map((block) => {
      expect(block.type).toBe("section");
      const textObject = block.text as { type: string; text: string };
      expect(textObject.type).toBe("plain_text");
      expect(textObject.text.length).toBeLessThanOrEqual(3000);
      return textObject.text;
    });
    expect(parts.join("")).toBe(text);
  });

  it("エスケープで35000文字を超える fallback は固定文とし本文を blocks に残す", () => {
    const text = "&".repeat(10000);
    const message = plainMessage(text);
    expect(message.text).toBe(
      "Google Chat のメッセージです。本文はメッセージの詳細表示で確認してください。",
    );
    expect(message.text.length).toBeLessThanOrEqual(35000);
    expect(message.blocks?.map((block) => (block.text as { text: string }).text).join("")).toBe(
      text,
    );
  });

  it("35000文字を超える本文は切り詰めて送らず拒否する", () => {
    expect(() => plainMessage("a".repeat(35001))).toThrow(
      "Google Chat Slack display exceeds supported size",
    );
  });

  it("確認文を足すと上限を超える返信も送信ボタンを作らず拒否する", () => {
    expect(() =>
      confirmationMessage("dummy-outbound", "dummy@example.test", "Dummy", "a".repeat(35000)),
    ).toThrow("Google Chat Slack display exceeds supported size");
  });
});

describe("Slack 返信のプレーンテキスト変換", () => {
  it.each([
    ["<https://example.test/path|表示名>", "https://example.test/path"],
    ["<http://example.test/path>", "http://example.test/path"],
    ["<mailto:dummy@example.test|Dummy>", "dummy@example.test"],
    ["<mailto:dummy@example.test>", "dummy@example.test"],
    ["<@UDUMMY|Dummy> <@UOTHER>", "@UDUMMY @UOTHER"],
    ["<#CDUMMY|Dummy channel> <#COTHER>", "#CDUMMY #COTHER"],
    ["<!channel> <!here|here> <!subteam^SDUMMY|Team>", "[channel] [here] [subteam^SDUMMY]"],
  ])("%s を表示名の推測なしで変換する", (input, expected) => {
    expect(slackReplyToPlainText(input)).toBe(expected);
  });

  it("HTML entitiesは一度だけdecodeし、decode結果を再びSlack記法として処理しない", () => {
    expect(
      slackReplyToPlainText("&amp;lt; &amp;gt; &amp;amp; &lt;@UDUMMY&gt; &lt; &gt; &amp;"),
    ).toBe("&lt; &gt; &amp; <@UDUMMY> < > &");
  });

  it("リンクのqueryに含まれるampも一度だけdecodeする", () => {
    expect(slackReplyToPlainText("<https://example.test/?a=1&amp;b=2|Dummy>")).toBe(
      "https://example.test/?a=1&b=2",
    );
  });
});
