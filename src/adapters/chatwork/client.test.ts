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

describe("createChatworkClient.getRoomMembers", () => {
  // DUMMY 値（実 account_id・実氏名を含まない / CON-002）。
  const DUMMY_NAME_A = "dummy member name A";
  const DUMMY_NAME_B = "dummy member name B";
  const DUMMY_NAME_C = "dummy member name C";

  it("maps a successful response to ChatworkMember[] (account_id number/string → string, name preserved)", async () => {
    // Arrange: account_id が number と string の両方混在 → どちらも文字列化される。
    stubFetch(async () =>
      jsonResponse([
        { account_id: 9001, name: DUMMY_NAME_A },
        { account_id: "9002", name: DUMMY_NAME_B },
      ]),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const members = await client.getRoomMembers(DUMMY_ROOM_ID);

    // Assert
    expect(members).toEqual([
      { accountId: "9001", name: DUMMY_NAME_A },
      { accountId: "9002", name: DUMMY_NAME_B },
    ]);
  });

  it("calls the correct URL with the X-ChatWorkToken header", async () => {
    // Arrange
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    await client.getRoomMembers(DUMMY_ROOM_ID);

    // Assert: URL（/members 付き）とトークンヘッダを検証する。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit | undefined];
    expect(url).toBe(`${DUMMY_BASE_URL}/rooms/${DUMMY_ROOM_ID}/members`);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-ChatWorkToken"]).toBe(DUMMY_API_TOKEN);
  });

  it("filters out elements that are missing account_id or name silently", async () => {
    // Arrange: 形が壊れた要素は黙って除外され、正常要素のみが残る（1件のために全体を落とさない）。
    stubFetch(async () =>
      jsonResponse([
        { account_id: 1, name: DUMMY_NAME_A },
        { account_id: 2 }, // name 無し → 除外
        { name: DUMMY_NAME_B }, // account_id 無し → 除外
        { account_id: 3, name: DUMMY_NAME_C },
        null,
        "not-an-object",
        { account_id: true, name: DUMMY_NAME_A }, // 型が合わない account_id → 除外
        { account_id: 4, name: 12345 }, // 型が合わない name → 除外
      ]),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const members = await client.getRoomMembers(DUMMY_ROOM_ID);

    // Assert: 完全な 2 件のみ採用される。
    expect(members).toEqual([
      { accountId: "1", name: DUMMY_NAME_A },
      { accountId: "3", name: DUMMY_NAME_C },
    ]);
  });

  it("throws ChatworkApiError with status on a non-2xx response", async () => {
    // Arrange: 認可エラー（403）。本文は読まない／含まれない。
    stubFetch(async () => new Response("forbidden detail", { status: 403 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toMatchObject({
      op: "chatwork.getRoomMembers",
      status: 403,
    });
  });

  it("throws ChatworkApiError when fetch rejects (network failure)", async () => {
    // Arrange: ネットワーク失敗。生エラーは握りつぶされ操作名のみが伝わる。
    stubFetch(async () => {
      throw new Error("network down secret-leak-bait");
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toMatchObject({
      op: "chatwork.getRoomMembers",
      status: undefined,
    });
  });

  it("throws ChatworkApiError when the response body is not a JSON array", async () => {
    // Arrange: 2xx だが配列ではない（オブジェクト）。
    stubFetch(async () => jsonResponse({ not: "an array" }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toMatchObject({
      op: "chatwork.getRoomMembers",
      status: 200,
    });
  });

  it("throws ChatworkApiError when a 2xx response is not valid JSON", async () => {
    // Arrange: 2xx だが JSON として解釈できない本文。
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getRoomMembers(DUMMY_ROOM_ID)).rejects.toBeInstanceOf(ChatworkApiError);
  });

  it("never leaks the apiToken, response body, or any member name in the thrown error (NFR-002)", async () => {
    // Arrange: 本文・トークン・氏名漏洩を誘発しうる経路（非2xx + 氏名らしき本文）を組む。
    const responseBody = `leak-bait:${DUMMY_NAME_A};${DUMMY_NAME_B}`;
    stubFetch(async () => new Response(responseBody, { status: 500 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    let caught: unknown;
    try {
      await client.getRoomMembers(DUMMY_ROOM_ID);
    } catch (err) {
      caught = err;
    }

    // Assert: メッセージ・スタック・JSON シリアライズ・全列挙プロパティのいずれにも
    // トークン・本文・氏名を含まない（NFR-002）。
    expect(caught).toBeInstanceOf(ChatworkApiError);
    const error = caught as ChatworkApiError;
    const serialized = [
      error.message,
      error.stack ?? "",
      JSON.stringify({ ...error }),
      JSON.stringify({
        name: error.name,
        message: error.message,
        op: error.op,
        status: error.status,
      }),
    ].join(" ");
    expect(serialized).not.toContain(DUMMY_API_TOKEN);
    expect(serialized).not.toContain(responseBody);
    expect(serialized).not.toContain(DUMMY_NAME_A);
    expect(serialized).not.toContain(DUMMY_NAME_B);
  });

  it("returns an empty array on a 2xx empty array response", async () => {
    // Arrange: メンバーが居ない場合（理論上ありえないが安全側）。
    stubFetch(async () => jsonResponse([]));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const members = await client.getRoomMembers(DUMMY_ROOM_ID);

    // Assert
    expect(members).toEqual([]);
  });
});

describe("createChatworkClient.getFileDownloadUrl", () => {
  // DUMMY 値（実ファイル名・実 URL を含まない / CON-002）。
  const DUMMY_FILE_ID = "12345";
  const DUMMY_FILENAME = "dummy attachment file.png";
  const DUMMY_DOWNLOAD_URL = "https://download.example.test/dummy-short-lived-url";

  it("maps a successful response to ChatworkFileDownloadInfo", async () => {
    // Arrange
    stubFetch(async () =>
      jsonResponse({
        file_id: DUMMY_FILE_ID,
        filename: DUMMY_FILENAME,
        filesize: 4096,
        mime_type: "image/png",
        download_url: DUMMY_DOWNLOAD_URL,
      }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const info = await client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID);

    // Assert
    expect(info).toEqual({
      fileId: DUMMY_FILE_ID,
      filename: DUMMY_FILENAME,
      filesize: 4096,
      mimeType: "image/png",
      downloadUrl: DUMMY_DOWNLOAD_URL,
    });
  });

  it("accepts file_id as a number and stringifies it", async () => {
    // Arrange: API は file_id を number で返すこともある（getRoomMembers の account_id と統一方針）。
    stubFetch(async () =>
      jsonResponse({
        file_id: 67890,
        filename: DUMMY_FILENAME,
        filesize: 10,
        download_url: DUMMY_DOWNLOAD_URL,
      }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const info = await client.getFileDownloadUrl(DUMMY_ROOM_ID, "67890");

    // Assert: number でも文字列化される。mime_type 欠落 → null。
    expect(info.fileId).toBe("67890");
    expect(info.mimeType).toBeNull();
  });

  it("sets mimeType to null when mime_type is missing", async () => {
    // Arrange: mime_type は任意。
    stubFetch(async () =>
      jsonResponse({
        file_id: DUMMY_FILE_ID,
        filename: DUMMY_FILENAME,
        filesize: 1,
        download_url: DUMMY_DOWNLOAD_URL,
      }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const info = await client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID);

    // Assert
    expect(info.mimeType).toBeNull();
  });

  it("calls the correct URL with create_download_url=1 and the X-ChatWorkToken header", async () => {
    // Arrange
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        file_id: DUMMY_FILE_ID,
        filename: DUMMY_FILENAME,
        filesize: 1,
        download_url: DUMMY_DOWNLOAD_URL,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    await client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID);

    // Assert
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit | undefined];
    expect(url).toBe(
      `${DUMMY_BASE_URL}/rooms/${DUMMY_ROOM_ID}/files/${DUMMY_FILE_ID}?create_download_url=1`,
    );
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>)["X-ChatWorkToken"]).toBe(DUMMY_API_TOKEN);
  });

  it.each([
    401, 404, 429, 500,
  ])("throws ChatworkApiError with status %i on a non-2xx response", async (status) => {
    // Arrange: 認可/未存在/レート制限/サーバエラー。本文は読まない／含まれない。
    stubFetch(async () => new Response("error detail body", { status }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID)).rejects.toMatchObject({
      op: "chatwork.getFileDownloadUrl",
      status,
    });
  });

  it("throws ChatworkApiError when the response shape is invalid (missing download_url)", async () => {
    // Arrange: 必須フィールド download_url 欠落。
    stubFetch(async () =>
      jsonResponse({ file_id: DUMMY_FILE_ID, filename: DUMMY_FILENAME, filesize: 1 }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID)).rejects.toMatchObject({
      op: "chatwork.getFileDownloadUrl",
      status: 200,
    });
  });

  it("throws ChatworkApiError when filesize is not a number", async () => {
    // Arrange: filesize が文字列 → 型ガード不合格。
    stubFetch(async () =>
      jsonResponse({
        file_id: DUMMY_FILE_ID,
        filename: DUMMY_FILENAME,
        filesize: "not-a-number",
        download_url: DUMMY_DOWNLOAD_URL,
      }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID)).rejects.toBeInstanceOf(
      ChatworkApiError,
    );
  });

  it("throws ChatworkApiError when a 2xx response is not valid JSON", async () => {
    // Arrange: 2xx だが JSON として解釈できない本文。
    stubFetch(async () => new Response("<html>not json</html>", { status: 200 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID)).rejects.toBeInstanceOf(
      ChatworkApiError,
    );
  });

  it("throws ChatworkApiError when fetch rejects (network failure)", async () => {
    // Arrange: ネットワーク失敗。生エラーは握りつぶされ操作名のみが伝わる。
    stubFetch(async () => {
      throw new Error("network down secret-leak-bait");
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID)).rejects.toMatchObject({
      op: "chatwork.getFileDownloadUrl",
      status: undefined,
    });
  });

  it("never leaks the apiToken, filename, or download URL in the thrown error (NFR-002)", async () => {
    // Arrange: トークン・ファイル名・URL 漏洩を誘発しうる経路（非2xx + 本文に値を混ぜる）を組む。
    const responseBody = `leak-bait:${DUMMY_FILENAME};${DUMMY_DOWNLOAD_URL}`;
    stubFetch(async () => new Response(responseBody, { status: 500 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    let caught: unknown;
    try {
      await client.getFileDownloadUrl(DUMMY_ROOM_ID, DUMMY_FILE_ID);
    } catch (err) {
      caught = err;
    }

    // Assert: メッセージ・スタック・全列挙プロパティのいずれにもトークン・ファイル名・URL を含まない。
    expect(caught).toBeInstanceOf(ChatworkApiError);
    const error = caught as ChatworkApiError;
    const serialized = [
      error.message,
      error.stack ?? "",
      JSON.stringify({ ...error }),
      JSON.stringify({
        name: error.name,
        message: error.message,
        op: error.op,
        status: error.status,
      }),
    ].join(" ");
    expect(serialized).not.toContain(DUMMY_API_TOKEN);
    expect(serialized).not.toContain(DUMMY_FILENAME);
    expect(serialized).not.toContain(DUMMY_DOWNLOAD_URL);
    expect(serialized).not.toContain(responseBody);
  });
});

describe("createChatworkClient.downloadFile", () => {
  // DUMMY 値（実 URL・実バイナリを含まない / CON-002）。1×1px 透明 PNG のダミーバイト。
  const DUMMY_DOWNLOAD_URL = "https://download.example.test/dummy-short-lived-url";
  const DUMMY_PNG_BYTES = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const ONE_HUNDRED_MB = 100 * 1024 * 1024;

  /** バイナリ Response を作る。content-length / content-type を任意で制御できる。 */
  function binaryResponse(
    bytes: Uint8Array,
    init: { status?: number; contentType?: string | null; contentLength?: string | null } = {},
  ): Response {
    const headers = new Headers();
    if (init.contentType !== null && init.contentType !== undefined) {
      headers.set("content-type", init.contentType);
    }
    if (init.contentLength !== null && init.contentLength !== undefined) {
      headers.set("content-length", init.contentLength);
    }
    // Response が自動付与する content-length を避けるため明示制御する。
    return new Response(bytes, { status: init.status ?? 200, headers });
  }

  it("returns the bytes and Content-Type for a successful download", async () => {
    // Arrange
    stubFetch(async () => binaryResponse(DUMMY_PNG_BYTES, { contentType: "image/png" }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const result = await client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB });

    // Assert
    expect(Array.from(result.bytes)).toEqual(Array.from(DUMMY_PNG_BYTES));
    expect(result.mimeType).toBe("image/png");
  });

  it("does NOT send an X-ChatWorkToken header (short-lived URL needs no auth / ASM-001)", async () => {
    // Arrange
    const fetchMock = vi.fn<typeof fetch>(async () =>
      binaryResponse(DUMMY_PNG_BYTES, { contentType: "image/png" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    await client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB });

    // Assert: URL はそのまま、ヘッダにトークンを付けない。
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit | undefined];
    expect(url).toBe(DUMMY_DOWNLOAD_URL);
    expect(init?.method).toBe("GET");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-ChatWorkToken"]).toBeUndefined();
  });

  it.each([
    ["image/gif", "image/gif"],
    ["image/png", "image/png"],
    ["application/pdf", "application/pdf"],
    ["application/octet-stream", "application/octet-stream"],
  ])("reflects Content-Type %s as mimeType", async (contentType, expected) => {
    // Arrange
    stubFetch(async () => binaryResponse(DUMMY_PNG_BYTES, { contentType }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const result = await client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB });

    // Assert
    expect(result.mimeType).toBe(expected);
  });

  it("sets mimeType to null when Content-Type header is absent", async () => {
    // Arrange: Content-Type ヘッダなし。
    stubFetch(async () => binaryResponse(DUMMY_PNG_BYTES, { contentType: null }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    const result = await client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB });

    // Assert
    expect(result.mimeType).toBeNull();
  });

  it("rejects at the Content-Length stage when the declared size exceeds maxBytes (defense layer 2)", async () => {
    // Arrange: Content-Length が maxBytes を超過 → バイト取得前に弾く。arrayBuffer は呼ばれない。
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
    stubFetch(async () => {
      const res = binaryResponse(DUMMY_PNG_BYTES, {
        contentType: "image/png",
        contentLength: String(ONE_HUNDRED_MB + 1),
      });
      // arrayBuffer 呼び出しの有無を観測する。
      Object.defineProperty(res, "arrayBuffer", { value: arrayBufferSpy });
      return res;
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(
      client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB }),
    ).rejects.toMatchObject({ op: "chatwork.downloadFile" });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("rejects at the actual byteLength stage when Content-Length is missing but bytes exceed maxBytes (defense layer 3)", async () => {
    // Arrange: Content-Length 欠落（過小申告と等価）+ 実バイトが小さな maxBytes を超過。
    // ダミー PNG（~67 bytes）を使い maxBytes=10 で実バイト段階の超過を検証する。
    stubFetch(async () =>
      binaryResponse(DUMMY_PNG_BYTES, { contentType: "image/png", contentLength: null }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert: 実 byteLength 段階で弾く（三段防御の核心）。
    await expect(client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: 10 })).rejects.toMatchObject({
      op: "chatwork.downloadFile",
    });
  });

  it("rejects at the byteLength stage when Content-Length under-reports the real size (defense layer 3)", async () => {
    // Arrange: Content-Length が過小申告（maxBytes 内）だが実バイトは超過。事前判定は通過し、再照合で弾く。
    stubFetch(async () =>
      binaryResponse(DUMMY_PNG_BYTES, { contentType: "image/png", contentLength: "5" }),
    );
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: 10 })).rejects.toMatchObject({
      op: "chatwork.downloadFile",
    });
  });

  it("throws ChatworkApiError with status on a non-2xx response", async () => {
    // Arrange
    stubFetch(async () => new Response("gone", { status: 404 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(
      client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB }),
    ).rejects.toMatchObject({ op: "chatwork.downloadFile", status: 404 });
  });

  it("throws ChatworkApiError when fetch rejects (network failure)", async () => {
    // Arrange
    stubFetch(async () => {
      throw new Error("network down secret-leak-bait");
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(
      client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB }),
    ).rejects.toMatchObject({ op: "chatwork.downloadFile", status: undefined });
  });

  it("throws ChatworkApiError when arrayBuffer() rejects", async () => {
    // Arrange: 2xx だが本体読み取り中に失敗（途中切断等）。
    stubFetch(async () => {
      const res = binaryResponse(DUMMY_PNG_BYTES, { contentType: "image/png" });
      Object.defineProperty(res, "arrayBuffer", {
        value: async () => {
          throw new Error("stream aborted secret-leak-bait");
        },
      });
      return res;
    });
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act & Assert
    await expect(
      client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB }),
    ).rejects.toBeInstanceOf(ChatworkApiError);
  });

  it("never leaks the download URL or bytes in the thrown error (NFR-002)", async () => {
    // Arrange: URL を含む経路（非2xx + 本文に URL を混ぜる）を組む。
    const responseBody = `leak-bait:${DUMMY_DOWNLOAD_URL}`;
    stubFetch(async () => new Response(responseBody, { status: 500 }));
    const client = createChatworkClient({ apiToken: DUMMY_API_TOKEN, baseUrl: DUMMY_BASE_URL });

    // Act
    let caught: unknown;
    try {
      await client.downloadFile(DUMMY_DOWNLOAD_URL, { maxBytes: ONE_HUNDRED_MB });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(ChatworkApiError);
    const error = caught as ChatworkApiError;
    const serialized = [error.message, error.stack ?? "", JSON.stringify({ ...error })].join(" ");
    expect(serialized).not.toContain(DUMMY_DOWNLOAD_URL);
    expect(serialized).not.toContain(responseBody);
  });
});
