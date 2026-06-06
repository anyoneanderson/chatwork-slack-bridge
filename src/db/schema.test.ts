import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  chatworkMessageAttachments,
  chatworkMessages,
  chatworkRoomMembers,
  chatworkRooms,
  DELIVERY_RESULT,
  deliveryAttempts,
  MESSAGE_STATUS,
  OUTBOUND_STATUS,
  outboundMessages,
  ROOM_TYPES,
} from "@/db/schema";

/**
 * TS 側の union と DB の CHECK 制約集合のズレを検出する軽量テスト。
 * 実 PostgreSQL での migration / 保存は compose 上で別途検証済みのため（[MAY] 統合テスト）、
 * ここでは DB を起動せず、設計書 §5.1 の CHECK 値セットと一致することのみを確認する。
 */
describe("schema unions match design CHECK sets", () => {
  it("ROOM_TYPES matches the chatwork_rooms.room_type CHECK set", () => {
    // design.md §5.1: check (room_type in ('group','direct','my'))
    const expected = ["group", "direct", "my"] as const;
    expect([...ROOM_TYPES]).toEqual([...expected]);
    // 重複なし・順序ともに固定（型と制約のズレを防ぐ）。
    expect(new Set(ROOM_TYPES).size).toBe(ROOM_TYPES.length);
  });

  it("MESSAGE_STATUS matches the chatwork_messages.status CHECK set", () => {
    // design.md §5.1: check (status in ('open','done'))
    const expected = ["open", "done"] as const;
    expect([...MESSAGE_STATUS]).toEqual([...expected]);
    expect(new Set(MESSAGE_STATUS).size).toBe(MESSAGE_STATUS.length);
  });

  it("OUTBOUND_STATUS matches the outbound_messages.status CHECK set", () => {
    // slack-reply design.md §5.1: check (status in ('pending','sending','sent','cancelled','failed'))
    const expected = ["pending", "sending", "sent", "cancelled", "failed"] as const;
    expect([...OUTBOUND_STATUS]).toEqual([...expected]);
    expect(new Set(OUTBOUND_STATUS).size).toBe(OUTBOUND_STATUS.length);
  });

  it("DELIVERY_RESULT matches the delivery_attempts.result CHECK set", () => {
    // slack-reply design.md §5.2: check (result in ('success','failure'))
    const expected = ["success", "failure"] as const;
    expect([...DELIVERY_RESULT]).toEqual([...expected]);
    expect(new Set(DELIVERY_RESULT).size).toBe(DELIVERY_RESULT.length);
  });
});

/**
 * `chatwork_messages` への逆引き partial unique index の検証（slack-reply design §5.2b / REQ-003）。
 *
 * slack-reply はスレッド親 ts から `(slack_channel_id, slack_ts)` で返信先ルームを逆引きする。
 * 既存テーブルへの index 追加のみ（列追加・型変更なし）で、両カラム non-null（forwarding 投稿済み）
 * の行に限った partial unique index により、`limit 1` ではなくデータ制約で一意逆引きを担保する。
 */
describe("chatwork_messages reverse-lookup index (slack-reply design §5.2b)", () => {
  const cfg = getTableConfig(chatworkMessages);

  it("has a partial unique index on (slack_channel_id, slack_ts) with a non-null WHERE", () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === "chatwork_messages_slack_channel_ts_unique",
    );
    if (!idx) throw new Error("reverse-lookup index not found");
    expect(idx.config.unique).toBe(true);
    expect(idx.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "slack_channel_id",
      "slack_ts",
    ]);
    // partial index: 両カラム non-null の行のみを対象にする WHERE 句を持つ（複数 null を許容）。
    expect(idx.config.where).toBeDefined();
  });
});

/**
 * `outbound_messages` の構造検証（slack-reply design §5.1 / REQ-005 / coding-rules `[MUST]`）。
 *
 * 既存テストと同じく DB は起動せず、Drizzle の `getTableConfig` で列・FK・index・unique・CHECK を
 * TS 側から検査する。送信ライフサイクルの設計（identity PK / timestamptz / FK 明示 index /
 * 冪等 unique / status CHECK）が forwarding 系スキーマ規約と揃っていることを担保する。
 */
