import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatworkClient } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import type { ChatworkMember } from "@/adapters/chatwork/types";
import { toChatworkRoomId } from "@/adapters/chatwork/types";
import { type ResolveSenderDeps, resolveSenderName } from "@/app/services/resolve-sender";
import { chatworkRoomMembers } from "@/db/schema";

// DUMMY 値（実 room/account/氏名を含まない / CON-002 / CON-005）。
const DUMMY_ROOM_ID = toChatworkRoomId("room-1234");
const DUMMY_ACCOUNT_ID = "9999999";
const DUMMY_SENDER_NAME = "Dummy Sender";
const OTHER_ACCOUNT_ID = "8888888";
const OTHER_SENDER_NAME = "Dummy Other";

/** 構造化ログ呼び出しを蓄積する fake logger。 */
interface CapturedLog {
  level: string;
  payload: Record<string, unknown>;
  message: string;
}

/**
 * `deps.db.db`（Drizzle ハンドル）をアダプタ境界でモックする。実 DB 非依存
 * （coding-rules SHOULD / forward-message.test.ts の fake-db パターンと整合）。
 *
 * SELECT は call-aware: N 回目の SELECT は `memberSelects[N-1]`（範囲外は末尾）を返す。
 * INSERT は `onConflictDoUpdate` の呼び出し引数を `captured.upsertSets` / `captured.upsertTargets` /
 * `captured.insertValues` に記録する。
 */
/**
 * `memberSelects` の各要素はその回の SELECT が返す結果を表す:
 *   - `Array<{ name: string }>`: 解決した行セット（空配列なら miss）
 *   - `{ throw: Error }`: その回の SELECT を await した時点で reject させる（DB 障害シミュレーション）
 */
type MemberSelectStep = Array<{ name: string }> | { throw: Error };

interface MemberSelectScript {
  /** 各 SELECT 呼び出しが順に返す結果（cache hit / refresh 後の再 SELECT / DB 失敗を表現）。 */
  memberSelects: MemberSelectStep[];
  /** INSERT.values().onConflictDoUpdate() を await した時点で reject させたいときに指定。 */
  upsertThrow?: Error;
}

interface CapturedDb {
  /** SELECT が `.from(chatworkRoomMembers)` で呼ばれた回数。 */
  memberSelectCount: number;
  /** INSERT 呼び出しの対象テーブル列。 */
  insertTables: unknown[];
  /** INSERT で受け取った values 配列。 */
  insertValues: unknown[];
  /** `onConflictDoUpdate` で受け取った `target` 配列。 */
  upsertTargets: unknown[];
  /** `onConflictDoUpdate` で受け取った `set` 配列。 */
  upsertSets: unknown[];
  /** 呼び出し順序（'select' / 'insert'）。リフレッシュが最大1回であることの検証用。 */
  callOrder: string[];
}

