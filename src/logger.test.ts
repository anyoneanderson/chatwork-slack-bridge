import { describe, expect, it } from "vitest";

import { createLogger } from "@/logger";

describe("createLogger", () => {
  it("returns logger with requested level when level is valid", () => {
    const logger = createLogger("debug");

    expect(logger.level).toBe("debug");
  });
});
