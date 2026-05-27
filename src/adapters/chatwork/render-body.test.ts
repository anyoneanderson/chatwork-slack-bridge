import { describe, expect, it } from "vitest";

import { CHATWORK_EMOTICONS } from "@/adapters/chatwork/chatwork-emoticons";
import { renderChatworkBody } from "@/adapters/chatwork/render-body";

// 注意: テスト本文に実 account_id・実氏名・実ファイル名・実本文は含めない（CON-002）。

describe("renderChatworkBody — emoticons", () => {
  it("replaces a known emoticon with its mapped unicode emoji", () => {
    // Arrange
    const expectedBlush = CHATWORK_EMOTICONS["(blush)"];
    const input = "hello (blush) world";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe(`hello ${expectedBlush} world`);
  });

  it("keeps unknown emoticon shortcodes unchanged", () => {
    // Arrange: 辞書に無いショートコードは原文維持（誤マッピングよりも維持を優先）。
    const input = "before (unknownEmojiXyz) after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("before (unknownEmojiXyz) after");
  });

  it("replaces multiple occurrences of a known emoticon (replaceAll semantics)", () => {
    // Arrange
    const expectedYes = CHATWORK_EMOTICONS["(yes)"];
    const input = "(yes) and (yes) again";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe(`${expectedYes} and ${expectedYes} again`);
  });
});

describe("renderChatworkBody — download / preview / dtext", () => {
  it("converts [download:<id>]<inner>[/download] to '📎 <inner>'", () => {
    // Arrange: ダミーのファイル名（実ファイル名ではない）。
    const input = "[download:1234]dummy-file.pdf (12MB)[/download]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("📎 dummy-file.pdf (12MB)");
  });

  it("removes [preview id=<id> ht=<h>] entirely", () => {
    // Arrange
    const input = "before[preview id=1 ht=200]after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("beforeafter");
  });

  it("removes [preview id=<id>] entirely (without ht=)", () => {
    // Arrange
    const input = "before[preview id=42]after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("beforeafter");
  });

  it("converts [dtext:file_uploaded] to the known system label", () => {
    // Arrange
    const input = "[dtext:file_uploaded]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("ファイルをアップロードしました");
  });

  it("removes unknown [dtext:<key>] tokens", () => {
    // Arrange
    const input = "X[dtext:unknown_key]Y";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("XY");
  });
});

describe("renderChatworkBody — block tags", () => {
  it("converts [title]<inner>[/title] to '\\n<inner>\\n'", () => {
    // Arrange
    const input = "[title]ヘッダ[/title]";

    // Act
    const output = renderChatworkBody(input);

    // Assert: 設計 §4.3「前後に改行を入れて素テキスト化」。
    expect(output).toBe("\nヘッダ\n");
  });

  it("unwraps [info]<inner>[/info] to its inner text", () => {
    // Arrange
    const input = "[info]中身[/info]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("中身");
  });

  it("turns [qt][qtmeta ...]\\n<lines>[/qt] into '> '-prefixed quote lines", () => {
    // Arrange: qtmeta は除去され、本文行に `> ` が付く（前後の改行は剥がれる）。
    const input = "[qt][qtmeta aid=1 time=2]\nLine1\nLine2[/qt]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("> Line1\n> Line2");
  });
});

describe("renderChatworkBody — mentions / picons / hr", () => {
  it("removes [To:<aid>] tokens while keeping the surrounding text", () => {
    // Arrange
    const input = "[To:111]hi";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("hi");
  });

  it("removes [rp aid=<aid> to=<rid>-<mid>] tokens while keeping the surrounding text", () => {
    // Arrange
    const input = "[rp aid=222 to=33-44]hi";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("hi");
  });

  it("removes [picon:<aid>] tokens entirely", () => {
    // Arrange
    const input = "before[picon:111]after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("beforeafter");
  });

  it("removes [piconname:<aid>] tokens entirely", () => {
    // Arrange
    const input = "before[piconname:111]after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("beforeafter");
  });

  it("converts [hr] to '---'", () => {
    // Arrange
    const input = "A[hr]B";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("A---B");
  });
});

describe("renderChatworkBody — unknown tags", () => {
  it("keeps an unknown [bogus]...[/bogus] tag pair as-is (no destruction)", () => {
    // Arrange: 未知の `[...]` タグは原文維持（壊さない方針 / 設計 §4.3）。
    const input = "[bogus]content[/bogus]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("[bogus]content[/bogus]");
  });

  it("keeps unknown self-closing-looking tokens as-is", () => {
    // Arrange
    const input = "x [whatever attr=1] y";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("x [whatever attr=1] y");
  });
});

describe("renderChatworkBody — combined / end-to-end", () => {
  it("handles [info] wrapping [download] and emoticons together", () => {
    // Arrange: タグ → 絵文字 の順で適用されるため、info を剥がした後に (blush) が置換される。
    const expectedBlush = CHATWORK_EMOTICONS["(blush)"];
    const input = "[info][download:1234]dummy-file.pdf (12MB)[/download] (blush)[/info]";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe(`📎 dummy-file.pdf (12MB) ${expectedBlush}`);
  });

  it("handles a quote followed by mentions, a preview and a known dtext", () => {
    // Arrange
    const input =
      "[qt][qtmeta aid=1 time=2]\nLine1\nLine2[/qt]\n[To:111][rp aid=222 to=33-44]hi\n[preview id=1 ht=200][dtext:file_uploaded]";

    // Act
    const output = renderChatworkBody(input);

    // Assert: qt が `> ` 付き、To/rp/preview は除去、dtext は既知文言、emoticon は無し。
    expect(output).toBe("> Line1\n> Line2\nhi\nファイルをアップロードしました");
  });
});