function makeDbMock(script: MemberSelectScript): {
  db: { db: unknown };
  captured: CapturedDb;
} {
  const captured: CapturedDb = {
    memberSelectCount: 0,
    insertTables: [],
    insertValues: [],
    upsertTargets: [],
    upsertSets: [],
    callOrder: [],
  };

  const db = {
    select(_columns: unknown) {
      return {
        from(table: unknown) {
          captured.callOrder.push("select");
          // members SELECT のみ扱う（resolve-sender は members 以外を SELECT しない）。
          if (table !== chatworkRoomMembers) {
            throw new Error("unexpected SELECT target in resolve-sender mock");
          }
          const idx = captured.memberSelectCount;
          captured.memberSelectCount += 1;
          const sets = script.memberSelects;
          const step = sets.length === 0 ? [] : (sets[Math.min(idx, sets.length - 1)] ?? []);
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  // {throw: Error} ステップは reject（DB 障害シミュレーション）。
                  if (!Array.isArray(step)) return Promise.reject(step.throw);
                  return Promise.resolve(step);
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      captured.callOrder.push("insert");
      captured.insertTables.push(table);
      return {
        values(values: unknown) {
          captured.insertValues.push(values);
          return {
            onConflictDoUpdate(opts: { target: unknown; set: unknown }) {
              captured.upsertTargets.push(opts.target);
              captured.upsertSets.push(opts.set);
              if (script.upsertThrow !== undefined) {
                return Promise.reject(script.upsertThrow);
              }
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };

  return { db: { db }, captured };
}

interface MakeDepsResult {
  deps: ResolveSenderDeps;
  captured: CapturedDb;
  getRoomMembers: ReturnType<typeof vi.fn>;
  logs: CapturedLog[];
}

function makeDeps(opts: {
  memberSelects: MemberSelectStep[];
  getRoomMembers?: (...args: unknown[]) => Promise<ChatworkMember[]>;
  upsertThrow?: Error;
}): MakeDepsResult {
  // exactOptionalPropertyTypes: true のため、undefined を明示せず分岐で構築する。
  const script: MemberSelectScript =
    opts.upsertThrow === undefined
      ? { memberSelects: opts.memberSelects }
      : { memberSelects: opts.memberSelects, upsertThrow: opts.upsertThrow };
  const { db, captured } = makeDbMock(script);
  const logs: CapturedLog[] = [];

  // デフォルトは「呼ばれたら fail」とし、明示的に設定されたケースのみ resolve/throw する。
  // これにより cache hit ケースで誤って呼ばれていないことも検証できる。
  const getRoomMembers = vi.fn(
    opts.getRoomMembers ??
      (async (): Promise<ChatworkMember[]> => {
        throw new Error("getRoomMembers not configured");
      }),
  );

  const chatworkClient = { getRoomMembers } as unknown as ChatworkClient;

  const record = (level: string) => (payload: Record<string, unknown>, message: string) => {
    logs.push({ level, payload, message });
  };
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as ResolveSenderDeps["logger"];

  const deps: ResolveSenderDeps = {
    db: db as unknown as ResolveSenderDeps["db"],
    chatworkClient,
    logger,
  };

  return { deps, captured, getRoomMembers, logs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSenderName", () => {
  describe("cache hit (no refresh)", () => {
    it("returns the cached name without calling getRoomMembers", async () => {
      // Arrange: members キャッシュに対象行あり（1 回目 SELECT で hit）。
      const { deps, captured, getRoomMembers } = makeDeps({
        memberSelects: [[{ name: DUMMY_SENDER_NAME }]],
      });

      // Act
      const result = await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: 名前が返り、API は叩かれない（レート制限回避 / 設計 §4.2 手順1）。
      expect(result).toBe(DUMMY_SENDER_NAME);
      expect(getRoomMembers).not.toHaveBeenCalled();
      expect(captured.memberSelectCount).toBe(1);
      // INSERT も走らない（cache hit のみ）。
      expect(captured.insertTables).toHaveLength(0);
    });
  });

  describe("cache miss → refresh hits", () => {
    it("calls getRoomMembers, upserts all members with onConflictDoUpdate, and returns the name after re-SELECT", async () => {
      // Arrange: 1 回目 SELECT は空（miss）、API はターゲットを含む配列を返し、
      //          upsert 後の 2 回目 SELECT で確定行が返る（forward.sender 解決の正常系）。
      const apiMembers: ChatworkMember[] = [
        { accountId: DUMMY_ACCOUNT_ID, name: DUMMY_SENDER_NAME },
        { accountId: OTHER_ACCOUNT_ID, name: OTHER_SENDER_NAME },
      ];
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[], [{ name: DUMMY_SENDER_NAME }]],
        getRoomMembers: async () => apiMembers,
      });

      // Act
      const result = await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: API は 1 回だけ呼ばれ、結果が返る。
      expect(result).toBe(DUMMY_SENDER_NAME);
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      expect(getRoomMembers).toHaveBeenCalledWith(DUMMY_ROOM_ID);

      // Assert: SELECT は 2 回（cache miss → upsert → 再 SELECT）。
      expect(captured.memberSelectCount).toBe(2);

      // Assert: upsert の引数が REQ-003 / 設計 §4.2 手順2 と整合する。
      //   target は [room, account] 列の組、set は excluded.name と updated_at。
      expect(captured.insertTables).toEqual([chatworkRoomMembers]);
      expect(captured.upsertTargets).toHaveLength(1);
      const target = captured.upsertTargets[0] as unknown[];
      expect(target).toContain(chatworkRoomMembers.chatworkRoomId);
      expect(target).toContain(chatworkRoomMembers.chatworkAccountId);

      // set には name（excluded.name の sql 値）と updatedAt が含まれること。
      const setObj = captured.upsertSets[0] as Record<string, unknown>;
      expect(setObj).toHaveProperty("name");
      expect(setObj).toHaveProperty("updatedAt");

      // values は API が返した全件（onConflictDoUpdate で冪等にキャッシュ更新する / NFR-004）。
      const insertedValues = captured.insertValues[0] as Array<{
        chatworkRoomId: unknown;
        chatworkAccountId: unknown;
        name: unknown;
      }>;
      expect(insertedValues).toHaveLength(2);
      const target1 = insertedValues.find((v) => v.chatworkAccountId === DUMMY_ACCOUNT_ID);
      expect(target1).toBeDefined();
      expect(target1?.chatworkRoomId).toBe(DUMMY_ROOM_ID);
      expect(target1?.name).toBe(DUMMY_SENDER_NAME);

      // 順序: select → insert → select（refresh は最大1回・再帰しない / 設計 §4.2）。
      expect(captured.callOrder).toEqual(["select", "insert", "select"]);

      // unresolved ログは出ない（解決済み）。
      expect(logs.find((l) => l.payload.op === "forward.sender.unresolved")).toBeUndefined();
    });
  });

  describe("cache miss → refresh misses (target not in returned list)", () => {
    it("returns null and emits forward.sender.unresolved with only op/roomId/accountId", async () => {
      // Arrange: 1 回目 SELECT は空、API は対象 account_id を含まない配列を返す。
      //          upsert は走るが、再 SELECT も空（退会済み・別ルーム発信等の経路）。
      const apiMembers: ChatworkMember[] = [
        { accountId: OTHER_ACCOUNT_ID, name: OTHER_SENDER_NAME },
      ];
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[], []],
        getRoomMembers: async () => apiMembers,
      });

      // Act
      const result = await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: null を返し（呼び出し側で account_id フォールバック）、API は 1 回だけ。
      expect(result).toBeNull();
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      expect(captured.memberSelectCount).toBe(2);

      // 専用 unresolved ログ（識別子のみ・本文/氏名/メンバーリスト非含有 / NFR-002）。
      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.level).toBe("info");
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
      // ログ payload に氏名・他メンバー名は載らない（NFR-002）。
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
      expect(serialized).not.toContain(OTHER_SENDER_NAME);
    });
  });

  describe("getRoomMembers throws ChatworkApiError", () => {
    it("returns null without re-throwing and logs unresolved without error details", async () => {
      // Arrange: API が認可エラー（403）相当を投げる。resolve-sender は内部で握り null を返す（CON-001）。
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[]],
        getRoomMembers: async () => {
          throw new ChatworkApiError("chatwork.getRoomMembers", 403);
        },
      });

      // Act
      const result = await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: null・例外は throw されない・API は 1 回呼ばれた（リトライしない）。
      expect(result).toBeNull();
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      // API 失敗時は INSERT・再 SELECT を行わない（最初の miss SELECT のみ）。
      expect(captured.memberSelectCount).toBe(1);
      expect(captured.insertTables).toHaveLength(0);

      // unresolved ログは識別子のみ（エラーメッセージ・トークン・氏名を含まない / NFR-002）。
      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
      // payload に err / status / token / 氏名は含まれない。
      expect(unresolved?.payload).not.toHaveProperty("err");
      expect(unresolved?.payload).not.toHaveProperty("status");
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain("403");
      expect(serialized).not.toContain("chatwork.getRoomMembers");
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
    });
  });

  describe("getRoomMembers returns an empty array", () => {
    it("returns null and skips the upsert safely", async () => {
      // Arrange: 1 回目 SELECT は空、API は空配列を返す（メンバー不在ルーム等）。
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[], []],
        getRoomMembers: async () => [],
      });

      // Act
      const result = await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: throw しない・null を返す・空 INSERT は発行しない（postgres-js 0 行 INSERT 回避）。
      expect(result).toBeNull();
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      expect(captured.insertTables).toHaveLength(0);

      // unresolved ログは出る（識別子のみ）。
      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
    });
  });

  describe("at most one refresh per call (no recursion / no retry loop)", () => {
    it("calls getRoomMembers exactly once even when cache miss + refresh produces nothing", async () => {
      // Arrange: cache miss + API は他人のみ返す → 再 SELECT も空 → unresolved。
      const { deps, getRoomMembers } = makeDeps({
        memberSelects: [[], []],
        getRoomMembers: async () => [{ accountId: OTHER_ACCOUNT_ID, name: OTHER_SENDER_NAME }],
      });

      // Act
      await resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps);

      // Assert: 設計 §4.2 の「1メッセージあたりリフレッシュ最大1回」を守る。
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
    });
  });

  // 「例外を投げない」契約（設計 §4.2 / tasks T006）の網羅:
  //   API 失敗だけでなく、キャッシュ SELECT / upsert / 再 SELECT のいずれが throw しても
  //   forwarding を止めてはいけない。ログは識別子のみ・エラー詳細は含めない（NFR-002）。
  describe("never throws on any internal failure (DB / API)", () => {
    /** ログに「エラー詳細・氏名・トークン・スタック」が漏れていないことを束で検証する。 */
    function assertNoLeakage(logs: CapturedLog[], dbErrorMessage?: string): void {
      const serialized = JSON.stringify(logs);
      // 氏名や他人のメンバー名は載らない。
      expect(serialized).not.toContain(DUMMY_SENDER_NAME);
      expect(serialized).not.toContain(OTHER_SENDER_NAME);
      // 任意の DB エラーメッセージ文字列も載らない（identifiers のみ）。
      if (dbErrorMessage !== undefined) {
        expect(serialized).not.toContain(dbErrorMessage);
      }
    }

    it("returns null and logs unresolved when the cache SELECT throws", async () => {
      // Arrange: 1 回目の SELECT 自体が DB エラーで reject（接続切れ / クエリ失敗等）。
      const dbErr = new Error("simulated cache select failure");
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [{ throw: dbErr }],
      });

      // Act + Assert: 例外を伝播させない（forwarding 非破壊 / CON-001）。
      await expect(resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps)).resolves.toBeNull();

      // API もリフレッシュも走らない（SELECT で先に失敗している）。
      expect(getRoomMembers).not.toHaveBeenCalled();
      expect(captured.insertTables).toHaveLength(0);

      // ログは識別子のみ・エラー詳細を含まない（NFR-002）。
      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.level).toBe("info");
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
      expect(unresolved?.payload).not.toHaveProperty("err");
      expect(unresolved?.payload).not.toHaveProperty("error");
      expect(unresolved?.payload).not.toHaveProperty("stack");
      expect(unresolved?.payload).not.toHaveProperty("members");
      assertNoLeakage(logs, dbErr.message);
    });

    it("returns null and logs unresolved when the upsert (insert/onConflictDoUpdate) throws", async () => {
      // Arrange: cache miss → API は対象を含む配列 → upsert が DB エラーで reject。
      const dbErr = new Error("simulated upsert failure");
      const apiMembers: ChatworkMember[] = [
        { accountId: DUMMY_ACCOUNT_ID, name: DUMMY_SENDER_NAME },
      ];
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[]],
        getRoomMembers: async () => apiMembers,
        upsertThrow: dbErr,
      });

      // Act + Assert
      await expect(resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps)).resolves.toBeNull();

      // API は 1 回呼ばれ（リフレッシュ最大1回）、upsert も発行された（その後 throw）。
      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      expect(captured.insertTables).toHaveLength(1);
      // upsert で死んだため再 SELECT には到達しない。
      expect(captured.memberSelectCount).toBe(1);

      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.level).toBe("info");
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
      expect(unresolved?.payload).not.toHaveProperty("err");
      expect(unresolved?.payload).not.toHaveProperty("members");
      assertNoLeakage(logs, dbErr.message);
    });

    it("returns null and logs unresolved when the re-SELECT (after upsert) throws", async () => {
      // Arrange: cache miss（1回目 SELECT 空）→ API 成功 → upsert 成功 → 再 SELECT で throw。
      const dbErr = new Error("simulated re-select failure");
      const apiMembers: ChatworkMember[] = [
        { accountId: DUMMY_ACCOUNT_ID, name: DUMMY_SENDER_NAME },
      ];
      const { deps, captured, getRoomMembers, logs } = makeDeps({
        memberSelects: [[], { throw: dbErr }],
        getRoomMembers: async () => apiMembers,
      });

      // Act + Assert
      await expect(resolveSenderName(DUMMY_ROOM_ID, DUMMY_ACCOUNT_ID, deps)).resolves.toBeNull();

      expect(getRoomMembers).toHaveBeenCalledTimes(1);
      // 再 SELECT まで到達していること（順序: select → insert → select）。
      expect(captured.callOrder).toEqual(["select", "insert", "select"]);
      expect(captured.memberSelectCount).toBe(2);

      const unresolved = logs.find((l) => l.payload.op === "forward.sender.unresolved");
      expect(unresolved).toBeDefined();
      expect(unresolved?.level).toBe("info");
      expect(unresolved?.payload).toEqual({
        op: "forward.sender.unresolved",
        roomId: DUMMY_ROOM_ID,
        accountId: DUMMY_ACCOUNT_ID,
      });
      expect(unresolved?.payload).not.toHaveProperty("err");
      expect(unresolved?.payload).not.toHaveProperty("members");
      assertNoLeakage(logs, dbErr.message);
    });
  });
});
