import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  chatworkMessageAttachments,
  chatworkMessages,
  chatworkRoomMembers,
  chatworkRooms,
  MESSAGE_STATUS,
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
