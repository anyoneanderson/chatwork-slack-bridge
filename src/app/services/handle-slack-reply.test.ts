import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { toSlackTs } from "@/adapters/slack/types";
import type { SlackReplyEvent } from "@/app/services/handle-slack-reply";
import { type HandleSlackReplyDeps, handleSlackReply } from "@/app/services/handle-slack-reply";
import type { DbClient } from "@/db/client";
import { chatworkMessages, chatworkRooms } from "@/db/schema";

// DUMMY 値（実 channel/ts/user・実本文を含まない / CON-003）。
const DUMMY_CHANNEL = "C0DUMMYCHAN";
const DUMMY_TS = "1700000000.000100";
const DUMMY_THREAD_TS = "1700000000.000000";
const DUMMY_CONFIRM_TS = "1700000000.000200";
const DUMMY_USER = "U0DUMMYUSER";
const DUMMY_TEXT = "dummy reply text";
const DUMMY_ROOM_ID = "2002";

interface DbScript {
  /** chatwork_messages 逆引き SELECT が返す行。 */
  messageSelect: Array<{ sourceId: bigint; chatworkRoomId: string }>;
  /** chatwork_rooms SELECT が返す行。 */
  roomSelect: Array<{ enabled: boolean }>;
  /** outbound_messages insert ... returning() が返す行（空 = 既存/再送）。 */
  insertReturning: Array<{ id: bigint }>;
}

interface CapturedDb {
  insertValues: unknown[];
  updateSets: unknown[];
  deleteCount: number;
  callOrder: string[];
}

