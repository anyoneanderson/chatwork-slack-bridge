import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient, ChatworkRoom } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import type { WebhookPayload } from "@/adapters/chatwork/webhook-schema";
import type { SlackClient } from "@/adapters/slack/client";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import { type ForwardMessageDeps, forwardMessage } from "@/app/services/forward-message";
import {
  chatworkMessageAttachments,
  chatworkMessages,
  chatworkRoomMembers,
  chatworkRooms,
  type RoomType,
} from "@/db/schema";

// `mirrorAttachments` をモジュールモックで差し替える（factory.test.ts の vi.hoisted + vi.mock パターン踏襲）。
// デフォルトでは実装本体へ委譲し、既存テストは本物の挙動（getFileDownloadUrl/uploadFile 呼び出し・
// mapping 記録）をそのまま検証する（CON-001 非破壊）。`mirrorThrows` を真にしたテストのみ、
// mirror が（never-throw 契約を破って）throw する状況を再現し、forwardMessage 側の outer try/catch
// （forward-message.ts:223/242 の二重防御）が機能することを担保する。
const { mirrorState, mirrorAttachmentsSpy } = vi.hoisted(() => {
  const state: { throwOnce: Error | null } = { throwOnce: null };
  return {
    mirrorState: state,
    mirrorAttachmentsSpy: vi.fn(),
  };
});

vi.mock("@/app/services/mirror-attachments", async () => {
  const actual = await vi.importActual<typeof import("@/app/services/mirror-attachments")>(
    "@/app/services/mirror-attachments",
  );
  mirrorAttachmentsSpy.mockImplementation(
    async (...args: Parameters<typeof actual.mirrorAttachments>) => {
      if (mirrorState.throwOnce !== null) {
        const err = mirrorState.throwOnce;
        mirrorState.throwOnce = null;
        throw err;
      }
      return actual.mirrorAttachments(...args);
    },
  );
  return { ...actual, mirrorAttachments: mirrorAttachmentsSpy };
});

// DUMMY 値（実 room/channel ID・実本文・実クライアント名を含まない / CON-005）。
const DEFAULT_GROUP = toSlackChannelId("C0DUMMYGROUP");
const DEFAULT_DM = toSlackChannelId("C0DUMMYDM");
const MAPPED_CHANNEL = toSlackChannelId("C0DUMMYMAPPED");
const DUMMY_TS = toSlackTs("1700000000.000100");
const DUMMY_BODY = "dummy message body";
// 添付トークンを 1 件含むダミー本文（attachment-mirror / #18。実ファイル名・実 ID は含まない / CON-002）。
const DUMMY_BODY_WITH_ATTACHMENT = "dummy message body [download:111]dummy (1KB)[/download]";
const DUMMY_SENDER_NAME = "dummy sender name";
const DUMMY_ROOM_NAME = "dummy room name";

type WebhookEvent = WebhookPayload["webhook_event"];
type RoomRow = ReturnType<typeof roomRow>;

/** ダミーの message_created イベントを作る（送信者は account_id / ASM-002）。 */
function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    account_id: 1001,
    room_id: 2002,
    message_id: "msg-3003",
    body: DUMMY_BODY,
    send_time: 1_700_000_000,
    ...overrides,
  };
}

interface DbScript {
  /**
   * `chatwork_rooms` の SELECT が返す結果セットの列。各 SELECT 呼び出しで先頭から順に消費する。
   *
   * - 既知ルーム: SELECT は 1 回（`[ [row] ]`）。
   * - 初見ルーム: SELECT は 2 回（1回目=first-sight 検出 / 2回目=upsert 後の再 SELECT）。
   *   例: `[ [], [confirmedRow] ]`。
   *
   * 添字が列を超えた場合は最後の結果セットを返す（呼び出し回数の揺れに頑回にする）。
   */
  roomSelects: RoomRow[][];
  /**
   * `chatwork_room_members` の SELECT が返す結果セット（送信者名解決の cache / refresh 後の再 SELECT）。
   *
   * 既存テストは送信者名解決の経路を追加して以降も**挙動を維持**することが目的のため、デフォルト
   * （未指定）では空配列（cache miss）として扱う。`resolveSenderName` は `getRoomMembers` のデフォルト
   * 例外をログ＋null で握り、`forwardMessage` は senderName=null のままフローを継続する。
   */
  memberSelects?: Array<{ name: string }>[];
  /** messages insert ... returning() が返す行（空配列 = 再送/重複）。 */
  insertReturning: Array<{ id: bigint }>;
  /** true のとき update().set().where() の Promise を reject する（ts UPDATE 失敗の再現）。 */
  updateRejects?: boolean;
  /**
   * `chatwork_message_attachments` SELECT（添付ミラーの既アップロード判定）が返す行。
   * `where()` を直接 await する（limit なし）チェーン。未指定なら空配列（未アップロード）。
   */
  attachmentSelects?: Array<{ fileId: string }>;
}

