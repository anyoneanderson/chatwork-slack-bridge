import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbClient } from "@/db/client";

// postgres.js と drizzle をモックし、接続を張らずに渡す引数だけを検証する。
const postgresMock = vi.hoisted(() => vi.fn(() => ({ end: vi.fn() })));
const drizzleMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));

const DATABASE_URL = "postgres://bridge_user:bridge_pass@db.example.com:5432/bridge";

beforeEach(() => {
  postgresMock.mockClear();
  drizzleMock.mockClear();
});

describe("createDbClient", () => {
  it("disables prepared statements when pooled is true", () => {
    createDbClient(DATABASE_URL, { pooled: true });

    expect(postgresMock).toHaveBeenCalledWith(DATABASE_URL, { prepare: false });
  });

  it("does not pass connection options when pooled is false (backward compatible)", () => {
    createDbClient(DATABASE_URL, { pooled: false });

    expect(postgresMock).toHaveBeenCalledWith(DATABASE_URL);
    expect(postgresMock.mock.calls[0]).toHaveLength(1);
  });

  it("does not pass connection options when options are omitted (backward compatible)", () => {
    createDbClient(DATABASE_URL);

    expect(postgresMock).toHaveBeenCalledWith(DATABASE_URL);
    expect(postgresMock.mock.calls[0]).toHaveLength(1);
  });
});