describe("renderChatworkBody — ASCII emoticons (#22)", () => {
  it("replaces each ASCII emoticon with its mapped unicode emoji", () => {
    // Arrange: Chatwork の ASCII 系絵文字（顔文字）が変換されること（受け入れ基準）。
    const cases: ReadonlyArray<[string, string]> = [
      ["8-)", CHATWORK_EMOTICONS["8-)"]],
      [":)", CHATWORK_EMOTICONS[":)"]],
      [";)", CHATWORK_EMOTICONS[";)"]],
      [":D", CHATWORK_EMOTICONS[":D"]],
      [":p", CHATWORK_EMOTICONS[":p"]],
      [":o", CHATWORK_EMOTICONS[":o"]],
      [":(", CHATWORK_EMOTICONS[":("]],
      [";(", CHATWORK_EMOTICONS[";("]],
      [":|", CHATWORK_EMOTICONS[":|"]],
      [":^)", CHATWORK_EMOTICONS[":^)"]],
      ["|-)", CHATWORK_EMOTICONS["|-)"]],
      [":!", CHATWORK_EMOTICONS[":!"]],
      [":?", CHATWORK_EMOTICONS[":?"]],
      [":#", CHATWORK_EMOTICONS[":#"]],
    ];

    // Act + Assert
    for (const [code, expected] of cases) {
      expect(renderChatworkBody(`pre ${code} post`)).toBe(`pre ${expected} post`);
    }
  });

  it("does not let `:|` cannibalize `,':|` (longest-key-first substring guard)", () => {
    // Arrange: `,':|`（冷や汗）は末尾に `:|` を含む。降順ソートが効いていなければ `:|`
    // が先に置換されて `,':|` が崩れる。
    const expectedColdSweat = CHATWORK_EMOTICONS[",':|"];
    const input = "hello ,':| world";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe(`hello ${expectedColdSweat} world`);
  });

  it("handles ASCII emoticons without surrounding whitespace (Chatwork-style inline)", () => {
    // Arrange: ユーザは `テスト8-):p` のように空白なしで連結することがある。
    // Slack 側の :emoji: パーサとぶつからないよう、ASCII 系も置換できる必要がある。
    const expectedCool = CHATWORK_EMOTICONS["8-)"];
    const expectedTongue = CHATWORK_EMOTICONS[":p"];
    const input = "テスト8-):p";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe(`テスト${expectedCool}${expectedTongue}`);
  });

  it("does not convert ASCII tokens that are not in the dictionary", () => {
    // Arrange: 例として `:x` は辞書に無いため原文維持。
    const input = "before :x after";

    // Act
    const output = renderChatworkBody(input);

    // Assert
    expect(output).toBe("before :x after");
  });
});

describe("renderChatworkBody — additional paren emoticons (#22)", () => {
  it("replaces newly added paren-style emoticons", () => {
    // Arrange: #22 で追加された主要 paren 系絵文字。
    const cases: ReadonlyArray<[string, string]> = [
      ["(nod)", CHATWORK_EMOTICONS["(nod)"]],
      ["(shake)", CHATWORK_EMOTICONS["(shake)"]],
      ["(bow)", CHATWORK_EMOTICONS["(bow)"]],
      ["(roger)", CHATWORK_EMOTICONS["(roger)"]],
      ["(please)", CHATWORK_EMOTICONS["(please)"]],
      ["(quick)", CHATWORK_EMOTICONS["(quick)"]],
      ["(anger)", CHATWORK_EMOTICONS["(anger)"]],
      ["(F)", CHATWORK_EMOTICONS["(F)"]],
      ["(*)", CHATWORK_EMOTICONS["(*)"]],
      ["(^)", CHATWORK_EMOTICONS["(^)"]],
      ["(:/)", CHATWORK_EMOTICONS["(:/)"]],
    ];

    // Act + Assert
    for (const [code, expected] of cases) {
      expect(renderChatworkBody(`x ${code} y`)).toBe(`x ${expected} y`);
    }
  });
});

describe("renderChatworkBody — purity", () => {
  it("is deterministic: identical input yields identical output", () => {
    // Arrange
    const input = "[info](blush)[download:1][hr][/download][/info]";

    // Act
    const first = renderChatworkBody(input);
    const second = renderChatworkBody(input);

    // Assert: 同一入力に対する出力が一致する（内部状態に依存しない）。
    expect(first).toBe(second);
  });

  it("does not mutate the input string", () => {
    // Arrange: JS の string は不変だが、契約として明示する。
    const input = "[info]hi[/info] (blush)";
    const snapshot = input;

    // Act
    renderChatworkBody(input);

    // Assert
    expect(input).toBe(snapshot);
  });
});
