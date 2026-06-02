import { describe, expect, it } from "vitest";

import { extractAttachments } from "@/adapters/chatwork/extract-attachments";

// DUMMY 値（実ファイル名・実 file_id を含まない / CON-002）。
const DUMMY_FILENAME_A = "dummy attachment file.png";

describe("extractAttachments", () => {
  it("returns an empty array when the body has no attachments", () => {
    // Arrange
    const body = "just a plain dummy message body with no download tags";

    // Act & Assert
    expect(extractAttachments(body)).toEqual([]);
  });

  it("returns an empty array for an empty body", () => {
    expect(extractAttachments("")).toEqual([]);
  });

  it("extracts a single attachment file_id", () => {
    // Arrange
    const body = `hello [download:111]${DUMMY_FILENAME_A} (1.2KB)[/download] bye`;

    // Act & Assert
    expect(extractAttachments(body)).toEqual([{ fileId: "111" }]);
  });

  it("extracts multiple attachment file_ids preserving order", () => {
    // Arrange
    const body =
      `[download:111]first.png (1KB)[/download]\n` +
      `[download:222]second.pdf (2KB)[/download]\n` +
      `[download:333]third.gif (3KB)[/download]`;

    // Act & Assert
    expect(extractAttachments(body)).toEqual([
      { fileId: "111" },
      { fileId: "222" },
      { fileId: "333" },
    ]);
  });

  it("deduplicates a repeated file_id while preserving first-seen order", () => {
    // Arrange: webhook 異常等で同一 file_id が重複しても 1 件に集約し初出順を保つ。
    const body =
      `[download:111]a (1KB)[/download]` +
      `[download:222]b (2KB)[/download]` +
      `[download:111]a-again (1KB)[/download]`;

    // Act & Assert
    expect(extractAttachments(body)).toEqual([{ fileId: "111" }, { fileId: "222" }]);
  });

  it("ignores standalone [preview] tags without a download tag", () => {
    // Arrange: [preview id=...] 単独は添付実体取得の対象外（ASM-002）。
    const body = "look at this [preview id=999 ht=120] inline image";

    // Act & Assert
    expect(extractAttachments(body)).toEqual([]);
  });

  it("ignores [preview] but still extracts an accompanying [download] tag", () => {
    // Arrange: preview と download が混在しても download のみ拾う。
    const body = `[preview id=999 ht=120][download:111]${DUMMY_FILENAME_A} (1KB)[/download]`;

    // Act & Assert
    expect(extractAttachments(body)).toEqual([{ fileId: "111" }]);
  });

  it("does not break on malformed tags (missing closing tag / non-numeric id)", () => {
    // Arrange: 閉じタグ欠落・非数値 id は拾わない（壊れた本文で例外を出さない）。
    const body =
      `[download:abc]not-numeric[/download] ` +
      `[download:111 unclosed... ` +
      `[download:]empty[/download]`;

    // Act & Assert: 数値 id + 閉じタグが揃ったものだけ。ここでは該当なし → 空配列。
    expect(extractAttachments(body)).toEqual([]);
  });

  it("handles a long filename containing spaces and parentheses", () => {
    // Arrange: スペース・括弧を含む長いダミーファイル名でも file_id だけ正しく抽出する。
    const longName = "a very long dummy file name with (parens) and spaces 2026.png";
    const body = `[download:444]${longName} (12.34 MB)[/download]`;

    // Act & Assert
    expect(extractAttachments(body)).toEqual([{ fileId: "444" }]);
  });

  it("extracts across newlines inside the download tag content", () => {
    // Arrange: タグ内容が改行を含んでも非貪欲マッチで拾う。
    const body = "[download:555]name\nwith newline (1KB)[/download]";

    // Act & Assert
    expect(extractAttachments(body)).toEqual([{ fileId: "555" }]);
  });
});
