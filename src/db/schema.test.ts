import { describe, expect, it } from "vitest";

import { MESSAGE_STATUS, ROOM_TYPES } from "@/db/schema";

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