interface CapturedDb {
  selectFromTables: unknown[];
  insertTables: unknown[];
  insertValues: unknown[];
  updateTables: unknown[];
  updateSets: unknown[];
  /** insert / select / update 呼び出しの順序を記録（FK 順序検証用）。 */
  callOrder: string[];
  /** `chatwork_rooms` SELECT の回数。 */
  roomSelectCount: number;
  /** `chatwork_room_members` SELECT の回数。 */
  memberSelectCount: number;
}

/**
 * `deps.db.db`（Drizzle ハンドル）をアダプタ境界でモックする。実 DB 非依存（coding-rules SHOULD）。
 *
 * SELECT は call-aware: N 回目の SELECT は `script.roomSelects[N-1]`（範囲外は末尾）を返す。
 * これにより初見ルームの「first-sight 検出 → upsert → 再 SELECT」を再現でき、再 SELECT が
 * 権威ある DB 行を返す本番の挙動（並行作成された disabled/mapped/my 行が勝つ）を検証できる。
 *
 * 本番コードのチェーン:
 *  - select({...}).from(t).where(...).limit(n)        → roomSelects を順に resolve
 *  - insert(rooms).values(...).onConflictDoNothing()  → await（returning なし）
 *  - insert(messages).values(...).onConflictDoNothing().returning(...) → insertReturning を resolve
 *  - update(messages).set(...).where(...)             → await（updateRejects のとき reject）
 */
