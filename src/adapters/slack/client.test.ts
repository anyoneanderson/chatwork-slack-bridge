import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSlackClient, SlackApiError } from "@/adapters/slack/client";
import { toSlackChannelId } from "@/adapters/slack/types";

// DUMMY 値（実 token・実 ID・実本文を含まない / CON-005）。
const DUMMY_BOT_TOKEN = "xoxb-dummy-0000-0000-dummytoken";
const DUMMY_CHANNEL_ID = toSlackChannelId("C0DUMMYCHANNEL");
const DUMMY_TS = "1700000000.000100";
const DUMMY_TEXT = "dummy formatted text";

// @slack/web-api をアダプタ境界でモックする（ネットワーク非依存 / coding-rules SHOULD）。
// postMessage の振る舞いは各テストで postMessageMock に差し替える。
const postMessageMock = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    public chat: { postMessage: typeof postMessageMock };
    constructor(public token: string) {
      this.chat = { postMessage: postMessageMock };
    }
  },
}));

beforeEach(() => {
  postMessageMock.mockReset();
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
