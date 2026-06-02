import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatworkClient } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import type { ChatworkFileDownloadInfo } from "@/adapters/chatwork/types";
import { toChatworkRoomId } from "@/adapters/chatwork/types";
import type { SlackClient } from "@/adapters/slack/client";
import { SlackApiError } from "@/adapters/slack/client";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import {
  type MirrorAttachmentsDeps,
  type MirrorAttachmentsInput,
  mirrorAttachments,
} from "@/app/services/mirror-attachments";
import { chatworkMessageAttachments } from "@/db/schema";

// ---------------------------------------------------------------------------
// DUMMY 値（実 room/channel/file ID・実本文・実ファイル名・実バイト・実トークンを含まない / CON-002）。
// ファイル本体は 1×1px 相当のダミーバイト列。
// ---------------------------------------------------------------------------
const DUMMY_ROOM_ID = toChatworkRoomId("200");
const DUMMY_MESSAGE_ID = "msg-dummy-1";
const DUMMY_MESSAGE_ROW_ID = 42n;
const DUMMY_CHANNEL_ID = toSlackChannelId("C0DUMMYCHANNEL");
const DUMMY_THREAD_TS = toSlackTs("1700000000.000100");
const DUMMY_FILENAME = "dummy-file-name.png";
const DUMMY_DOWNLOAD_URL = "https://chatwork-storage.example.test/dummy-short-lived-url";
const DUMMY_SLACK_FILE_ID = "F0DUMMYFILE";
// 1×1px PNG 相当のダミーバイト列（実バイナリではない / CON-002）。
const DUMMY_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 本文に download トークンを 1 件含むダミー本文を作る。 */
function bodyWithFiles(...fileIds: string[]): string {
  return fileIds.map((id) => `[download:${id}]dummy (1KB)[/download]`).join("\n");
}

/** `getFileDownloadUrl` の戻り値（ChatworkFileDownloadInfo）を作る。 */
function fileInfo(overrides: Partial<ChatworkFileDownloadInfo> = {}): ChatworkFileDownloadInfo {
  return {
    fileId: "111",
    filename: DUMMY_FILENAME,
    filesize: 1024,
    mimeType: "image/png",
    downloadUrl: DUMMY_DOWNLOAD_URL,
    ...overrides,
  };
}

/**
 * `deps.db.db`（Drizzle ハンドル）をアダプタ境界でモックする。実 DB 非依存（coding-rules SHOULD）。
 *
 * 本番コードのチェーン:
 *  - select({...}).from(t).where(...) → Promise<{ fileId }[]>（既アップロード判定 SELECT）
 *  - insert(t).values(...).onConflictDoNothing(...) → await（mapping 記録）
 */
interface DbScript {
  /** SELECT が返す既アップロード file_id 行。 */
  uploadedRows?: Array<{ fileId: string }>;
  /** true のとき SELECT の Promise を reject する（DB 障害の再現）。 */
  selectRejects?: boolean;
  /** insert を reject させる file_id の集合（極稀な DB 挿入失敗の再現）。 */
  insertRejectFor?: Set<string>;
}

interface CapturedDb {
  /** SELECT 対象テーブル。 */
  selectFromTables: unknown[];
  /** insert 対象テーブル。 */
  insertTables: unknown[];
  /** insert された values。 */
  insertValues: Array<Record<string, unknown>>;
}

