import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatworkClient } from "@/adapters/chatwork/client";
import { ChatworkApiError } from "@/adapters/chatwork/client";
import type { SlackClient } from "@/adapters/slack/client";
import { cancelOutbound, type SendOutboundDeps, sendOutbound } from "@/app/services/send-outbound";
import type { DbClient } from "@/db/client";
import { deliveryAttempts } from "@/db/schema";

// DUMMY 値（実 channel/ts/user・実本文・実 message id を含まない / CON-003）。
const DUMMY_CHANNEL = "C0DUMMYCHAN";
const DUMMY_CONFIRM_TS = "1700000000.000200";
const DUMMY_USER = "U0DUMMYUSER";
const DUMMY_OTHER_USER = "U0DUMMYOTHER";
const DUMMY_ROOM_ID = "2002";
const DUMMY_BODY = "dummy outbound body";
const DUMMY_CW_MESSAGE_ID = "msg-9999";
const OUTBOUND_ID = "42";

interface OutboundRow {
  id: bigint;
  status: string;
  slackChannelId: string;
  slackConfirmTs: string | null;
  slackUserId: string | null;
}

interface DbScript {
  /** id SELECT が返す行（無 = not found）。 */
  selectRow: OutboundRow | null;
  /** claim/cancel の条件付き UPDATE ... returning が返す行（空 = claim 不成立）。 */
  updateReturning: Array<Record<string, unknown>>;
  /** true のとき transaction を reject する（確定 tx 失敗の再現）。 */
  transactionRejects?: boolean;
}

interface TxOp {
  kind: "update" | "insert";
  table: unknown;
  values: unknown;
}

interface CapturedDb {
  /** トランザクション内で行われた操作（原子性検証用）。 */
  txOps: TxOp[];
  /** 条件付き UPDATE（claim/cancel）の set 値。 */
  conditionalUpdateSets: unknown[];
  /** transaction が呼ばれた回数。 */
  transactionCount: number;
}

function makeDbMock(script: DbScript): { db: { db: unknown }; captured: CapturedDb } {
  const captured: CapturedDb = { txOps: [], conditionalUpdateSets: [], transactionCount: 0 };

  const tx = {
    update(table: unknown) {
      return {
        set(values: unknown) {
          captured.txOps.push({ kind: "update", table, values });
          return { where: (_c: unknown) => Promise.resolve(undefined) };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(values: unknown) {
          captured.txOps.push({ kind: "insert", table, values });
          return Promise.resolve(undefined);
        },
      };
    },
  };

  const db = {
    select(_columns: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  return Promise.resolve(script.selectRow === null ? [] : [script.selectRow]);
                },
              };
            },
          };
        },
      };
    },
    // claim / cancel の条件付き UPDATE ... returning。
    update(_table: unknown) {
      return {
        set(values: unknown) {
          captured.conditionalUpdateSets.push(values);
          return {
            where(_cond: unknown) {
              return {
                returning(_cols: unknown) {
                  return Promise.resolve(script.updateReturning);
                },
              };
            },
          };
        },
      };
    },
    transaction(cb: (tx: unknown) => Promise<unknown>) {
      captured.transactionCount += 1;
      if (script.transactionRejects) {
        return Promise.reject(new Error("tx failed"));
      }
      return Promise.resolve(cb(tx));
    },
  };

  return { db: { db }, captured };
}

