import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient, ChatworkRoom } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import type { WebhookPayload } from "@/adapters/chatwork/webhook-schema";
import type { SlackClient } from "@/adapters/slack/client";
import { toSlackChannelId, toSlackTs } from "@/adapters/slack/types";
import { type ForwardMessageDeps, forwardMessage } from "@/app/services/forward-message";
import { chatworkMessages, chatworkRoomMembers, chatworkRooms, type RoomType } from "@/db/schema";

// DUMMY 値（実 room/channel ID・実本文・実クライアント名を含まない / CON-005）。
const DEFAULT_GROUP = toSlackChannelId("C0DUMMYGROUP");
const DEFAULT_DM = toSlackChannelId("C0DUMMYDM");
const MAPPED_CHANNEL = toSlackChannelId("C0DUMMYMAPPED");
const DUMMY_TS = toSlackTs("1700000000.000100");
const DUMMY_BODY = "dummy message body";
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
  logs: { level: string; payload: Record<string, unknown>; message: string }[];
}

function makeDeps(opts: {
  script: DbScript;
  getRoom?: (...args: unknown[]) => Promise<ChatworkRoom>;
  postMessage?: (...args: unknown[]) => Promise<{ ts: ReturnType<typeof toSlackTs> }>;
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

  const chatworkClient = { getRoom } as unknown as ChatworkClient;
  const slackClient = { postMessage } as unknown as SlackClient;

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

  return { deps, captured, getRoom, postMessage, logs };
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
});
