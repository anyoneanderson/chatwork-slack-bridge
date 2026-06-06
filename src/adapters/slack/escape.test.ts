import { describe, expect, it } from "vitest";

import { escapeSlackText } from "@/adapters/slack/escape";

describe("escapeSlackText", () => {
  it("escapes & first, then < and > (Slack-recommended order)", () => {
    // `&` を最初に処理しないと後続置換で生じた `&` を多重エスケープしてしまうため、
    // 順序（& → < → >）が崩れていないことを検証する。
    expect(escapeSlackText("&")).toBe("&amp;");
    expect(escapeSlackText("<")).toBe("&lt;");
    expect(escapeSlackText(">")).toBe("&gt;");
  });

  it("neutralizes Slack broadcast control sequences (<!channel> 等)", () => {
    // 通知インジェクション対策の核心: `<!channel>` がそのまま一斉メンションにならないこと。
    expect(escapeSlackText("<!channel>")).toBe("&lt;!channel&gt;");
    expect(escapeSlackText("<!here>")).toBe("&lt;!here&gt;");
    expect(escapeSlackText("<!everyone>")).toBe("&lt;!everyone&gt;");
  });

  it("neutralizes user mention sequences (<@U…>)", () => {
    expect(escapeSlackText("<@U12345678>")).toBe("&lt;@U12345678&gt;");
  });

  it("escapes a combined sequence in the correct order without double-escaping", () => {
    // `&` を含む文字列でも、新たに生じた `&amp;` の `&` を再エスケープしない。
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeSlackText("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("leaves text without control characters unchanged", () => {
    const plain = "了解しました、明日までに対応します。";
    expect(escapeSlackText(plain)).toBe(plain);
  });

  it("returns an empty string for empty input", () => {
    expect(escapeSlackText("")).toBe("");
  });

  it("is NOT idempotent: re-applying double-escapes the produced ampersands", () => {
    // 二重適用が安全でないこと（呼び出し側は 1 回だけ適用する前提）を明示するガード。
    const once = escapeSlackText("<a>");
    expect(once).toBe("&lt;a&gt;");
    const twice = escapeSlackText(once);
    expect(twice).toBe("&amp;lt;a&amp;gt;");
    expect(twice).not.toBe(once);
  });
});