describe("outbound_messages schema (slack-reply design §5.1)", () => {
  const cfg = getTableConfig(outboundMessages);
  const col = (name: string) => {
    const c = cfg.columns.find((x) => x.name === name);
    if (!c) throw new Error(`column not found: ${name}`);
    return c;
  };

  it("uses the expected table name", () => {
    expect(cfg.name).toBe("outbound_messages");
  });

  it("has bigint identity primary key on id", () => {
    const id = col("id");
    expect(id.getSQLType()).toBe("bigint");
    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);
    expect((id as unknown as { generatedIdentity?: { type: string } }).generatedIdentity).toEqual({
      type: "always",
    });
  });

  it("has NOT NULL text columns for chatwork_room_id / slack_channel_id / slack_thread_ts / slack_reply_ts / body", () => {
    for (const name of [
      "chatwork_room_id",
      "slack_channel_id",
      "slack_thread_ts",
      "slack_reply_ts",
      "body",
    ]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("text");
      expect(c.notNull).toBe(true);
    }
  });

  it("has a nullable bigint source_chatwork_message_id (FK, row-deletion tolerant)", () => {
    const c = col("source_chatwork_message_id");
    expect(c.getSQLType()).toBe("bigint");
    expect(c.notNull).toBe(false);
  });

  it("has nullable text columns for slack_confirm_ts / slack_user_id / chatwork_message_id / error_message", () => {
    for (const name of [
      "slack_confirm_ts",
      "slack_user_id",
      "chatwork_message_id",
      "error_message",
    ]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("text");
      expect(c.notNull).toBe(false);
    }
  });

  it("has status text column defaulting to pending", () => {
    const c = col("status");
    expect(c.getSQLType()).toBe("text");
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe("pending");
  });

  it("has NOT NULL timestamptz created_at / updated_at with defaults", () => {
    for (const name of ["created_at", "updated_at"]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("timestamp with time zone");
      expect(c.notNull).toBe(true);
      expect(c.hasDefault).toBe(true);
    }
  });

  it("has unique(slack_channel_id, slack_reply_ts) idempotency key (NFR-004)", () => {
    const uniques = cfg.uniqueConstraints.map((u) => ({
      name: u.name,
      columns: u.columns.map((c) => c.name),
    }));
    expect(uniques).toContainEqual({
      name: "outbound_messages_channel_reply_unique",
      columns: ["slack_channel_id", "slack_reply_ts"],
    });
  });

  it("has explicit indexes on FK columns and status (coding-rules [MUST])", () => {
    const indexes = cfg.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((c) => (c as { name: string }).name),
    }));
    expect(indexes).toContainEqual({
      name: "outbound_messages_room_idx",
      columns: ["chatwork_room_id"],
    });
    expect(indexes).toContainEqual({
      name: "outbound_messages_source_idx",
      columns: ["source_chatwork_message_id"],
    });
    expect(indexes).toContainEqual({
      name: "outbound_messages_status_idx",
      columns: ["status"],
    });
  });

  it("has FK chatwork_room_id -> chatwork_rooms.chatwork_room_id and source_chatwork_message_id -> chatwork_messages.id", () => {
    const refs = cfg.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        columns: ref.columns.map((c) => c.name),
        foreignColumns: ref.foreignColumns.map((c) => c.name),
        foreignTable: getTableConfig(ref.foreignTable).name,
      };
    });
    expect(refs).toContainEqual({
      columns: ["chatwork_room_id"],
      foreignColumns: ["chatwork_room_id"],
      foreignTable: getTableConfig(chatworkRooms).name,
    });
    expect(refs).toContainEqual({
      columns: ["source_chatwork_message_id"],
      foreignColumns: ["id"],
      foreignTable: getTableConfig(chatworkMessages).name,
    });
  });

  it("has the status CHECK matching OUTBOUND_STATUS (design §5.1)", () => {
    const checkNames = cfg.checks.map((c) => c.name);
    expect(checkNames).toContain("outbound_messages_status_check");
  });
});

/**
 * `delivery_attempts` の構造検証（slack-reply design §5.2 / coding-rules `[MUST]` 外部送信失敗の記録）。
 *
 * 既存テストと同じく DB は起動せず、`getTableConfig` で列・FK・index・CHECK を検査する。
 * 配送試行ログが forwarding 系規約（identity PK / timestamptz / FK 明示 index）と揃い、
 * `http_status` が integer であることを明示的に検証する。
 */