function makeDbMock(script: DbScript): { db: { db: unknown }; captured: CapturedDb } {
  const captured: CapturedDb = {
    selectFromTables: [],
    insertTables: [],
    insertValues: [],
    updateTables: [],
    updateSets: [],
    callOrder: [],
    roomSelectCount: 0,
    memberSelectCount: 0,
  };

  const db = {
    select(_columns: unknown) {
      return {
        from(table: unknown) {
          captured.selectFromTables.push(table);
          captured.callOrder.push("select");
          // SELECT 対象テーブルで結果セットを切り替える（rooms / room_members）。
          // 既存テストは rooms SELECT の回数・順序を検証するため、`roomSelectCount` は
          // rooms SELECT のみカウントする（members SELECT は別カウンタ）。
          // 添付ミラーの既アップロード判定 SELECT は `where()` を直接 await する（limit なし）。
          // rooms / members の `where().limit()` チェーンと別形のため、テーブルで分岐する。
          if (table === chatworkMessageAttachments) {
            const attachmentRows = script.attachmentSelects ?? [];
            return {
              where(_cond: unknown) {
                return Promise.resolve(attachmentRows);
              },
            };
          }

          let rows: unknown[];
          if (table === chatworkRoomMembers) {
            const idx = captured.memberSelectCount;
            captured.memberSelectCount += 1;
            const sets = script.memberSelects ?? [];
            rows = sets.length === 0 ? [] : (sets[Math.min(idx, sets.length - 1)] ?? []);
          } else {
            const idx = captured.roomSelectCount;
            captured.roomSelectCount += 1;
            const sets = script.roomSelects;
            rows = sets.length === 0 ? [] : (sets[Math.min(idx, sets.length - 1)] ?? []);
          }
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      captured.insertTables.push(table);
      captured.callOrder.push("insert");
      return {
        values(values: unknown) {
          captured.insertValues.push(values);
          return {
            onConflictDoNothing(_opts: unknown) {
              // rooms upsert は returning を呼ばず await される（実 Promise で吸収）。
              // messages insert は returning() を呼ぶため、Promise に returning メソッドを付ける。
              const result = Promise.resolve(undefined) as Promise<undefined> & {
                returning(cols: unknown): Promise<Array<{ id: bigint }>>;
              };
              result.returning = (_cols: unknown) => Promise.resolve(script.insertReturning);
              return result;
            },
            // members upsert（resolve-sender）は onConflictDoUpdate を使う。
            // 結果は await されるのみ（returning を呼ばない）ため Promise<undefined> を返す。
            onConflictDoUpdate(_opts: unknown) {
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    update(table: unknown) {
      captured.updateTables.push(table);
      captured.callOrder.push("update");
      return {
        set(values: unknown) {
          captured.updateSets.push(values);
          return {
            where(_cond: unknown) {
              return script.updateRejects
                ? Promise.reject(new Error("db update failed"))
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
  deps: ForwardMessageDeps;
  captured: CapturedDb;
  getRoom: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  /** 添付ミラー用（attachment-mirror / #18）。デフォルトはダミー成功を返す。 */
  getFileDownloadUrl: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  logs: { level: string; payload: Record<string, unknown>; message: string }[];
}

function makeDeps(opts: {
  script: DbScript;
  getRoom?: (...args: unknown[]) => Promise<ChatworkRoom>;
  postMessage?: (...args: unknown[]) => Promise<{ ts: ReturnType<typeof toSlackTs> }>;
  getFileDownloadUrl?: (...args: unknown[]) => Promise<unknown>;
  downloadFile?: (...args: unknown[]) => Promise<{ bytes: Uint8Array; mimeType: string | null }>;
  uploadFile?: (...args: unknown[]) => Promise<{ slackFileId: string }>;
}): MakeDepsResult {
  const { db, captured } = makeDbMock(opts.script);
  const logs: MakeDepsResult["logs"] = [];

  const getRoom = vi.fn(
    opts.getRoom ??
      (async (): Promise<ChatworkRoom> => {
        throw new Error("getRoom not configured");
      }),
  );
  const postMessage = vi.fn(opts.postMessage ?? (async () => ({ ts: DUMMY_TS })));

  // 添付ミラー（mirrorAttachments）用のダミー実装。デフォルトは全件成功。
  const getFileDownloadUrl = vi.fn(
    opts.getFileDownloadUrl ??
      (async (_roomId: unknown, fileId: unknown) => ({
        fileId: String(fileId),
        filename: "dummy-attachment.png",
        filesize: 1024,
        mimeType: "image/png",
        downloadUrl: "https://chatwork-storage.example.test/dummy-url",
      })),
  );
  const downloadFile = vi.fn(
    opts.downloadFile ??
      (async () => ({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" })),
  );
  const uploadFile = vi.fn(opts.uploadFile ?? (async () => ({ slackFileId: "F0DUMMYFILE" })));

  const chatworkClient = { getRoom, getFileDownloadUrl, downloadFile } as unknown as ChatworkClient;
  const slackClient = { postMessage, uploadFile } as unknown as SlackClient;

  const record = (level: string) => (payload: Record<string, unknown>, message: string) => {
    logs.push({ level, payload, message });
  };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as ForwardMessageDeps["logger"];

  const deps: ForwardMessageDeps = {
    db: db as unknown as ForwardMessageDeps["db"],
    chatworkClient,
    slackClient,
    logger,
    defaultGroupChannelId: DEFAULT_GROUP,
    defaultDmChannelId: DEFAULT_DM,
  };

  return {
    deps,
    captured,
    getRoom,
    postMessage,
    getFileDownloadUrl,
    downloadFile,
    uploadFile,
    logs,
  };
}

/** ルーム行を作る（select が返す形）。 */
function roomRow(
  overrides: Partial<{
    roomType: RoomType;
    enabled: boolean;
    slackChannelId: string | null;
  }> = {},
) {
  return {
    chatworkRoomId: "2002",
    roomType: overrides.roomType ?? "group",
    enabled: overrides.enabled ?? true,
    slackChannelId: overrides.slackChannelId ?? null,
    roomName: DUMMY_ROOM_NAME,
  };
}

/** ルーム行 1 件を返す既知ルームの SELECT 結果列（1 回 SELECT）。 */
function knownRoom(overrides: Parameters<typeof roomRow>[0] = {}): RoomRow[][] {
  return [[roomRow(overrides)]];
}

/** getRoom が返す ChatworkRoom を作る（初見ルーム）。 */
function chatworkRoom(type: RoomType): ChatworkRoom {
  return { roomId: "2002" as ChatworkRoom["roomId"], name: DUMMY_ROOM_NAME, type };
}

function serializeLogs(logs: MakeDepsResult["logs"]): string {
  return JSON.stringify(logs);
}

afterEach(() => {
  vi.restoreAllMocks();
  // mirror モックの一回限り throw フラグをリセットし、呼び出し履歴も消す（テスト間の漏れ防止）。
  // mockClear は履歴のみ消し、vi.mock 内で設定した実装委譲は保持する（restoreAllMocks では消えない）。
  mirrorState.throwOnce = null;
  mirrorAttachmentsSpy.mockClear();
});

describe("forwardMessage", () => {
  describe("dedup / idempotency (REQ-005 / NFR-006)", () => {
    it("posts to slack and updates ts when a new message is inserted", async () => {
      // Arrange: 既知 group ルーム + 新規挿入（returning が行を返す）。
      const { deps, captured, postMessage } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [{ id: 42n }] },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: Slack 投稿が 1 回 + ts UPDATE が呼ばれる。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.updateTables).toContain(chatworkMessages);
      expect(captured.updateSets).toHaveLength(1);
      const set = captured.updateSets[0] as { slackChannelId: unknown; slackTs: unknown };
      expect(set.slackChannelId).toBe(DEFAULT_GROUP);
      expect(set.slackTs).toBe(DUMMY_TS);
    });

    it("does not post or update on a resend (onConflictDoNothing returns empty)", async () => {
      // Arrange: 既知 group ルーム + 再送（returning が空配列）。
      const { deps, captured, postMessage } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [] },
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: Slack 投稿も ts UPDATE も呼ばれない（冪等）。
      expect(postMessage).not.toHaveBeenCalled();
      expect(captured.updateTables).toHaveLength(0);
    });
  });

  describe("FK order / first-seen room (REQ-006)", () => {
    it("calls getRoom, upserts chatwork_rooms BEFORE inserting chatwork_messages, then re-selects", async () => {
      // Arrange: 初見ルーム。1 回目 SELECT は空（first-sight）、upsert 後の 2 回目 SELECT は
      // 確定行（getRoom 由来の group / enabled=true / channel=null）を返す。
      const { deps, captured, getRoom } = makeDeps({
        script: {
          roomSelects: [[], [roomRow({ roomType: "group", enabled: true, slackChannelId: null })]],
          insertReturning: [{ id: 7n }],
        },
        getRoom: async () => chatworkRoom("group"),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: getRoom が 1 回、rooms SELECT が 2 回（前後）、rooms insert が messages insert より前。
      expect(getRoom).toHaveBeenCalledTimes(1);
      expect(captured.roomSelectCount).toBe(2);
      const roomsIdx = captured.insertTables.indexOf(chatworkRooms);
      const messagesIdx = captured.insertTables.indexOf(chatworkMessages);
      expect(roomsIdx).toBeGreaterThanOrEqual(0);
      expect(messagesIdx).toBeGreaterThanOrEqual(0);
      expect(roomsIdx).toBeLessThan(messagesIdx);
      // 順序: select(rooms first) → insert(rooms) → select(rooms re) → select(members cache miss)
      //   → insert(messages) → update。送信者名解決（resolveSenderName）が rooms 解決後・
      //   messages INSERT の前に割り込み、members キャッシュを 1 回 SELECT する（cache miss → API
      //   は未設定で throw → 内部で握って null を返す → members の INSERT は発行されない）。
      expect(captured.callOrder).toEqual([
        "select",
        "insert",
        "select",
        "select",
        "insert",
        "update",
      ]);
    });

    it("does not call getRoom for a known (cached) room (single SELECT)", async () => {
      // Arrange: 既知ルーム → キャッシュ利用（SELECT は 1 回のみ）。
      const { deps, captured, getRoom } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [{ id: 9n }] },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert
      expect(getRoom).not.toHaveBeenCalled();
      expect(captured.roomSelectCount).toBe(1);
    });
  });

  describe("concurrent-config re-read: authoritative DB row wins (not getRoom result)", () => {
    it("uses the re-selected disabled row and does NOT post even though getRoom said enabled group", async () => {
      // Arrange: 初見扱い（1 回目 SELECT 空）→ getRoom は group/enabled、しかし並行作成された
      // 行が enabled=false で 2 回目 SELECT に現れる → DB 行が勝ち、投稿しない。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: [[], [roomRow({ roomType: "group", enabled: false, slackChannelId: null })]],
          insertReturning: [{ id: 21n }],
        },
        getRoom: async () => chatworkRoom("group"),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: メッセージは保存されるが投稿・ts UPDATE は無し（DB の disabled が優先）。
      expect(captured.insertTables).toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
      expect(captured.updateTables).toHaveLength(0);
    });

    it("posts to the re-selected mapped channel, not the type fallback", async () => {
      // Arrange: 初見扱い → getRoom は group（紐付けなし想定）だが、2 回目 SELECT は
      // slackChannelId 設定済みの行を返す → 専用チャンネルへ投稿（集約フォールバックではない）。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: [
            [],
            [roomRow({ roomType: "group", enabled: true, slackChannelId: "C0DUMMYMAPPED" })],
          ],
          insertReturning: [{ id: 23n }],
        },
        getRoom: async () => chatworkRoom("group"),
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: 専用チャンネルへ投稿し ts を保存（DEFAULT_GROUP ではない）。
      expect(postMessage).toHaveBeenCalledTimes(1);
      const [channelArg] = postMessage.mock.calls[0] as [unknown, unknown];
      expect(channelArg).toBe(MAPPED_CHANNEL);
      const set = captured.updateSets[0] as { slackChannelId: unknown };
      expect(set.slackChannelId).toBe(MAPPED_CHANNEL);
    });

    it("skips (no save/no post) when the re-selected row is my even though getRoom said group", async () => {
      // Arrange: 初見扱い → getRoom は group だが 2 回目 SELECT は my を返す → 保存前 skip。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: [[], [roomRow({ roomType: "my" })]],
          insertReturning: [],
        },
        getRoom: async () => chatworkRoom("group"),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: rooms upsert は起きるが messages insert も投稿も無し。
      expect(captured.insertTables).toContain(chatworkRooms);
      expect(captured.insertTables).not.toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  describe("reselect_missing edge (post-upsert SELECT returns nothing)", () => {
    it("does not insert a message or post and logs forward.room.reselect_missing", async () => {
      // Arrange: 両 SELECT が空、getRoom は成功（通常起こり得ないが安全側に倒す経路）。
      const { deps, captured, postMessage, logs } = makeDeps({
        script: { roomSelects: [[], []], insertReturning: [] },
        getRoom: async () => chatworkRoom("group"),
      });

      // Act: rethrow しない。
      await expect(forwardMessage(makeEvent(), deps)).resolves.toBeUndefined();

      // Assert: メッセージ未保存・Slack 投稿無し・専用ログ。
      expect(captured.insertTables).not.toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
      const missing = logs.find((l) => l.payload.op === "forward.room.reselect_missing");
      expect(missing).toBeDefined();
      expect(missing?.payload.roomId).toBe("2002");
      // 本文・送信者名は含めない。
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain(DUMMY_BODY);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });
  });

  describe("ts UPDATE failure after a successful post (forward.slack.ts_update)", () => {
    it("logs forward.slack.ts_update with identifiers and resolves without rethrowing", async () => {
      // Arrange: 既知 group ルーム / 新規挿入 / postMessage 成功 / update が reject。
      const { deps, captured, postMessage, logs } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [{ id: 31n }], updateRejects: true },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act: route まで例外を伝播させない。
      await expect(forwardMessage(makeEvent(), deps)).resolves.toBeUndefined();

      // Assert: 投稿は成功・行は挿入済み・UPDATE は試みられた。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.insertTables).toContain(chatworkMessages);
      expect(captured.updateTables).toContain(chatworkMessages);

      // ts_update 専用ログに識別子が載り、本文・トークンは載らない。
      const tsUpdate = logs.find((l) => l.payload.op === "forward.slack.ts_update");
      expect(tsUpdate).toBeDefined();
      expect(tsUpdate?.payload).toMatchObject({
        op: "forward.slack.ts_update",
        roomId: "2002",
        messageId: "msg-3003",
        channelId: DEFAULT_GROUP,
        slackTs: DUMMY_TS,
      });
      // 投稿成功扱いのため、forward.posted は出さない。
      expect(logs.find((l) => l.payload.op === "forward.posted")).toBeUndefined();
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain(DUMMY_BODY);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });
  });

  describe("my skip (CON-003)", () => {
    it("does not insert a message or post when room_type is my (known room)", async () => {
      // Arrange: 既知 my ルーム。
      const { deps, captured, postMessage } = makeDeps({
        script: { roomSelects: knownRoom({ roomType: "my" }), insertReturning: [] },
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: messages insert も Slack 投稿も無し。
      expect(captured.insertTables).not.toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
    });

    it("skips a first-seen my room before inserting any message", async () => {
      // Arrange: 初見ルーム + getRoom が my を返す。再 SELECT も my（メタ行はキャッシュ、保存前 skip）。
      const { deps, captured, postMessage } = makeDeps({
        script: { roomSelects: [[], [roomRow({ roomType: "my" })]], insertReturning: [] },
        getRoom: async () => chatworkRoom("my"),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: rooms upsert は起きるが messages insert は起きない。
      expect(captured.insertTables).toContain(chatworkRooms);
      expect(captured.insertTables).not.toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  describe("getRoom failure on first-seen room", () => {
    it("does not insert a message and logs forward.room.unresolved when getRoom throws", async () => {
      // Arrange: 初見ルーム + getRoom が ChatworkApiError を投げる（権限なし/429 等）。
      const { deps, captured, postMessage, logs } = makeDeps({
        script: { roomSelects: [[]], insertReturning: [] },
        getRoom: async () => {
          throw new ChatworkApiError("chatwork.getRoom", 403);
        },
      });

      // Act: route まで rethrow しない（例外を握る）。
      await expect(forwardMessage(makeEvent(), deps)).resolves.toBeUndefined();

      // Assert: メッセージ未保存・rooms upsert 無し・Slack 投稿無し。
      expect(captured.insertTables).not.toContain(chatworkMessages);
      expect(captured.insertTables).not.toContain(chatworkRooms);
      expect(postMessage).not.toHaveBeenCalled();

      // unresolved ログが出る（本文・トークンは含まない）。
      const unresolved = logs.find((l) => l.payload.op === "forward.room.unresolved");
      expect(unresolved).toBeDefined();
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain(DUMMY_BODY);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });
  });

  describe("disabled room", () => {
    it("saves the message but does not post to slack when enabled is false", async () => {
      // Arrange: 既知 group ルーム / enabled=false / 新規挿入。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: knownRoom({ enabled: false }),
          insertReturning: [{ id: 11n }],
        },
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: messages insert は起きるが投稿・ts UPDATE は無し。
      expect(captured.insertTables).toContain(chatworkMessages);
      expect(postMessage).not.toHaveBeenCalled();
      expect(captured.updateTables).toHaveLength(0);
    });
  });

  describe("Slack failure keeps the saved message (NFR-005)", () => {
    it("keeps the inserted row, skips the ts update, logs the error, and does not rethrow", async () => {
      // Arrange: 既知 group ルーム / 新規挿入 / postMessage が throw。
      const { deps, captured, postMessage, logs } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [{ id: 13n }] },
        postMessage: async () => {
          throw new Error("slack down");
        },
      });

      // Act: route まで例外を伝播させない（route は 200 を返す前提）。
      await expect(forwardMessage(makeEvent(), deps)).resolves.toBeUndefined();

      // Assert: 投稿は試みられたが ts UPDATE は起きない（保存済み行は残る）。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.insertTables).toContain(chatworkMessages);
      expect(captured.updateTables).toHaveLength(0);

      // forward.slack.post エラーログが出る（本文・トークンは含まない）。
      const slackErr = logs.find((l) => l.payload.op === "forward.slack.post");
      expect(slackErr).toBeDefined();
      expect(serializeLogs(logs)).not.toContain(DUMMY_BODY);
    });
  });

  describe("sender name resolution (REQ-002 / REQ-004 / 設計 §2)", () => {
    it("persists senderName to chatwork_messages when getRoomMembers returns the target", async () => {
      // Arrange: 既知 group ルーム / members キャッシュは miss → API がターゲットを含む配列を返す。
      // 再 SELECT で確定行が返り、resolveSenderName は表示名を返す → senderName が persist される。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          memberSelects: [[], [{ name: DUMMY_SENDER_NAME }]],
          insertReturning: [{ id: 51n }],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });
      // chatworkClient.getRoomMembers をデフォルト fail から差し替える（forward は ChatworkClient を 1 つだけ持つ）。
      (
        deps.chatworkClient as unknown as { getRoomMembers: (...a: unknown[]) => Promise<unknown> }
      ).getRoomMembers = vi.fn(async () => [{ accountId: "1001", name: DUMMY_SENDER_NAME }]);

      // Act
      await forwardMessage(makeEvent({ account_id: 1001 }), deps);

      // Assert: senderName が messages 行に "Dummy Sender" として書かれる（null ではない）。
      const messageValues = captured.insertValues.find(
        (v): v is { senderName: unknown; chatworkAccountId: unknown } =>
          typeof v === "object" && v !== null && "chatworkAccountId" in v && "senderName" in v,
      );
      expect(messageValues).toBeDefined();
      expect((messageValues as { senderName: unknown }).senderName).toBe(DUMMY_SENDER_NAME);

      // refresh が走った（members SELECT が 2 回: cache miss → 再 SELECT）。
      expect(captured.memberSelectCount).toBe(2);
      // Slack 投稿は行われる。
      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it("persists senderName as null and still completes forwarding when getRoomMembers throws", async () => {
      // Arrange: 既知 group ルーム / members キャッシュ miss + API が ChatworkApiError を投げる。
      // resolve-sender は内部で握って null を返し、forward は accountId フォールバックで投稿継続する（CON-001）。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          memberSelects: [[]],
          insertReturning: [{ id: 53n }],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });
      (
        deps.chatworkClient as unknown as { getRoomMembers: (...a: unknown[]) => Promise<unknown> }
      ).getRoomMembers = vi.fn(async () => {
        throw new ChatworkApiError("chatwork.getRoomMembers", 403);
      });

      // Act: 例外は伝播しない。
      await expect(forwardMessage(makeEvent({ account_id: 1001 }), deps)).resolves.toBeUndefined();

      // Assert: senderName は null で persist される（REQ-004 / フォールバック）。
      const messageValues = captured.insertValues.find(
        (v): v is { senderName: unknown; chatworkAccountId: unknown } =>
          typeof v === "object" && v !== null && "chatworkAccountId" in v && "senderName" in v,
      );
      expect(messageValues).toBeDefined();
      expect((messageValues as { senderName: unknown }).senderName).toBeNull();

      // forwarding は完走する: Slack 投稿が 1 回、ts UPDATE が 1 回。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.updateTables).toContain(chatworkMessages);

      // 投稿テキストは accountId フォールバック（"1001"）を含み、表示名行に立つ。
      const [, message] = postMessage.mock.calls[0] as [unknown, { text: string }];
      expect(message.text).toContain("1001:");
      expect(message.text).not.toContain(`${DUMMY_SENDER_NAME}:`);
    });

    it("passes roomId + messageId + senderName to format() (text contains deep link and display name)", async () => {
      // Arrange: 解決済み senderName + 既知 group ルームで投稿させる。
      const { deps, postMessage } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          memberSelects: [[], [{ name: DUMMY_SENDER_NAME }]],
          insertReturning: [{ id: 55n }],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });
      (
        deps.chatworkClient as unknown as { getRoomMembers: (...a: unknown[]) => Promise<unknown> }
      ).getRoomMembers = vi.fn(async () => [{ accountId: "1001", name: DUMMY_SENDER_NAME }]);

      // Act
      await forwardMessage(makeEvent({ account_id: 1001 }), deps);

      // Assert: postMessage に渡るテキストに表示名 + ディープリンクが含まれる。
      expect(postMessage).toHaveBeenCalledTimes(1);
      const [channel, message] = postMessage.mock.calls[0] as [unknown, { text: string }];
      expect(channel).toBe(DEFAULT_GROUP);
      expect(message.text).toContain(`${DUMMY_SENDER_NAME}:`);
      // ディープリンクは roomId + messageId 由来（fixture: room_id=2002 / message_id="msg-3003"）。
      expect(message.text).toContain(
        "<https://www.chatwork.com/#!rid2002-msg-3003|Chatworkで開く>",
      );
    });
  });

  describe("persistence detail / no log leakage", () => {
    it("stores account_id as chatworkAccountId and never logs body or sender name", async () => {
      // Arrange: 既知 group ルーム / 新規挿入。
      const { deps, captured, logs } = makeDeps({
        script: { roomSelects: knownRoom(), insertReturning: [{ id: 17n }] },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent({ account_id: 1001 }), deps);

      // Assert: account_id が chatworkAccountId に文字列で格納される。
      const messageValues = captured.insertValues.find(
        (v): v is { chatworkAccountId: unknown; senderName: unknown } =>
          typeof v === "object" && v !== null && "chatworkAccountId" in v,
      );
      expect(messageValues).toBeDefined();
      expect((messageValues as { chatworkAccountId: unknown }).chatworkAccountId).toBe("1001");
      // sender_name は payload に無いため null（ASM-002 / REQ-005）。
      expect((messageValues as { senderName: unknown }).senderName).toBeNull();

      // ログに本文・送信者名・トークンを含めない（NFR-003）。
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain(DUMMY_BODY);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });

    it("posts an unmapped direct room to the DM fallback channel", async () => {
      // Arrange: 既知 direct ルーム / 紐付けなし / 新規挿入。
      const { deps, captured, postMessage } = makeDeps({
        script: {
          roomSelects: knownRoom({ roomType: "direct", slackChannelId: null }),
          insertReturning: [{ id: 19n }],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent(), deps);

      // Assert: DM 集約チャンネルへ投稿し ts を保存する。
      expect(postMessage).toHaveBeenCalledTimes(1);
      const [channelArg] = postMessage.mock.calls[0] as [unknown, unknown];
      expect(channelArg).toBe(DEFAULT_DM);
      const set = captured.updateSets[0] as { slackChannelId: unknown };
      expect(set.slackChannelId).toBe(DEFAULT_DM);
    });
  });

  describe("attachment mirror wiring (attachment-mirror / #18 / 設計 §4.5)", () => {
    it("invokes the attachment mirror after a successful ts UPDATE when the body has attachments", async () => {
      // Arrange: 既知 group ルーム / 新規挿入 / ts UPDATE 成功 / 添付付き本文。
      const { deps, captured, postMessage, getFileDownloadUrl, uploadFile } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          insertReturning: [{ id: 61n }],
          attachmentSelects: [],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act
      await forwardMessage(makeEvent({ body: DUMMY_BODY_WITH_ATTACHMENT }), deps);

      // Assert: 投稿 + ts UPDATE 成功後に mirror が動き、添付メタ取得・Slack アップロード・mapping 記録が走る。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.updateTables).toContain(chatworkMessages);
      expect(getFileDownloadUrl).toHaveBeenCalledTimes(1);
      const [roomArg, fileArg] = getFileDownloadUrl.mock.calls[0] as [unknown, string];
      expect(roomArg).toBe("2002");
      expect(fileArg).toBe("111");
      expect(uploadFile).toHaveBeenCalledTimes(1);
      // mapping は FK 親（messageRowId）と file を持って insert される。
      const mappingValues = captured.insertValues.find(
        (v): v is { chatworkMessageId: unknown; chatworkFileId: unknown } =>
          typeof v === "object" && v !== null && "chatworkFileId" in v,
      );
      expect(mappingValues).toBeDefined();
      expect((mappingValues as { chatworkMessageId: unknown }).chatworkMessageId).toBe(61n);
      expect((mappingValues as { chatworkFileId: unknown }).chatworkFileId).toBe("111");
    });

    it("does NOT invoke the attachment mirror when the ts UPDATE fails (design §4.5: no thread_ts)", async () => {
      // Arrange: 投稿成功するが ts UPDATE が reject → mirror へ到達しないこと（thread 指定不能のため）。
      const { deps, getFileDownloadUrl, uploadFile, logs } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          insertReturning: [{ id: 63n }],
          updateRejects: true,
          attachmentSelects: [],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act: route まで例外を伝播させない。
      await expect(
        forwardMessage(makeEvent({ body: DUMMY_BODY_WITH_ATTACHMENT }), deps),
      ).resolves.toBeUndefined();

      // Assert: 添付ミラーは一切呼ばれない（ts_update ログで return 済み）。
      expect(getFileDownloadUrl).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(logs.find((l) => l.payload.op === "forward.slack.ts_update")).toBeDefined();
      expect(logs.find((l) => l.payload.op === "forward.posted")).toBeUndefined();
    });

    it("keeps the forward flow alive (outer try/catch) even if the attachment mirror throws unexpectedly", async () => {
      // Arrange: mirror 内部の既アップロード判定 SELECT が reject。mirrorAttachments は内部で握る契約だが、
      // 仮に throw しても forward-message の二重防御 outer try/catch が握ることを担保する。
      // ここでは attachment SELECT を reject させ、mirror が内部 catch するパス（never-throw）を通す。
      const { deps, postMessage, logs } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          insertReturning: [{ id: 65n }],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });
      // attachment SELECT を reject させる（mirror 内部の外側 catch が握る → forward は完走）。
      const original = deps.db.db as {
        select: (c: unknown) => { from: (t: unknown) => unknown };
      };
      const baseSelect = original.select.bind(original);
      original.select = (cols: unknown) => {
        const chain = baseSelect(cols) as { from: (t: unknown) => unknown };
        return {
          from(table: unknown) {
            if (table === chatworkMessageAttachments) {
              return { where: () => Promise.reject(new Error("attachment select failed")) };
            }
            return chain.from(table);
          },
        };
      };

      // Act: route まで例外を伝播させない。
      await expect(
        forwardMessage(makeEvent({ body: DUMMY_BODY_WITH_ATTACHMENT }), deps),
      ).resolves.toBeUndefined();

      // Assert: 投稿は成功し forward.posted が出る。mirror は内部で握り forward フローは生きている。
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(logs.find((l) => l.payload.op === "forward.posted")).toBeDefined();
      // 本文・トークンは漏れない。
      expect(serializeLogs(logs)).not.toContain(DUMMY_SENDER_NAME);
    });

    it("catches a thrown mirrorAttachments via the outer try/catch, logs forward.mirror.unexpected, and never rethrows", async () => {
      // Arrange: 既知 group ルーム / 新規挿入 / ts UPDATE 成功。mirrorAttachments を module mock で
      // 直接 throw させ、forwardMessage 側の二重防御 outer try/catch（forward-message.ts:223/242）が
      // 実際に踏まれることを担保する（mirror 内部の catch ではなく forward 側で握る経路 / NFR-005）。
      mirrorState.throwOnce = new Error("mirror exploded unexpectedly");
      const { deps, captured, postMessage, logs } = makeDeps({
        script: {
          roomSelects: knownRoom(),
          insertReturning: [{ id: 67n }],
          attachmentSelects: [],
        },
        postMessage: async () => ({ ts: DUMMY_TS }),
      });

      // Act: mirror が throw しても route まで例外を伝播させない（reject しない）。
      await expect(
        forwardMessage(makeEvent({ body: DUMMY_BODY_WITH_ATTACHMENT }), deps),
      ).resolves.toBeUndefined();

      // Assert: mirror は 1 回呼ばれ（throw した）、投稿・ts UPDATE は成功済みのため forward フローは完走。
      expect(mirrorAttachmentsSpy).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(captured.updateTables).toContain(chatworkMessages);
      // forward.posted は出る（投稿成功）。
      expect(logs.find((l) => l.payload.op === "forward.posted")).toBeDefined();
      // forwardMessage 側の outer catch が握ったことを示す専用ログ（識別子のみ）。
      const unexpected = logs.find((l) => l.payload.op === "forward.mirror.unexpected");
      expect(unexpected).toBeDefined();
      expect(unexpected?.payload).toMatchObject({
        op: "forward.mirror.unexpected",
        roomId: "2002",
        messageId: "msg-3003",
        channelId: DEFAULT_GROUP,
      });
      // 本文・送信者名・トークンは漏れない（NFR-002）。
      const serialized = serializeLogs(logs);
      expect(serialized).not.toContain(DUMMY_BODY_WITH_ATTACHMENT);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });

    // 並行 worker による同 file の二重 Slack アップロードは本 Issue 非対応（ops-safety #5 の領域 /
    // 設計 §3.3）。webhook 再送は forwardMessage の onConflictDoNothing で早期 return するため
    // mirrorAttachments まで到達しない（"dedup / idempotency" の既存テストでカバー済み）。
  });
});
