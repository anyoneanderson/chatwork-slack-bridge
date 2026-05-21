import { describe, expect, it } from "vitest";

import { serializeError } from "@/serialize-error";

describe("serializeError", () => {
  it("scrubs postgres connection strings embedded in error messages", () => {
    const rawUrl = "postgres://u:p@localhost:5432/db";
    const result = serializeError(new Error(`connection failed for ${rawUrl}`));

    expect(result.name).toBe("Error");
    expect(result.message).toContain("connection failed");
    expect(result.message).toContain("[REDACTED_URL]");
    expect(result.message).not.toContain(rawUrl);
    expect(result.message).not.toContain("u:p@");
  });

  it("scrubs URL userinfo embedded in non-postgres error messages", () => {
    const result = serializeError(new Error("request failed: https://user:pass@example.com/path"));

    expect(result.message).toBe("request failed: https://[REDACTED]@example.com/path");
    expect(result.message).not.toContain("user:pass@");
  });

  it("preserves op from TimeoutError-like errors", () => {
    const err = new Error("operation timed out") as Error & { op: string };
    err.name = "TimeoutError";
    err.op = "db.ping";

    expect(serializeError(err)).toEqual({
      name: "TimeoutError",
      message: "operation timed out",
      op: "db.ping",
    });
  });

  it("handles non-Error values", () => {
    expect(serializeError("connection down")).toEqual({
      name: "UnknownError",
      message: "unknown error",
    });
  });
});