function makeDbMock(script: DbScript): { db: { db: unknown }; captured: CapturedDb } {
  const captured: CapturedDb = {
    insertValues: [],
    updateSets: [],
    deleteCount: 0,
    callOrder: [],
  };

  const db = {
    select(_columns: unknown) {
      return {
        from(table: unknown) {
          captured.callOrder.push("select");
          let rows: unknown[];
          if (table === chatworkMessages) {
            rows = script.messageSelect;
          } else if (table === chatworkRooms) {
            rows = script.roomSelect;
          } else {
            rows = [];
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
    insert(_table: unknown) {
      captured.callOrder.push("insert");
      return {
        values(values: unknown) {
          captured.insertValues.push(values);
          return {
            onConflictDoNothing(_opts: unknown) {
              return {
                returning(_cols: unknown) {
                  return Promise.resolve(script.insertReturning);
                },
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      captured.callOrder.push("update");
      return {
        set(values: unknown) {
          captured.updateSets.push(values);
          return {
            where(_cond: unknown) {
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    delete(_table: unknown) {
      captured.callOrder.push("delete");
      captured.deleteCount += 1;
      return {
        where(_cond: unknown) {
          return Promise.resolve(undefined);
        },
      };
    },
  };

  return { db: { db }, captured };
}

interface MakeDepsResult {
  deps: HandleSlackReplyDeps;
  captured: CapturedDb;
  postMessage: ReturnType<typeof vi.fn>;
  logs: { level: string; payload: Record<string, unknown>; message: string }[];
}

function makeDeps(opts: {
  script: DbScript;
  postMessage?: (...args: unknown[]) => Promise<{ ts: ReturnType<typeof toSlackTs> }>;
}): MakeDepsResult {
  const { db, captured } = makeDbMock(opts.script);
  const logs: MakeDepsResult["logs"] = [];
  const record = (level: string) => (payload: Record<string, unknown>, message: string) =>
    logs.push({ level, payload, message });

  const postMessage = vi.fn(
    opts.postMessage ?? (async () => ({ ts: toSlackTs(DUMMY_CONFIRM_TS) })),
  );

  const deps: HandleSlackReplyDeps = {
    db: db as unknown as DbClient,
    chatworkClient: {} as unknown as ChatworkClient,
    slackClient: { postMessage } as unknown as SlackClient,
    logger: {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: vi.fn(),
    } as unknown as HandleSlackReplyDeps["logger"],
  };

  return { deps, captured, postMessage, logs };
}

function makeEvent(overrides: Partial<SlackReplyEvent> = {}): SlackReplyEvent {
  return {
    type: "message",
    user: DUMMY_USER,
    text: DUMMY_TEXT,
    ts: DUMMY_TS,
    thread_ts: DUMMY_THREAD_TS,
    channel: DUMMY_CHANNEL,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSlackReply", () => {
  it("creates a pending outbound (with slack_user_id), posts confirm, and records confirm ts", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: {
        messageSelect: [{ sourceId: 5n, chatworkRoomId: DUMMY_ROOM_ID }],
        roomSelect: [{ enabled: true }],
        insertReturning: [{ id: 42n }],
      },
    });

    await handleSlackReply(makeEvent(), deps);

    // pending insert に slack_user_id / body が含まれる。
    expect(captured.insertValues).toHaveLength(1);
    const inserted = captured.insertValues[0] as Record<string, unknown>;
    expect(inserted.slackUserId).toBe(DUMMY_USER);
    expect(inserted.slackChannelId).toBe(DUMMY_CHANNEL);
    expect(inserted.slackReplyTs).toBe(DUMMY_TS);
    expect(inserted.slackThreadTs).toBe(DUMMY_THREAD_TS);
    expect(inserted.body).toBe(DUMMY_TEXT);

    // 確認投稿（threadTs 付き・blocks 付き）。
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, message, options] = postMessage.mock.calls[0] as [
      unknown,
      { blocks?: unknown },
      { threadTs?: unknown },
    ];
    expect(message.blocks).toBeDefined();
    expect(options.threadTs).toBe(DUMMY_THREAD_TS);

    // confirm ts を update で記録。
    expect(captured.updateSets).toHaveLength(1);
    expect((captured.updateSets[0] as Record<string, unknown>).slackConfirmTs).toBe(
      DUMMY_CONFIRM_TS,
    );
    expect(captured.deleteCount).toBe(0);
  });

  it("is a no-op when text is empty after trim", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent({ text: "   " }), deps);

    expect(captured.callOrder).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when thread_ts is missing", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent({ thread_ts: undefined }), deps);

    expect(captured.callOrder).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when bot_id is present", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent({ bot_id: "B0DUMMYBOT" }), deps);

    expect(captured.callOrder).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when subtype is present", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent({ subtype: "message_changed" }), deps);

    expect(captured.callOrder).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when the thread is not a forwarded message (no reverse lookup)", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent(), deps);

    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.insertValues).toHaveLength(0);
  });

  it("is a no-op when the room is disabled", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: {
        messageSelect: [{ sourceId: 5n, chatworkRoomId: DUMMY_ROOM_ID }],
        roomSelect: [{ enabled: false }],
        insertReturning: [],
      },
    });

    await handleSlackReply(makeEvent(), deps);

    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.insertValues).toHaveLength(0);
  });

  it("does not double-post when the reply is a resend (onConflict returns empty)", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: {
        messageSelect: [{ sourceId: 5n, chatworkRoomId: DUMMY_ROOM_ID }],
        roomSelect: [{ enabled: true }],
        insertReturning: [], // 既存 = 再送
      },
    });

    await handleSlackReply(makeEvent(), deps);

    expect(captured.insertValues).toHaveLength(1); // insert は試みる
    expect(postMessage).not.toHaveBeenCalled(); // が確認は投稿しない
    expect(captured.updateSets).toHaveLength(0);
  });

  it("deletes the pending row when the confirm post fails", async () => {
    const { deps, captured } = makeDeps({
      script: {
        messageSelect: [{ sourceId: 5n, chatworkRoomId: DUMMY_ROOM_ID }],
        roomSelect: [{ enabled: true }],
        insertReturning: [{ id: 42n }],
      },
      postMessage: async () => {
        throw new Error("slack down");
      },
    });

    await handleSlackReply(makeEvent(), deps);

    expect(captured.deleteCount).toBe(1);
    expect(captured.updateSets).toHaveLength(0); // confirm ts は記録しない
  });

  it("is a no-op when text is undefined (absent)", async () => {
    // text プロパティ自体が無いイベント。`event.text?.trim() ?? ""` の undefined 側分岐。
    const { deps, captured, postMessage } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });

    await handleSlackReply(makeEvent({ text: undefined }), deps);

    expect(captured.callOrder).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("never throws and logs cleanup when deleting the pending row itself fails", async () => {
    // 確認投稿失敗後の best-effort delete も落ちた場合: never-throw で握りログのみ。
    const { deps, logs } = makeDeps({
      script: {
        messageSelect: [{ sourceId: 5n, chatworkRoomId: DUMMY_ROOM_ID }],
        roomSelect: [{ enabled: true }],
        insertReturning: [{ id: 42n }],
      },
      postMessage: async () => {
        throw new Error("slack down");
      },
    });
    (deps.db as unknown as { db: { delete: unknown } }).db.delete = () => {
      throw new Error("delete failed");
    };

    await expect(handleSlackReply(makeEvent(), deps)).resolves.toBeUndefined();

    // delete 失敗は cleanup op で握りログ（unexpected には昇格しない）。
    const cleanup = logs.find((l) => l.payload.op === "slack.reply.cleanup");
    expect(cleanup).toBeDefined();
    expect(cleanup?.level).toBe("error");
    const unexpected = logs.find((l) => l.payload.op === "slack.reply.unexpected");
    expect(unexpected).toBeUndefined();
  });

  it("never throws and logs unexpected when the reverse lookup throws", async () => {
    // 判定通過後に想定外の例外（DB 接続断等）でも never-throw でログのみ（ルートは 200 前提）。
    const { deps, logs } = makeDeps({
      script: { messageSelect: [], roomSelect: [], insertReturning: [] },
    });
    (deps.db as unknown as { db: { select: unknown } }).db.select = () => {
      throw new Error("db connection lost");
    };

    await expect(handleSlackReply(makeEvent(), deps)).resolves.toBeUndefined();

    const unexpected = logs.find((l) => l.payload.op === "slack.reply.unexpected");
    expect(unexpected).toBeDefined();
    expect(unexpected?.level).toBe("error");
  });
});