describe("delivery_attempts schema (slack-reply design §5.2)", () => {
  const cfg = getTableConfig(deliveryAttempts);
  const col = (name: string) => {
    const c = cfg.columns.find((x) => x.name === name);
    if (!c) throw new Error(`column not found: ${name}`);
    return c;
  };

  it("uses the expected table name", () => {
    expect(cfg.name).toBe("delivery_attempts");
  });

  it("has bigint identity primary key on id", () => {
    const id = col("id");
    expect(id.getSQLType()).toBe("bigint");
    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);
    expect((id as unknown as { generatedIdentity?: { type: string } }).generatedIdentity).toEqual({
      type: "always",
    });
  });

  it("has a NOT NULL bigint FK column outbound_message_id", () => {
    const c = col("outbound_message_id");
    expect(c.getSQLType()).toBe("bigint");
    expect(c.notNull).toBe(true);
  });

  it("has NOT NULL text result column", () => {
    const c = col("result");
    expect(c.getSQLType()).toBe("text");
    expect(c.notNull).toBe(true);
  });

  it("has a nullable integer http_status column (small int / design §5.2)", () => {
    const c = col("http_status");
    expect(c.getSQLType()).toBe("integer");
    expect(c.notNull).toBe(false);
  });

  it("has a nullable text error_code column", () => {
    const c = col("error_code");
    expect(c.getSQLType()).toBe("text");
    expect(c.notNull).toBe(false);
  });

  it("has NOT NULL timestamptz attempted_at with default", () => {
    const c = col("attempted_at");
    expect(c.getSQLType()).toBe("timestamp with time zone");
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
  });

  it("has explicit index on outbound_message_id (FK index / coding-rules [MUST])", () => {
    const indexes = cfg.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((c) => (c as { name: string }).name),
    }));
    expect(indexes).toContainEqual({
      name: "delivery_attempts_outbound_idx",
      columns: ["outbound_message_id"],
    });
  });

  it("has FK outbound_message_id -> outbound_messages.id (bigint internal PK)", () => {
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error("foreign key missing");
    const ref = fk.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["outbound_message_id"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(ref.foreignColumns.map((c) => c.getSQLType())).toEqual(["bigint"]);
    expect(getTableConfig(ref.foreignTable).name).toBe(getTableConfig(outboundMessages).name);
  });

  it("has the result CHECK matching DELIVERY_RESULT (design §5.2)", () => {
    const checkNames = cfg.checks.map((c) => c.name);
    expect(checkNames).toContain("delivery_attempts_result_check");
  });
});

/**
 * `chatwork_room_members` の構造検証（sender-name design §3.1 / coding-rules `[MUST]`）。
 *
 * 既存テストと同じく DB は起動せず、Drizzle の `getTableConfig` で
 * 列・FK・index・unique を TS 側から検査する。表示名キャッシュの設計が
 * forwarding スキーマ規約（identity PK / timestamptz / 明示 index / unique）と
 * 揃っていることを担保する。
 */
describe("chatwork_room_members schema (sender-name design §3.1)", () => {
  const cfg = getTableConfig(chatworkRoomMembers);
  const col = (name: string) => {
    const c = cfg.columns.find((x) => x.name === name);
    if (!c) throw new Error(`column not found: ${name}`);
    return c;
  };

  it("uses the expected table name", () => {
    expect(cfg.name).toBe("chatwork_room_members");
  });

  it("has bigint identity primary key on id", () => {
    const id = col("id");
    expect(id.getSQLType()).toBe("bigint");
    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);
    // generated always as identity（design §3.1）
    expect((id as unknown as { generatedIdentity?: { type: string } }).generatedIdentity).toEqual({
      type: "always",
    });
  });

  it("has NOT NULL text columns for chatwork_room_id / chatwork_account_id / name", () => {
    for (const name of ["chatwork_room_id", "chatwork_account_id", "name"]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("text");
      expect(c.notNull).toBe(true);
      expect(c.hasDefault).toBe(false);
    }
  });

  it("has NOT NULL timestamptz created_at / updated_at with defaults", () => {
    for (const name of ["created_at", "updated_at"]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("timestamp with time zone");
      expect(c.notNull).toBe(true);
      expect(c.hasDefault).toBe(true);
    }
  });

  it("has unique(chatwork_room_id, chatwork_account_id) for idempotent upsert (REQ-003)", () => {
    const uniques = cfg.uniqueConstraints.map((u) => ({
      name: u.name,
      columns: u.columns.map((c) => c.name),
    }));
    expect(uniques).toContainEqual({
      name: "chatwork_room_members_room_account_unique",
      columns: ["chatwork_room_id", "chatwork_account_id"],
    });
  });

  it("has explicit index on chatwork_room_id (FK index / coding-rules [MUST])", () => {
    const indexes = cfg.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((c) => (c as { name: string }).name),
    }));
    expect(indexes).toContainEqual({
      name: "chatwork_room_members_room_idx",
      columns: ["chatwork_room_id"],
    });
  });

  it("has FK chatwork_room_id -> chatwork_rooms.chatwork_room_id", () => {
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error("foreign key missing");
    const ref = fk.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["chatwork_room_id"]);
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["chatwork_room_id"]);
    expect(getTableConfig(ref.foreignTable).name).toBe(getTableConfig(chatworkRooms).name);
  });

  it("has no CHECK constraints (no enum-like columns in this table)", () => {
    expect(cfg.checks).toEqual([]);
  });
});

