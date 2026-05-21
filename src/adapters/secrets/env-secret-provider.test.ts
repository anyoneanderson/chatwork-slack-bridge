import { afterEach, describe, expect, it } from "vitest";

import { EnvSecretProvider } from "@/adapters/secrets/env-secret-provider";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPort = process.env.PORT;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalPort === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = originalPort;
  }
});

describe("EnvSecretProvider", () => {
  it("returns env value when key is set", () => {
    process.env.DATABASE_URL = "postgres://bridge_user:bridge_pass@localhost:5432/bridge";

    expect(new EnvSecretProvider().get("DATABASE_URL")).toBe(
      "postgres://bridge_user:bridge_pass@localhost:5432/bridge",
    );
  });

  it("returns undefined when key is unset", () => {
    delete process.env.PORT;

    expect(new EnvSecretProvider().get("PORT")).toBeUndefined();
  });
});