interface MakeDepsResult {
  deps: SendOutboundDeps;
  captured: CapturedDb;
  postMessage: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  script: DbScript;
  allowedReplyUserIds?: readonly string[];
  postMessage?: (...args: unknown[]) => Promise<{ chatworkMessageId: string }>;
  updateMessage?: (...args: unknown[]) => Promise<void>;
}): MakeDepsResult {
  const { db, captured } = makeDbMock(opts.script);

  const postMessage = vi.fn(
    opts.postMessage ?? (async () => ({ chatworkMessageId: DUMMY_CW_MESSAGE_ID })),
  );
  const updateMessage = vi.fn(opts.updateMessage ?? (async () => undefined));

  const deps: SendOutboundDeps = {
    db: db as unknown as DbClient,
    chatworkClient: { postMessage } as unknown as ChatworkClient,
    slackClient: { updateMessage } as unknown as SlackClient,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as SendOutboundDeps["logger"],
    allowedReplyUserIds: opts.allowedReplyUserIds ?? [],
  };

  return { deps, captured, postMessage, updateMessage };
}

function pendingRow(overrides: Partial<OutboundRow> = {}): OutboundRow {
  return {
    id: 42n,
    status: "pending",
    slackChannelId: DUMMY_CHANNEL,
    slackConfirmTs: DUMMY_CONFIRM_TS,
    slackUserId: DUMMY_USER,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendOutbound", () => {
  it("claims, posts to chatwork, records sent + delivery success in one tx, updates confirm", async () => {
    const { deps, captured, postMessage, updateMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    // claim（status='sending'）。
    expect(captured.conditionalUpdateSets).toHaveLength(1);
    expect((captured.conditionalUpdateSets[0] as Record<string, unknown>).status).toBe("sending");
    // chatwork 投稿。
    expect(postMessage).toHaveBeenCalledTimes(1);
    // 原子性: update(sent) と insert(delivery success) が同一 tx。
    expect(captured.transactionCount).toBe(1);
    expect(captured.txOps).toHaveLength(2);
    const updateOp = captured.txOps.find((o) => o.kind === "update");
    const insertOp = captured.txOps.find((o) => o.kind === "insert");
    expect((updateOp?.values as Record<string, unknown>).status).toBe("sent");
    expect((updateOp?.values as Record<string, unknown>).chatworkMessageId).toBe(
      DUMMY_CW_MESSAGE_ID,
    );
    expect(insertOp?.table).toBe(deliveryAttempts);
    expect((insertOp?.values as Record<string, unknown>).result).toBe("success");
    // 確認メッセージ更新。
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it("records failed + delivery failure in one tx and updates confirm on chatwork error", async () => {
    const { deps, captured, postMessage, updateMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
      postMessage: async () => {
        throw new ChatworkApiError("chatwork.postMessage", 429);
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(captured.transactionCount).toBe(1);
    const updateOp = captured.txOps.find((o) => o.kind === "update");
    const insertOp = captured.txOps.find((o) => o.kind === "insert");
    expect((updateOp?.values as Record<string, unknown>).status).toBe("failed");
    // error_message は識別子要約のみ（本文非含有）。
    const errorMessage = (updateOp?.values as Record<string, unknown>).errorMessage as string;
    expect(errorMessage).toContain("chatwork.postMessage");
    expect(errorMessage).not.toContain(DUMMY_BODY);
    expect((insertOp?.values as Record<string, unknown>).result).toBe("failure");
    expect((insertOp?.values as Record<string, unknown>).httpStatus).toBe(429);
    expect(updateMessage).toHaveBeenCalledTimes(1);
  });

  it("does not post to chatwork when claim returns 0 rows (double press)", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: {
        selectRow: pendingRow({ status: "sending" }),
        updateReturning: [], // claim 不成立
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.transactionCount).toBe(0);
  });

  it("ignores an unauthorized press without touching the shared confirm message, claim, or chatwork", async () => {
    const { deps, captured, postMessage, updateMessage } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_OTHER_USER }, deps);

    // 共有確認メッセージを更新しない（他人 UI 破壊防止）。
    expect(updateMessage).not.toHaveBeenCalled();
    // claim も Chatwork 投稿も tx もしない（outbound 不変）。
    expect(captured.conditionalUpdateSets).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.transactionCount).toBe(0);
    // 識別子のみの forbidden ログが出る（本文・表示名は出さない）。
    const forbiddenLog = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.forbidden",
    );
    expect(forbiddenLog).toBeDefined();
    expect((forbiddenLog?.[0] as Record<string, unknown>).pressUserId).toBe(DUMMY_OTHER_USER);
    expect((forbiddenLog?.[0] as Record<string, unknown>).outboundId).toBe(42n);
  });

  it("allows a non-author press when in allowlist", async () => {
    const { deps, postMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
      allowedReplyUserIds: [DUMMY_OTHER_USER],
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_OTHER_USER }, deps);

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("logs commit_failed and does not double-post when the success tx fails", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
        transactionRejects: true,
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(captured.transactionCount).toBe(1);
    const errorLog = (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.commit_failed",
    );
    expect(errorLog).toBeDefined();
  });

  it("keeps DB state authoritative when chat.update fails", async () => {
    const { deps, captured } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
      updateMessage: async () => {
        throw new Error("slack update down");
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    // sent tx は確定している（chat.update 失敗でも握る）。
    expect(captured.transactionCount).toBe(1);
    const updateOp = captured.txOps.find((o) => o.kind === "update");
    expect((updateOp?.values as Record<string, unknown>).status).toBe("sent");
  });

  it("is a no-op when the outbound is not found", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { selectRow: null, updateReturning: [] },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.conditionalUpdateSets).toHaveLength(0);
  });

  it("is a no-op for an invalid (non-numeric) outbound id", async () => {
    const { deps, captured, postMessage } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });

    await sendOutbound({ outboundId: "not-a-number", pressUserId: DUMMY_USER }, deps);

    expect(postMessage).not.toHaveBeenCalled();
    expect(captured.conditionalUpdateSets).toHaveLength(0);
  });

  it("logs commit_failed (not double-posting) when the failure tx itself fails", async () => {
    const { deps, captured, postMessage, updateMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
        transactionRejects: true,
      },
      postMessage: async () => {
        throw new ChatworkApiError("chatwork.postMessage", 500);
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(captured.transactionCount).toBe(1);
    // 失敗確定 tx も落ちたため確認更新はしない（DB 真実が確定していない）。
    expect(updateMessage).not.toHaveBeenCalled();
    const errorLog = (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.commit_failed",
    );
    expect(errorLog).toBeDefined();
  });

  it("skips chat.update when the confirm ts is missing", async () => {
    const { deps, captured, updateMessage } = makeDeps({
      script: {
        selectRow: pendingRow({ slackConfirmTs: null }),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    // sent tx は確定するが、confirm ts が無いため chat.update はスキップ。
    expect(captured.transactionCount).toBe(1);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("records failure with n/a status and generic op when a non-ChatworkApiError is thrown", async () => {
    // postMessage が ChatworkApiError 以外（ネットワーク例外等）を投げた場合の分岐。
    // status は undefined → "n/a"、op は "chatwork.postMessage" にフォールバックする（NFR-002）。
    const { deps, captured, postMessage, updateMessage } = makeDeps({
      script: {
        selectRow: pendingRow(),
        updateReturning: [{ chatworkRoomId: DUMMY_ROOM_ID, body: DUMMY_BODY }],
      },
      postMessage: async () => {
        throw new Error("network down");
      },
    });

    await sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(captured.transactionCount).toBe(1);
    const updateOp = captured.txOps.find((o) => o.kind === "update");
    const insertOp = captured.txOps.find((o) => o.kind === "insert");
    expect((updateOp?.values as Record<string, unknown>).status).toBe("failed");
    const errorMessage = (updateOp?.values as Record<string, unknown>).errorMessage as string;
    // 識別子要約のみ: op フォールバック + status=n/a（本文・例外メッセージ非含有 / NFR-002）。
    expect(errorMessage).toBe("chatwork.postMessage status=n/a");
    expect(errorMessage).not.toContain("network down");
    expect(errorMessage).not.toContain(DUMMY_BODY);
    // delivery_attempts の httpStatus は null、errorCode はフォールバック op。
    expect((insertOp?.values as Record<string, unknown>).httpStatus).toBeNull();
    expect((insertOp?.values as Record<string, unknown>).errorCode).toBe("chatwork.postMessage");
    expect((insertOp?.values as Record<string, unknown>).result).toBe("failure");
    // 失敗確定後に確認メッセージは ❌ に更新される。
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const message = updateMessage.mock.calls[0]?.[2] as { text: string };
    expect(message.text).toContain("失敗");
  });

  it("never throws and logs unexpected when the select itself throws", async () => {
    // 想定外の例外（DB 接続断等）でも never-throw でログのみ（ルートは 200 前提）。
    const { deps } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });
    (deps.db as unknown as { db: { select: unknown } }).db.select = () => {
      throw new Error("db connection lost");
    };

    await expect(
      sendOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps),
    ).resolves.toBeUndefined();

    const errorLog = (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.unexpected",
    );
    expect(errorLog).toBeDefined();
    // 例外メッセージ（生エラー本文）はログの op に含めない。
    expect((errorLog?.[0] as { op: string }).op).toBe("slack.outbound.unexpected");
  });
});

describe("cancelOutbound", () => {
  it("cancels a pending outbound and updates the confirm message", async () => {
    const { deps, captured, updateMessage } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [{ id: 42n }] },
    });

    await cancelOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect((captured.conditionalUpdateSets[0] as Record<string, unknown>).status).toBe("cancelled");
    expect(updateMessage).toHaveBeenCalledTimes(1);
    const message = updateMessage.mock.calls[0]?.[2] as { text: string };
    expect(message.text).toContain("キャンセル");
  });

  it("is a no-op when the outbound is not pending (cancel returns 0 rows)", async () => {
    const { deps, updateMessage } = makeDeps({
      script: { selectRow: pendingRow({ status: "sent" }), updateReturning: [] },
    });

    await cancelOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("ignores an unauthorized cancel without touching the shared confirm message or outbound", async () => {
    const { deps, captured, updateMessage } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });

    await cancelOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_OTHER_USER }, deps);

    // 共有確認メッセージを更新せず、キャンセル UPDATE もしない（outbound 不変）。
    expect(updateMessage).not.toHaveBeenCalled();
    expect(captured.conditionalUpdateSets).toHaveLength(0);
    // 識別子のみの forbidden ログが出る。
    const forbiddenLog = (deps.logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.forbidden",
    );
    expect(forbiddenLog).toBeDefined();
    expect((forbiddenLog?.[0] as Record<string, unknown>).pressUserId).toBe(DUMMY_OTHER_USER);
  });

  it("is a no-op for an invalid (non-numeric) outbound id", async () => {
    const { deps, captured, updateMessage } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });

    await cancelOutbound({ outboundId: "not-a-number", pressUserId: DUMMY_USER }, deps);

    expect(captured.conditionalUpdateSets).toHaveLength(0);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("is a no-op when the outbound is not found", async () => {
    const { deps, captured, updateMessage } = makeDeps({
      script: { selectRow: null, updateReturning: [] },
    });

    await cancelOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps);

    expect(captured.conditionalUpdateSets).toHaveLength(0);
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it("never throws and logs unexpected when the select itself throws", async () => {
    const { deps } = makeDeps({
      script: { selectRow: pendingRow(), updateReturning: [] },
    });
    (deps.db as unknown as { db: { select: unknown } }).db.select = () => {
      throw new Error("db connection lost");
    };

    await expect(
      cancelOutbound({ outboundId: OUTBOUND_ID, pressUserId: DUMMY_USER }, deps),
    ).resolves.toBeUndefined();

    const errorLog = (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { op?: string }).op === "slack.outbound.unexpected",
    );
    expect(errorLog).toBeDefined();
  });
});