/**
 * `chatwork_message_attachments` の構造検証（attachment-mirror design §3.1 / REQ-007 / coding-rules `[MUST]`）。
 *
 * 既存テストと同じく DB は起動せず、Drizzle の `getTableConfig` で列・FK・index・unique を
 * TS 側から検査する。forwarding / sender-name のスキーマ規約（identity PK / timestamptz /
 * FK 明示 index / unique）と揃っていることを担保する。
 *
 * 既存テーブルとの**差分**: FK 先が `chatwork_messages.id`（bigint の内部 PK）であり、
 * 他テーブルのような text の外部 ID 列ではない。FK 列自身も bigint である点を明示的に検証する
 * （design §3.1: 単一カラム FK で単純・CASCADE 拡張に強い）。
 */
describe("chatwork_message_attachments schema (attachment-mirror design §3.1)", () => {
  const cfg = getTableConfig(chatworkMessageAttachments);
  const col = (name: string) => {
    const c = cfg.columns.find((x) => x.name === name);
    if (!c) throw new Error(`column not found: ${name}`);
    return c;
  };

  it("uses the expected table name", () => {
    expect(cfg.name).toBe("chatwork_message_attachments");
  });

  it("has bigint identity primary key on id", () => {
    const id = col("id");
    expect(id.getSQLType()).toBe("bigint");
    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);
    // generated always as identity（design §3.1）
    expect((id as unknown as { generatedIdentity?: { type: string } }).generatedIdentity).toEqual({
      type: "always",
    });
  });

  it("has a NOT NULL bigint FK column chatwork_message_id (references the internal PK, not a text external id)", () => {
    const c = col("chatwork_message_id");
    // 既存テーブルとの差分: FK 列が text ではなく bigint（chatwork_messages.id 内部 PK 参照）。
    expect(c.getSQLType()).toBe("bigint");
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(false);
  });

  it("has NOT NULL text columns for chatwork_file_id / slack_file_id / slack_channel_id / slack_thread_ts", () => {
    for (const name of [
      "chatwork_file_id",
      "slack_file_id",
      "slack_channel_id",
      "slack_thread_ts",
    ]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("text");
      expect(c.notNull).toBe(true);
      expect(c.hasDefault).toBe(false);
    }
  });

  it("has NOT NULL timestamptz created_at / updated_at with defaults", () => {
    for (const name of ["created_at", "updated_at"]) {
      const c = col(name);
      expect(c.getSQLType()).toBe("timestamp with time zone");
      expect(c.notNull).toBe(true);
      expect(c.hasDefault).toBe(true);
    }
  });

  it("has unique(chatwork_message_id, chatwork_file_id) for idempotent upsert (REQ-007 / NFR-004)", () => {
    const uniques = cfg.uniqueConstraints.map((u) => ({
      name: u.name,
      columns: u.columns.map((c) => c.name),
    }));
    expect(uniques).toContainEqual({
      name: "chatwork_message_attachments_message_file_unique",
      columns: ["chatwork_message_id", "chatwork_file_id"],
    });
  });

  it("has explicit index on chatwork_message_id (FK index / coding-rules [MUST])", () => {
    const indexes = cfg.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((c) => (c as { name: string }).name),
    }));
    expect(indexes).toContainEqual({
      name: "chatwork_message_attachments_message_idx",
      columns: ["chatwork_message_id"],
    });
  });

  it("has FK chatwork_message_id -> chatwork_messages.id (bigint internal PK)", () => {
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error("foreign key missing");
    const ref = fk.reference();
    expect(ref.columns.map((c) => c.name)).toEqual(["chatwork_message_id"]);
    // 参照先は chatwork_messages.id（内部 bigint PK）。text の外部 ID 列ではない（design §3.1）。
    expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
    expect(ref.foreignColumns.map((c) => c.getSQLType())).toEqual(["bigint"]);
    expect(getTableConfig(ref.foreignTable).name).toBe(getTableConfig(chatworkMessages).name);
  });

  it("has no CHECK constraints (no enum-like columns in this table)", () => {
    expect(cfg.checks).toEqual([]);
  });
});
