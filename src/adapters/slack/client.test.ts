import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSlackClient, SlackApiError } from "@/adapters/slack/client";
import type { SlackUploadFileInput } from "@/adapters/slack/types";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";

// DUMMY 値（実 token・実 ID・実本文を含まない / CON-002・CON-005）。
const DUMMY_BOT_TOKEN = "xoxb-dummy-0000-0000-dummytoken";
const DUMMY_CHANNEL_ID = toSlackChannelId("C0DUMMYCHANNEL");
const DUMMY_TS = "1700000000.000100";
const DUMMY_TEXT = "dummy formatted text";

// 1×1px の透過 PNG（ダミーバイナリ / CON-002: 実バイナリは使わない）。
const DUMMY_PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// @slack/web-api をアダプタ境界でモックする（ネットワーク非依存 / coding-rules SHOULD）。
// postMessage / files.uploadV2 の振る舞いは各テストでモックに差し替える。
const postMessageMock = vi.fn();
const uploadV2Mock = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    public chat: { postMessage: typeof postMessageMock };
    public files: { uploadV2: typeof uploadV2Mock };
    constructor(public token: string) {
      this.chat = { postMessage: postMessageMock };
      this.files = { uploadV2: uploadV2Mock };
    }
  },
}));

/**
 * uploadFile に渡す入力（DUMMY のみ / CON-002）。テストごとに差分が要れば override する。
 */
function makeUploadInput(override: Partial<SlackUploadFileInput> = {}): SlackUploadFileInput {
  return {
    channelId: DUMMY_CHANNEL_ID,
    threadTs: toSlackTs(DUMMY_TS),
    filename: "dummy.png",
    mimeType: "image/png",
    bytes: DUMMY_PNG_BYTES,
    ...override,
  };
}

