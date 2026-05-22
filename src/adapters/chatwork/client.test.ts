import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatworkApiError, createChatworkClient } from "@/adapters/chatwork/client";
import { toChatworkRoomId } from "@/adapters/chatwork/types";

// DUMMY 値（実トークン・実 ID・実ルーム名を含まない / CON-005）。
const DUMMY_API_TOKEN = "dummy-chatwork-api-token";
const DUMMY_BASE_URL = "https://chatwork.example.test/v2";
const DUMMY_ROOM_ID = toChatworkRoomId("200");

/** fetch をアダプタ境界でモックするヘルパ（ネットワーク非依存 / coding-rules SHOULD）。 */
function stubFetch(impl: typeof fetch): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

/** 成功レスポンス（2xx + JSON）を返す Response を作る。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createChatworkClient.getRoom", () => {
  it("maps a successful response {name,type} to a ChatworkRoom", async () => {
    // Arrange
    stubFetch(async () => jsonResponse({ name: "dummy room name", type: "group" }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const room = await client.getRoom(DUMMY_ROOM_ID);

    // Assert
    expect(room).toEqual({ roomId: DUMMY_ROOM_ID, name: "dummy room name", type: "group" });
  });

  it("calls the correct URL with the X-ChatWorkToken header", async () => {
    // Arrange
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ name: "dummy", type: "direct" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    await client.getRoom(DUMMY_ROOM_ID);

    // Assert: URL とトークンヘッダを検証する。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit | undefined];
    expect(url).toBe(`${DUMMY_BASE_URL}/rooms/${DUMMY_ROOM_ID}`);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-ChatWorkToken"]).toBe(DUMMY_API_TOKEN);
  });

  it("throws ChatworkApiError with status on a non-2xx response", async () => {
    // Arrange: 認可エラー（401）。本文は読まれない／含まれない。
    stubFetch(async () => new Response("forbidden detail", { status: 401 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toMatchObject({
      op: "chatwork.getRoom",
      status: 401,
    });
  });

  it("throws ChatworkApiError when fetch rejects (network failure)", async () => {
    // Arrange: ネットワーク失敗。生エラーは握りつぶされ操作名のみが伝わる。
    stubFetch(async () => {
      throw new Error("network down secret-leak-bait");
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toMatchObject({
      op: "chatwork.getRoom",
      status: undefined,
    });
  });

  it("throws ChatworkApiError when the response has an unknown room type", async () => {
    // Arrange: ROOM_TYPES 外の種別はルーティング不能のため失敗扱い。
    stubFetch(async () => jsonResponse({ name: "dummy", type: "unknown_type" }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
  });

  it("throws ChatworkApiError when a 2xx response is not valid JSON", async () => {
    // Arrange: 2xx だが JSON として解釈できない本文。
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoom(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
  });

  it("never leaks the apiToken or response body in the thrown error or its serialization", async () => {
    // Arrange: 本文・トークン漏洩を誘発しうる経路（非2xx + 本文あり）を組む。
    const responseBody = "leak-bait-response-body";
    stubFetch(async () => new Response(responseBody, { status: 500 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    let caught: unknown;
    try {
      await client.getRoom(DUMMY_ROOM_ID);
    } catch (err) {
      caught = err;
    }

    // Assert: メッセージ・JSON シリアライズ・全列挙プロパティのいずれにもトークン・本文を含まない。
    expect(caught).toBeInstanceOf(ChatworkApiError);
    const error = caught as ChatworkApiError;
    const serialized = `${error.message} ${JSON.stringify({ ...error })} ${JSON.stringify({
      name: error.name,
      message: error.message,
      op: error.op,
      status: error.status,
    })}`;
    expect(serialized).not.toContain(DUMMY_API_TOKEN);
    expect(serialized).not.toContain(responseBody);
  });

  it("strips trailing slashes from baseUrl when building the request URL", async () => {
    // Arrange: baseUrl 末尾スラッシュの正規化を確認する。
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ name: "dummy", type: "my" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createChatworkClient({
      apiToken: DUMMY_API_TOKEN,
      baseUrl: `${DUMMY_BASE_URL}///`,
    });

    // Act
    await client.getRoom(DUMMY_ROOM_ID);

    // Assert
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    expect((call as [string, RequestInit | undefined])[0]).toBe(
      `${DUMMY_BASE_URL}/rooms/${DUMMY_ROOM_ID}`,
    );
  });
});
