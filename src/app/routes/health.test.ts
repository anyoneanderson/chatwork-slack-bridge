import { describe, expect, it, vi } from "vitest";

import { createApp } from "@/app/server";
import type { Config } from "@/config/env";
import type { DbClient } from "@/db/client";
import type { Logger } from "@/logger";
import { TimeoutError } from "@/with-timeout";

type LogCall = {
  payload: unknown;
  message: string;
};

function createTestDeps(ping: DbClient["ping"]) {
  const errorCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  const config: Config = {
    DATABASE_URL: "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
    PORT: 3000,
    LOG_LEVEL: "info",
    NODE_ENV: "test",
    DB_HEALTH_TIMEOUT_MS: 123,
  };
  const db = {
    db: {},
    ping,
    close: vi.fn<DbClient["close"]>(),
  } as unknown as DbClient;
  const logger = {
    error(payload: unknown, message: string) {
      errorCalls.push({ payload, message });
    },
    warn(payload: unknown, message: string) {
      warnCalls.push({ payload, message });
    },
  } as unknown as Logger;

  return {
    deps: { db, config, logger },
    errorCalls,
    warnCalls,
  };
}

describe("GET /health", () => {
  it("returns ok status when db.ping resolves", async () => {
    const ping = vi.fn<DbClient["ping"]>().mockResolvedValue(undefined);
    const { deps, errorCalls } = createTestDeps(ping);
    const app = createApp(deps);

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: "ok" });
    expect(ping).toHaveBeenCalledWith(123);
    expect(errorCalls).toHaveLength(0);
  });

  it("returns down status when db.ping rejects with connection failure", async () => {
    const rawUrl = "postgres://u:p@localhost:5432/db";
    const ping = vi
      .fn<DbClient["ping"]>()
      .mockRejectedValue(new Error(`connection failed for ${rawUrl}`));
    const { deps, errorCalls } = createTestDeps(ping);
    const app = createApp(deps);

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", db: "down" });
    expect(errorCalls).toHaveLength(1);
    expect(JSON.stringify(errorCalls)).not.toContain(rawUrl);
    expect(JSON.stringify(errorCalls)).not.toContain("u:p@");
    expect(JSON.stringify(errorCalls)).toContain("[REDACTED_URL]");
    expect(JSON.stringify(errorCalls)).not.toContain(deps.config.DATABASE_URL);
  });

  it("returns down status when db.ping rejects with TimeoutError", async () => {
    const ping = vi.fn<DbClient["ping"]>().mockRejectedValue(new TimeoutError("db.ping"));
    const { deps, errorCalls } = createTestDeps(ping);
    const app = createApp(deps);

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", db: "down" });
    expect(errorCalls).toHaveLength(1);
    expect(JSON.stringify(errorCalls)).not.toContain(deps.config.DATABASE_URL);
  });

  it("returns down status when db.ping rejects with non-Error value", async () => {
    const ping = vi.fn<DbClient["ping"]>().mockRejectedValue("connection down");
    const { deps, errorCalls } = createTestDeps(ping);
    const app = createApp(deps);

    const response = await app.request("/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", db: "down" });
    expect(errorCalls).toHaveLength(1);
    expect(JSON.stringify(errorCalls)).not.toContain(deps.config.DATABASE_URL);
  });

  it("returns not found when route is missing", async () => {
    const ping = vi.fn<DbClient["ping"]>().mockResolvedValue(undefined);
    const { deps, warnCalls } = createTestDeps(ping);
    const app = createApp(deps);

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(warnCalls).toHaveLength(1);
  });

  it("returns internal error when route handler throws", async () => {
    const ping = vi.fn<DbClient["ping"]>().mockResolvedValue(undefined);
    const { deps, errorCalls } = createTestDeps(ping);
    const app = createApp(deps);
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const response = await app.request("/boom");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(errorCalls).toHaveLength(1);
    expect(JSON.stringify(errorCalls)).not.toContain(deps.config.DATABASE_URL);
  });
});