beforeEach(() => {
  postMessageMock.mockReset();
  uploadV2Mock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSlackClient.postMessage", () => {
  it("returns { ts } and calls chat.postMessage with the channel and text on success", async () => {
    // Arrange
    postMessageMock.mockResolvedValue({ ok: true, ts: DUMMY_TS });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    const result = await client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT });

    // Assert
    expect(result).toEqual({ ts: DUMMY_TS });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith({
      channel: DUMMY_CHANNEL_ID,
      text: DUMMY_TEXT,
    });
  });

  it("throws SlackApiError exposing the Slack error code when the SDK throws an error with data.error", async () => {
    // Arrange: SDK は API エラーで例外を送出し data.error にコードを載せる。
    postMessageMock.mockRejectedValue({
      data: { error: "channel_not_found" },
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toMatchObject({
      op: "slack.postMessage",
      channelId: DUMMY_CHANNEL_ID,
      slackError: "channel_not_found",
    });
  });

  it("throws SlackApiError when the SDK throws an error without a recognizable data.error code", async () => {
    // Arrange: ネットワーク失敗等、コードを抽出できない例外。
    postMessageMock.mockRejectedValue(new Error("network down"));
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toMatchObject({
      op: "slack.postMessage",
      channelId: DUMMY_CHANNEL_ID,
      slackError: undefined,
    });
  });

  it("throws SlackApiError when the response is ok: false", async () => {
    // Arrange: SDK が例外化せず ok:false を返すケース。
    postMessageMock.mockResolvedValue({ ok: false, error: "not_in_channel" });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toMatchObject({
      op: "slack.postMessage",
      slackError: "not_in_channel",
    });
  });

  it("throws SlackApiError when the response is ok but ts is missing", async () => {
    // Arrange: ok:true だが ts が無いケース。
    postMessageMock.mockResolvedValue({ ok: true });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.postMessage(DUMMY_CHANNEL_ID, { text: DUMMY_TEXT })).rejects.toBeInstanceOf(
      SlackApiError,
    );
  });

  it("never leaks the bot token or message body in the thrown error message or its serialization", async () => {
    // Arrange: token・本文を含む可能性のある経路（例外にダミー秘密を載せる）を組む。
    const leakBaitBody = "leak-bait-message-body";
    postMessageMock.mockRejectedValue({
      data: { error: "rate_limited" },
      // 生エラーに token / 本文が紛れ込むことを模した汚染フィールド。
      token: DUMMY_BOT_TOKEN,
      requestBody: leakBaitBody,
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    let caught: unknown;
    try {
      await client.postMessage(DUMMY_CHANNEL_ID, { text: leakBaitBody });
    } catch (err) {
      caught = err;
    }

    // Assert: メッセージ・JSON シリアライズ・全列挙プロパティのいずれにも token・本文を含まない。
    expect(caught).toBeInstanceOf(SlackApiError);
    const error = caught as SlackApiError;
    const serialized = `${error.message} ${JSON.stringify({ ...error })} ${JSON.stringify({
      name: error.name,
      message: error.message,
      op: error.op,
      channelId: error.channelId,
      slackError: error.slackError,
    })}`;
    expect(serialized).not.toContain(DUMMY_BOT_TOKEN);
    expect(serialized).not.toContain(leakBaitBody);
    // 安全なエラーコード（識別子）は伝わってよい。
    expect(error.slackError).toBe("rate_limited");
  });
});

describe("createSlackClient.uploadFile", () => {
  const DUMMY_FILE_ID = "F0DUMMYFILEID";

  it("extracts file.id from the current SDK nested shape ({ files: [{ files: [{ id }] }] })", async () => {
    // Arrange: 現行 SDK 主形（入れ子）。
    uploadV2Mock.mockResolvedValue({
      ok: true,
      files: [{ files: [{ id: DUMMY_FILE_ID }] }],
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    const result = await client.uploadFile(makeUploadInput());

    // Assert
    expect(result).toEqual({ slackFileId: DUMMY_FILE_ID });
    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
  });

  it("extracts file.id from legacy flat shape a ({ files: [{ id }] })", async () => {
    // Arrange: 旧形 a（フラット）。
    uploadV2Mock.mockResolvedValue({
      ok: true,
      files: [{ id: DUMMY_FILE_ID }],
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    const result = await client.uploadFile(makeUploadInput());

    // Assert
    expect(result).toEqual({ slackFileId: DUMMY_FILE_ID });
  });

  it("extracts file.id from legacy single-file shape b ({ file: { id } })", async () => {
    // Arrange: 旧形 b（単一 file）。
    uploadV2Mock.mockResolvedValue({
      ok: true,
      file: { id: DUMMY_FILE_ID },
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    const result = await client.uploadFile(makeUploadInput());

    // Assert
    expect(result).toEqual({ slackFileId: DUMMY_FILE_ID });
  });

  it("throws SlackApiError when the response has no recognizable file id", async () => {
    // Arrange: ok:true だがどの形にも id が無い（レスポンス形ブレ・欠落）。
    uploadV2Mock.mockResolvedValue({
      ok: true,
      files: [{ files: [{}] }],
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.uploadFile(makeUploadInput())).rejects.toBeInstanceOf(SlackApiError);
    await expect(client.uploadFile(makeUploadInput())).rejects.toMatchObject({
      op: "slack.uploadFile",
      channelId: DUMMY_CHANNEL_ID,
    });
  });

  it("throws SlackApiError when the response is ok: false", async () => {
    // Arrange: SDK が例外化せず ok:false を返すケース。
    uploadV2Mock.mockResolvedValue({ ok: false, error: "not_in_channel" });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.uploadFile(makeUploadInput())).rejects.toBeInstanceOf(SlackApiError);
    await expect(client.uploadFile(makeUploadInput())).rejects.toMatchObject({
      op: "slack.uploadFile",
      channelId: DUMMY_CHANNEL_ID,
      slackError: "not_in_channel",
    });
  });

  it("throws SlackApiError exposing the Slack error code when the SDK throws", async () => {
    // Arrange: SDK は API エラーで例外を送出し data.error にコードを載せる。
    uploadV2Mock.mockRejectedValue({ data: { error: "rate_limited" } });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.uploadFile(makeUploadInput())).rejects.toBeInstanceOf(SlackApiError);
    await expect(client.uploadFile(makeUploadInput())).rejects.toMatchObject({
      op: "slack.uploadFile",
      channelId: DUMMY_CHANNEL_ID,
      slackError: "rate_limited",
    });
  });

  it("throws SlackApiError when the SDK throws without a recognizable data.error code", async () => {
    // Arrange: ネットワーク失敗等、コードを抽出できない例外。
    uploadV2Mock.mockRejectedValue(new Error("network down"));
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act & Assert
    await expect(client.uploadFile(makeUploadInput())).rejects.toBeInstanceOf(SlackApiError);
    await expect(client.uploadFile(makeUploadInput())).rejects.toMatchObject({
      op: "slack.uploadFile",
      slackError: undefined,
    });
  });

  it("passes thread_ts (and channel_id / filename) through to files.uploadV2", async () => {
    // Arrange
    uploadV2Mock.mockResolvedValue({ ok: true, files: [{ files: [{ id: DUMMY_FILE_ID }] }] });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });
    const input = makeUploadInput();

    // Act
    await client.uploadFile(input);

    // Assert: thread_ts が確実に uploadV2 へ渡る（REQ-005）。
    expect(uploadV2Mock).toHaveBeenCalledTimes(1);
    const callArg = uploadV2Mock.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      channel_id: DUMMY_CHANNEL_ID,
      thread_ts: DUMMY_TS,
      filename: "dummy.png",
    });
    // MIME は uploadV2 へ渡さない（uploadV2 に MIME 引数は無く、filetype は MIME でなく非推奨）。
    // この設計判断（input.mimeType を SDK に渡さない）を将来のリグレッションから守るガード。
    expect(callArg).not.toHaveProperty("content_type");
    expect(callArg).not.toHaveProperty("filetype");
  });

  it("converts the Uint8Array bytes to a Buffer before passing to files.uploadV2 (ASM-003)", async () => {
    // Arrange
    uploadV2Mock.mockResolvedValue({ ok: true, files: [{ files: [{ id: DUMMY_FILE_ID }] }] });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    await client.uploadFile(makeUploadInput());

    // Assert: file は Buffer で、中身は元のバイト列と一致する。
    const callArg = uploadV2Mock.mock.calls[0]?.[0] as { file: unknown };
    expect(Buffer.isBuffer(callArg.file)).toBe(true);
    expect(Buffer.from(DUMMY_PNG_BYTES).equals(callArg.file as Buffer)).toBe(true);
  });

  it("never leaks the bot token, filename, or bytes in the thrown error or its serialization", async () => {
    // Arrange: token・ファイル名・バイトを含む可能性のある経路（汚染フィールド）を組む。
    const secretFilename = "leak-bait-filename.png";
    uploadV2Mock.mockRejectedValue({
      data: { error: "rate_limited" },
      // 生エラーに token / filename / bytes が紛れ込むことを模した汚染フィールド。
      token: DUMMY_BOT_TOKEN,
      filename: secretFilename,
      bytes: DUMMY_PNG_BYTES,
    });
    const client = createSlackClient({ botToken: DUMMY_BOT_TOKEN });

    // Act
    let caught: unknown;
    try {
      await client.uploadFile(makeUploadInput({ filename: secretFilename }));
    } catch (err) {
      caught = err;
    }

    // Assert: メッセージ・全列挙プロパティのいずれにも token・filename・bytes を含まない。
    expect(caught).toBeInstanceOf(SlackApiError);
    const error = caught as SlackApiError;
    const serialized = `${error.message} ${JSON.stringify({ ...error })} ${JSON.stringify({
      name: error.name,
      message: error.message,
      op: error.op,
      channelId: error.channelId,
      slackError: error.slackError,
    })}`;
    expect(serialized).not.toContain(DUMMY_BOT_TOKEN);
    expect(serialized).not.toContain(secretFilename);
    expect(serialized).not.toContain(Buffer.from(DUMMY_PNG_BYTES).toString("base64"));
    // 安全なエラーコード（識別子）は伝わってよい。
    expect(error.slackError).toBe("rate_limited");
  });
});