function makeDbMock(script: DbScript): { db: { db: unknown }; captured: CapturedDb } {
  const captured: CapturedDb = {
    selectFromTables: [],
    insertTables: [],
    insertValues: [],
  };

  const db = {
    select(_columns: unknown) {
      return {
        from(table: unknown) {
          captured.selectFromTables.push(table);
          return {
            where(_cond: unknown) {
              return script.selectRejects
                ? Promise.reject(new Error("db select failed"))
                : Promise.resolve(script.uploadedRows ?? []);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      captured.insertTables.push(table);
      return {
        values(values: Record<string, unknown>) {
          captured.insertValues.push(values);
          return {
            onConflictDoNothing(_opts: unknown) {
              const fileId = values.chatworkFileId as string;
              return script.insertRejectFor?.has(fileId)
                ? Promise.reject(new Error("db insert failed"))
                : Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };

  return { db: { db }, captured };
}

interface MakeDepsResult {
  deps: MirrorAttachmentsDeps;
  captured: CapturedDb;
  getFileDownloadUrl: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  logs: { level: string; payload: Record<string, unknown>; message: string }[];
}

function makeDeps(opts: {
  script?: DbScript;
  getFileDownloadUrl?: (...args: unknown[]) => Promise<ChatworkFileDownloadInfo>;
  downloadFile?: (...args: unknown[]) => Promise<{ bytes: Uint8Array; mimeType: string | null }>;
  uploadFile?: (...args: unknown[]) => Promise<{ slackFileId: string }>;
  maxBytes?: number;
}): MakeDepsResult {
  const { db, captured } = makeDbMock(opts.script ?? {});
  const logs: MakeDepsResult["logs"] = [];

  const getFileDownloadUrl = vi.fn(
    opts.getFileDownloadUrl ?? (async (): Promise<ChatworkFileDownloadInfo> => fileInfo()),
  );
  const downloadFile = vi.fn(
    opts.downloadFile ??
      (async (): Promise<{ bytes: Uint8Array; mimeType: string | null }> => ({
        bytes: DUMMY_BYTES,
        mimeType: "image/png",
      })),
  );
  const uploadFile = vi.fn(
    opts.uploadFile ??
      (async (): Promise<{ slackFileId: string }> => ({ slackFileId: DUMMY_SLACK_FILE_ID })),
  );

  const chatworkClient = { getFileDownloadUrl, downloadFile } as unknown as ChatworkClient;
  const slackClient = { uploadFile } as unknown as SlackClient;

  const record = (level: string) => (payload: Record<string, unknown>, message: string) => {
    logs.push({ level, payload, message });
  };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as MirrorAttachmentsDeps["logger"];

  const deps: MirrorAttachmentsDeps = {
    db: db as unknown as MirrorAttachmentsDeps["db"],
    chatworkClient,
    slackClient,
    logger,
    // exactOptionalPropertyTypes 下では undefined を明示代入できないため、指定時のみ含める。
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  };

  return { deps, captured, getFileDownloadUrl, downloadFile, uploadFile, logs };
}

/** ダミーの `MirrorAttachmentsInput` を作る。 */
function makeInput(overrides: Partial<MirrorAttachmentsInput> = {}): MirrorAttachmentsInput {
  return {
    chatworkRoomId: DUMMY_ROOM_ID,
    chatworkMessageId: DUMMY_MESSAGE_ID,
    messageRowId: DUMMY_MESSAGE_ROW_ID,
    body: bodyWithFiles("111"),
    slackChannelId: DUMMY_CHANNEL_ID,
    slackThreadTs: DUMMY_THREAD_TS,
    ...overrides,
  };
}

function serializeLogs(logs: MakeDepsResult["logs"]): string {
  return JSON.stringify(logs);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mirrorAttachments", () => {
  describe("no attachments", () => {
    it("returns without touching DB / Chatwork / Slack when the body has no download tokens", async () => {
      // Arrange: 添付トークンを含まない本文。
      const { deps, captured, getFileDownloadUrl, downloadFile, uploadFile } = makeDeps({});

      // Act
      await mirrorAttachments(makeInput({ body: "dummy plain message body" }), deps);

      // Assert: SELECT / API / insert を一切呼ばない。
      expect(captured.selectFromTables).toHaveLength(0);
      expect(getFileDownloadUrl).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);
    });
  });

  describe("all files succeed", () => {
    it("inserts one mapping row per extracted file id", async () => {
      // Arrange: 2 件の添付・既アップロードなし・全件成功。
      const { deps, captured, getFileDownloadUrl, downloadFile, uploadFile, logs } = makeDeps({
        script: { uploadedRows: [] },
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileInfo({ fileId: String(fileId) }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 各 file につき API 群が 1 回ずつ呼ばれ、mapping が 2 行 insert される。
      expect(getFileDownloadUrl).toHaveBeenCalledTimes(2);
      expect(downloadFile).toHaveBeenCalledTimes(2);
      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(captured.insertTables).toEqual([
        chatworkMessageAttachments,
        chatworkMessageAttachments,
      ]);
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["111", "222"]);
      // 各 mapping 行は FK 親 / file / slack file / channel / thread を保持する。
      const first = captured.insertValues[0] as Record<string, unknown>;
      expect(first.chatworkMessageId).toBe(DUMMY_MESSAGE_ROW_ID);
      expect(first.slackFileId).toBe(DUMMY_SLACK_FILE_ID);
      expect(first.slackChannelId).toBe(DUMMY_CHANNEL_ID);
      expect(first.slackThreadTs).toBe(DUMMY_THREAD_TS);
      // done サマリは件数識別子のみ。
      const done = logs.find((l) => l.payload.op === "forward.mirror.done");
      expect(done?.payload).toMatchObject({ total: 2, attempted: 2, ok: 2 });
    });

    it("uses uploadFile MIME from the downloaded bytes over the API meta", async () => {
      // Arrange: downloadFile が application/octet-stream を返す（実体ヘッダ優先 / 設計 §4.4）。
      const { deps, uploadFile } = makeDeps({
        getFileDownloadUrl: async () => fileInfo({ mimeType: "image/png" }),
        downloadFile: async () => ({ bytes: DUMMY_BYTES, mimeType: "application/octet-stream" }),
      });

      // Act
      await mirrorAttachments(makeInput(), deps);

      // Assert: uploadFile に渡る mimeType は downloadFile 由来。
      const [arg] = uploadFile.mock.calls[0] as [{ mimeType: string }];
      expect(arg.mimeType).toBe("application/octet-stream");
    });

    it("falls back to the API meta MIME when the downloaded bytes carry no Content-Type", async () => {
      // Arrange: downloadFile が mimeType=null を返す → API メタの mime_type が使われる（設計 §4.4）。
      const { deps, uploadFile } = makeDeps({
        getFileDownloadUrl: async () => fileInfo({ mimeType: "application/pdf" }),
        downloadFile: async () => ({ bytes: DUMMY_BYTES, mimeType: null }),
      });

      // Act
      await mirrorAttachments(makeInput(), deps);

      // Assert: uploadFile に渡る mimeType は API メタ由来（fallback）。
      const [arg] = uploadFile.mock.calls[0] as [{ mimeType: string | null }];
      expect(arg.mimeType).toBe("application/pdf");
    });
  });

  describe("already uploaded (mapping SELECT hit)", () => {
    it("does not call Chatwork or Slack for a file already recorded", async () => {
      // Arrange: file 111 は既に mapping に存在する。
      const { deps, captured, getFileDownloadUrl, downloadFile, uploadFile } = makeDeps({
        script: { uploadedRows: [{ fileId: "111" }] },
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);

      // Assert: SELECT は行うが、API・insert は呼ばれない。
      expect(captured.selectFromTables).toContain(chatworkMessageAttachments);
      expect(getFileDownloadUrl).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);
    });

    it("processes only the not-yet-uploaded subset when some files are already recorded", async () => {
      // Arrange: 111 は既存、222 は未アップロード。
      const { deps, captured, getFileDownloadUrl } = makeDeps({
        script: { uploadedRows: [{ fileId: "111" }] },
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileInfo({ fileId: String(fileId) }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 222 のみ取得・記録される。
      expect(getFileDownloadUrl).toHaveBeenCalledTimes(1);
      const [, fileIdArg] = getFileDownloadUrl.mock.calls[0] as [unknown, string];
      expect(fileIdArg).toBe("222");
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["222"]);
    });
  });

  describe("upload SELECT failure (DB outage) — outer catch safely skips the whole mirror", () => {
    it("does not call Chatwork/Slack, logs forward.mirror.skipped, and never throws", async () => {
      // Arrange: 既アップロード判定 SELECT が reject（DB 障害）。
      const { deps, getFileDownloadUrl, downloadFile, uploadFile, captured, logs } = makeDeps({
        script: { selectRejects: true },
      });

      // Act: never-throw 契約。
      await expect(mirrorAttachments(makeInput(), deps)).resolves.toBeUndefined();

      // Assert: mirror 全体を safely skip（API・insert なし）。
      expect(getFileDownloadUrl).not.toHaveBeenCalled();
      expect(downloadFile).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);
      // fallback ログ（外側 catch）に識別子のみ。
      const skipped = logs.find((l) => l.payload.op === "forward.mirror.skipped");
      expect(skipped).toBeDefined();
      expect(skipped?.payload).toMatchObject({
        roomId: DUMMY_ROOM_ID,
        messageId: DUMMY_MESSAGE_ID,
      });
    });
  });

  describe("unexpected exception around extraction — outer catch holds it", () => {
    it("logs forward.mirror.skipped and never throws when an out-of-loop dependency throws", async () => {
      // Arrange: SELECT 解決後に発生しうる予期しない例外を db.select 経路で再現する。
      // ここでは select 自体を同期 throw させ、外側 catch が握ることを担保する。
      const logs: { level: string; payload: Record<string, unknown>; message: string }[] = [];
      const record = (level: string) => (payload: Record<string, unknown>, message: string) => {
        logs.push({ level, payload, message });
      };
      const throwingDb = {
        db: {
          select() {
            throw new Error("unexpected db handle failure");
          },
        },
      };
      const getFileDownloadUrl = vi.fn();
      const deps = {
        db: throwingDb as unknown as MirrorAttachmentsDeps["db"],
        chatworkClient: { getFileDownloadUrl } as unknown as ChatworkClient,
        slackClient: { uploadFile: vi.fn() } as unknown as SlackClient,
        logger: {
          info: record("info"),
          warn: record("warn"),
          error: record("error"),
          debug: record("debug"),
        } as unknown as MirrorAttachmentsDeps["logger"],
      } satisfies MirrorAttachmentsDeps;

      // Act: never-throw 契約。
      await expect(mirrorAttachments(makeInput(), deps)).resolves.toBeUndefined();

      // Assert: 外側 catch が握り、fallback ログのみ。下流 API は呼ばれない。
      expect(getFileDownloadUrl).not.toHaveBeenCalled();
      const skipped = logs.find((l) => l.payload.op === "forward.mirror.skipped");
      expect(skipped).toBeDefined();
    });
  });

  describe("size limit — API meta filesize stage", () => {
    it("skips Slack upload, logs forward.mirror.too_large, and continues with other files", async () => {
      // Arrange: maxBytes=100。111 はメタで超過、222 は許容内。
      const { deps, captured, downloadFile, uploadFile, logs } = makeDeps({
        maxBytes: 100,
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileId === "111"
            ? fileInfo({ fileId: "111", filesize: 999 })
            : fileInfo({ fileId: "222", filesize: 50 }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 超過 file は Slack を呼ばず、許容 file は処理される。
      const tooLarge = logs.find((l) => l.payload.op === "forward.mirror.too_large");
      expect(tooLarge?.payload.fileId).toBe("111");
      // downloadFile/uploadFile は 222 についてのみ 1 回。
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["222"]);
    });
  });

  describe("size limit — downloadFile Content-Length / byteLength stages", () => {
    it("treats a downloadFile size-exceeded ChatworkApiError as a per-file fallback (Content-Length stage)", async () => {
      // Arrange: メタは許容内だが downloadFile が Content-Length 超過で throw する（三段防御 2 段目）。
      const { deps, captured, uploadFile, logs } = makeDeps({
        getFileDownloadUrl: async () => fileInfo({ fileId: "111", filesize: 10 }),
        downloadFile: async () => {
          throw new ChatworkApiError("chatwork.downloadFile", 413);
        },
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);

      // Assert: Slack を呼ばず fallback。mapping は書かれない。
      expect(uploadFile).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);
      const failed = logs.find((l) => l.payload.op === "forward.mirror.failed");
      expect(failed?.payload.fileId).toBe("111");
    });

    it("treats a downloadFile actual-byteLength exceeded error as a per-file fallback (byteLength stage)", async () => {
      // Arrange: メタ・Content-Length は通過したが、実バイト長で超過と判定された（三段防御 3 段目の核心）。
      // adapter は実 byteLength 超過時も ChatworkApiError を投げる契約。Slack は呼ばれない。
      const { deps, captured, uploadFile, downloadFile, logs } = makeDeps({
        getFileDownloadUrl: async () => fileInfo({ fileId: "111", filesize: 10 }),
        downloadFile: async () => {
          // Content-Length 欠落・過小申告に対する保険として実 byteLength で弾く段階を再現。
          throw new ChatworkApiError("chatwork.downloadFile");
        },
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);

      // Assert: downloadFile は呼ばれたが Slack は呼ばれず、mapping も書かれない。
      expect(downloadFile).toHaveBeenCalledTimes(1);
      expect(uploadFile).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);
      const failed = logs.find((l) => l.payload.op === "forward.mirror.failed");
      expect(failed?.payload.fileId).toBe("111");
    });
  });

  describe("Chatwork fetch failure — per-file skip, continue others", () => {
    it.each([
      401, 404, 429,
    ])("skips only the failing file and continues when getFileDownloadUrl throws %i", async (status) => {
      // Arrange: 111 はメタ取得で失敗、222 は成功。
      const { deps, captured, uploadFile, logs } = makeDeps({
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) => {
          if (fileId === "111") throw new ChatworkApiError("chatwork.getFileDownloadUrl", status);
          return fileInfo({ fileId: "222" });
        },
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 222 のみアップロードされ mapping が書かれる。
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["222"]);
      const failed = logs.find((l) => l.payload.op === "forward.mirror.failed");
      expect(failed?.payload.fileId).toBe("111");
    });

    it("skips only the failing file when downloadFile rejects with a network error", async () => {
      // Arrange: 111 はバイト取得（ネットワーク）失敗、222 は成功。
      const { deps, captured, uploadFile } = makeDeps({
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileInfo({ fileId: String(fileId) }),
        downloadFile: vi
          .fn()
          .mockRejectedValueOnce(new ChatworkApiError("chatwork.downloadFile"))
          .mockResolvedValueOnce({ bytes: DUMMY_BYTES, mimeType: "image/png" }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 222 のみ記録される。
      expect(uploadFile).toHaveBeenCalledTimes(1);
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["222"]);
    });
  });

  describe("Slack upload failure — no mapping, fallback, continue others", () => {
    it("does not write a mapping when uploadFile rejects with SlackApiError (ok:false / SDK throw)", async () => {
      // Arrange: 111 は Slack アップロード失敗、222 は成功。
      const { deps, captured, logs } = makeDeps({
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileInfo({ fileId: String(fileId) }),
        uploadFile: vi
          .fn()
          .mockRejectedValueOnce(
            new SlackApiError("slack.uploadFile", DUMMY_CHANNEL_ID, "upload_error"),
          )
          .mockResolvedValueOnce({ slackFileId: DUMMY_SLACK_FILE_ID }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: 111 の mapping は書かれず、222 のみ記録される。
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["222"]);
      const failed = logs.find((l) => l.payload.op === "forward.mirror.failed");
      expect(failed?.payload.fileId).toBe("111");
    });

    it("treats a missing file.id (SlackApiError) as a per-file fallback", async () => {
      // Arrange: file.id 欠落で adapter が SlackApiError を投げる。
      const { deps, captured, logs } = makeDeps({
        uploadFile: async () => {
          throw new SlackApiError("slack.uploadFile", DUMMY_CHANNEL_ID);
        },
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);

      // Assert: mapping は書かれない・fallback ログ。
      expect(captured.insertTables).toHaveLength(0);
      const failed = logs.find((l) => l.payload.op === "forward.mirror.failed");
      expect(failed?.payload.fileId).toBe("111");
    });
  });

  describe("DB insert failure (rare) — held internally, continue others", () => {
    it("logs forward.mirror.failed for the failing file and keeps processing the rest", async () => {
      // Arrange: 111 の mapping insert が reject、222 は成功。
      const { deps, captured, uploadFile, logs } = makeDeps({
        script: { insertRejectFor: new Set(["111"]) },
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) =>
          fileInfo({ fileId: String(fileId) }),
      });

      // Act
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps);

      // Assert: Slack は両方呼ばれる（insert は両方試みられる）が、111 は failed ログになる。
      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(captured.insertValues.map((v) => v.chatworkFileId)).toEqual(["111", "222"]);
      const failed = logs.filter((l) => l.payload.op === "forward.mirror.failed");
      expect(failed.map((l) => l.payload.fileId)).toContain("111");
    });
  });

  describe("never-throw contract — per-file catch + outer catch", () => {
    it("never rejects even when every dependency throws", async () => {
      // Arrange: 全依存が throw する。per-file catch + outer catch の二重防御を担保する。
      const { deps } = makeDeps({
        getFileDownloadUrl: async () => {
          throw new Error("chatwork down");
        },
        downloadFile: async () => {
          throw new Error("download down");
        },
        uploadFile: async () => {
          throw new Error("slack down");
        },
        script: { insertRejectFor: new Set(["111", "222"]) },
      });

      // Act & Assert: reject しない。
      await expect(
        mirrorAttachments(makeInput({ body: bodyWithFiles("111", "222") }), deps),
      ).resolves.toBeUndefined();
    });

    it("never rejects when the SELECT (out-of-loop) throws", async () => {
      // Arrange: ループ外の SELECT が reject → outer catch が握る。
      const { deps } = makeDeps({ script: { selectRejects: true } });

      // Act & Assert
      await expect(mirrorAttachments(makeInput(), deps)).resolves.toBeUndefined();
    });
  });

  describe("idempotency — mapping double insert", () => {
    it("uses onConflictDoNothing targeting (chatwork_message_id, chatwork_file_id) so a re-run inserts at most one row", async () => {
      // 冪等性スコープ（設計 §3.3）:
      // - webhook 再送は forwardMessage の onConflictDoNothing で早期 return するため、ここには到達しない。
      // - 並行 worker による同 file の二重 Slack アップロードは本 Issue 非対応（ops-safety #5 の領域）。
      // ここでは mapping の二重 insert が unique 制約 + onConflictDoNothing 経路を通ることを担保する。
      const onConflictSpy = vi.fn();
      const db = {
        db: {
          select() {
            return {
              from() {
                return { where: () => Promise.resolve([]) };
              },
            };
          },
          insert() {
            return {
              values() {
                return {
                  onConflictDoNothing(opts: unknown) {
                    onConflictSpy(opts);
                    return Promise.resolve(undefined);
                  },
                };
              },
            };
          },
        },
      };
      const deps = {
        db: db as unknown as MirrorAttachmentsDeps["db"],
        chatworkClient: {
          getFileDownloadUrl: async () => fileInfo({ fileId: "111" }),
          downloadFile: async () => ({ bytes: DUMMY_BYTES, mimeType: "image/png" }),
        } as unknown as ChatworkClient,
        slackClient: {
          uploadFile: async () => ({ slackFileId: DUMMY_SLACK_FILE_ID }),
        } as unknown as SlackClient,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as unknown as MirrorAttachmentsDeps["logger"],
      } satisfies MirrorAttachmentsDeps;

      // Act: 同じ message+file を 2 回処理する（2 回目も SELECT は空のモックだが、onConflict が防御）。
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);
      await mirrorAttachments(makeInput({ body: bodyWithFiles("111") }), deps);

      // Assert: insert は onConflictDoNothing 経由で、競合ターゲットが複合 unique を指す。
      expect(onConflictSpy).toHaveBeenCalledTimes(2);
      const opts = onConflictSpy.mock.calls[0]?.[0] as { target: unknown[] };
      expect(opts.target).toEqual([
        chatworkMessageAttachments.chatworkMessageId,
        chatworkMessageAttachments.chatworkFileId,
      ]);
    });
  });

  describe("secret / sensitive data never logged (NFR-002)", () => {
    it("logs only identifiers — no body, short-lived URL, bytes, filename, or token in any log payload", async () => {
      // Arrange: 成功・サイズ超過・失敗のログを全種類発生させる。
      const sensitiveBody = `secret body text [download:111]${DUMMY_FILENAME} (1KB)[/download]`;
      const { deps, logs } = makeDeps({
        maxBytes: 100,
        getFileDownloadUrl: async (_roomId: unknown, fileId: unknown) => {
          if (fileId === "111") return fileInfo({ fileId: "111", filesize: 5 }); // 成功
          if (fileId === "222") return fileInfo({ fileId: "222", filesize: 999 }); // too_large
          throw new ChatworkApiError("chatwork.getFileDownloadUrl", 404); // 333 → failed
        },
      });

      // Act
      await mirrorAttachments(
        makeInput({ body: `${sensitiveBody}\n${bodyWithFiles("222", "333")}` }),
        deps,
      );

      // Assert: いずれのログにも本文・URL・ファイル名・トークン・バイトは含まれない。
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain("secret body text");
      expect(serialized).not.toContain(DUMMY_FILENAME);
      expect(serialized).not.toContain(DUMMY_DOWNLOAD_URL);
      // 識別子（roomId / messageId / fileId / channelId）は許容。
      const anyLog = logs.find((l) => l.payload.fileId !== undefined);
      expect(anyLog).toBeDefined();
      // 全種別ログが出ている（uploaded / too_large / failed / done）。
      const ops = new Set(logs.map((l) => l.payload.op));
      expect(ops.has("forward.mirror.uploaded")).toBe(true);
      expect(ops.has("forward.mirror.too_large")).toBe(true);
      expect(ops.has("forward.mirror.failed")).toBe(true);
      expect(ops.has("forward.mirror.done")).toBe(true);
    });
  });
});
