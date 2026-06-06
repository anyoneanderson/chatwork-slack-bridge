import { describe, expect, it } from "vitest";

import {
  buildConfirmBlocks,
  buildResultMessage,
  SLACK_ACTION_CANCEL,
  SLACK_ACTION_SEND,
} from "@/adapters/slack/confirm-message";

// DUMMY 値（実 outbound id・実本文を含まない / CON-003）。
const DUMMY_OUTBOUND_ID = "12345";
const DUMMY_BODY = "了解しました、明日までに対応します";

/** actions ブロックから { action_id, value, style?, text } の配列を取り出すヘルパ。 */
function extractButtons(blocks: ReturnType<typeof buildConfirmBlocks>): Array<{
  action_id?: unknown;
  value?: unknown;
  style?: unknown;
  text?: { text?: unknown };
}> {
  const actions = blocks.find((b) => b.type === "actions");
  const elements = (actions as { elements?: unknown } | undefined)?.elements;
  return Array.isArray(elements) ? elements : [];
}

describe("buildConfirmBlocks", () => {
  it("includes a section with the prompt and a quoted body", () => {
    // Act
    const blocks = buildConfirmBlocks({ quotedBody: DUMMY_BODY, outboundId: DUMMY_OUTBOUND_ID });

    // Assert
    const section = blocks.find((b) => b.type === "section");
    expect(section).toBeDefined();
    const text = (section as { text?: { text?: string } }).text?.text ?? "";
    expect(text).toContain("この内容を Chatwork に送信しますか？");
    expect(text).toContain(`> ${DUMMY_BODY}`);
  });

  it("renders the send button as primary with action_id=cw_send and value=outboundId", () => {
    // Act
    const buttons = extractButtons(
      buildConfirmBlocks({ quotedBody: DUMMY_BODY, outboundId: DUMMY_OUTBOUND_ID }),
    );

    // Assert
    const send = buttons.find((b) => b.action_id === SLACK_ACTION_SEND);
    expect(send).toBeDefined();
    expect(send?.action_id).toBe("cw_send");
    expect(send?.style).toBe("primary");
    expect(send?.value).toBe(DUMMY_OUTBOUND_ID);
    expect(send?.text?.text).toBe("送信");
  });

  it("renders the cancel button with action_id=cw_cancel and value=outboundId", () => {
    // Act
    const buttons = extractButtons(
      buildConfirmBlocks({ quotedBody: DUMMY_BODY, outboundId: DUMMY_OUTBOUND_ID }),
    );

    // Assert
    const cancel = buttons.find((b) => b.action_id === SLACK_ACTION_CANCEL);
    expect(cancel).toBeDefined();
    expect(cancel?.action_id).toBe("cw_cancel");
    expect(cancel?.value).toBe(DUMMY_OUTBOUND_ID);
    expect(cancel?.text?.text).toBe("キャンセル");
    // キャンセルは primary ではない。
    expect(cancel?.style).toBeUndefined();
  });

  it("escapes Slack control sequences (<!channel>) in the quoted body (NFR-002)", () => {
    // Arrange: 通知インジェクションを誘発しうる外部由来本文。
    const malicious = "<!channel> 全員に通知 <@U12345678>";

    // Act
    const blocks = buildConfirmBlocks({ quotedBody: malicious, outboundId: DUMMY_OUTBOUND_ID });
    const section = blocks.find((b) => b.type === "section");
    const text = (section as { text?: { text?: string } }).text?.text ?? "";

    // Assert: 生の制御シーケンスが残らずエスケープされている。
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U12345678>");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;@U12345678&gt;");
  });

  it("renders a multi-line quoted body with a leading quote marker on each line", () => {
    // Act
    const blocks = buildConfirmBlocks({
      quotedBody: "line one\nline two",
      outboundId: DUMMY_OUTBOUND_ID,
    });
    const section = blocks.find((b) => b.type === "section");
    const text = (section as { text?: { text?: string } }).text?.text ?? "";

    // Assert
    expect(text).toContain("> line one");
    expect(text).toContain("> line two");
  });
});

describe("buildResultMessage", () => {
  it.each([
    ["sent", "✅ 送信しました"],
    ["failed", "❌ 送信に失敗しました。もう一度返信して操作し直してください"],
    ["cancelled", "🚫 キャンセルしました"],
    ["forbidden", "⛔ この操作を行う権限がありません"],
  ] as const)("returns the expected text for kind=%s", (kind, expected) => {
    // Act
    const message = buildResultMessage(kind);

    // Assert
    expect(message.text).toBe(expected);
    // ボタン除去のため blocks は付けない。
    expect(message.blocks).toBeUndefined();
  });
});
