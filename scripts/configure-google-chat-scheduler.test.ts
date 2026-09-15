import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const token = "scheduler-test-token-00000000000000";
const jobName = "projects/test-project/locations/test-region/jobs/test-bridge-google-chat-poll";

function runHelper(overrides: Record<string, string> = {}, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-test-"));
  temporaryDirectories.push(directory);
  const logFile = join(directory, "commands.jsonl");
  writeFileSync(logFile, "");
  writeFileSync(
    join(directory, "gcloud"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const flagsFile = args.find(arg => arg.startsWith('--flags-file='))?.slice(13);
const flags = flagsFile ? JSON.parse(fs.readFileSync(flagsFile, 'utf8')) : undefined;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, flags, flagsFile, mode: flagsFile ? fs.statSync(flagsFile).mode & 0o777 : undefined }) + '\\n');
if (process.env.FAKE_FAIL_OPERATION === args.slice(0, 3).join(' ')) {
  process.stderr.write('private-response-canary ' + process.env.FAKE_TOKEN);
  process.exit(1);
}
if (args[0] === 'services') process.stdout.write(process.env.FAKE_API);
else if (args[0] === 'secrets') process.stdout.write(process.env.FAKE_TOKEN);
else if (args[2] === 'list') process.stdout.write(process.env.FAKE_JOBS);
else if (process.env.FAKE_FAIL === 'true') {
  process.stderr.write('Bearer ' + process.env.FAKE_TOKEN);
  process.exit(1);
}
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/configure-google-chat-scheduler.mjs"), ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        APP_PROJECT_ID: "test-project",
        CLOUD_RUN_REGION: "test-region",
        APP_SERVICE: "test-bridge",
        SERVICE_URL: "https://bridge.example.com",
        GOOGLE_CHAT_ENABLED: "true",
        GOOGLE_CHAT_POLL_TOKEN_SECRET: "poll-token",
        GOOGLE_CHAT_SCHEDULE: "* * * * *",
        FAKE_LOG: logFile,
        FAKE_API: "cloudscheduler.googleapis.com",
        FAKE_TOKEN: token,
        FAKE_JOBS: "[]",
        ...overrides,
      },
    },
  );
  const calls = readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          args: string[];
          flags?: Record<string, unknown>;
          flagsFile?: string;
          mode?: number;
        },
    );
  return { result, calls };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Google Chat Cloud Scheduler provisioning", () => {
  it("creates an authenticated schedule without exposing the token in process arguments", () => {
    const { result, calls } = runHelper();
    expect(result.status).toBe(0);
    const create = calls.find(({ args }) => args[2] === "create");
    expect(create?.flags).toMatchObject({
      "--uri": "https://bridge.example.com/internal/poll-google-chat",
      "--schedule": "* * * * *",
      "--http-method": "POST",
      "--message-body": "{}",
      "--attempt-deadline": "180s",
      "--max-retry-attempts": 0,
      "--max-retry-duration": "0s",
      "--headers": { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    expect(create?.mode).toBe(0o600);
    expect(create?.args).toContain("--format=none");
    expect(JSON.stringify(calls.map(({ args }) => args))).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(() => readFileSync(create?.flagsFile ?? "")).toThrow();
  });

  it("updates and resumes a paused job, replacing automatic auth and previous retry settings", () => {
    const { result, calls } = runHelper({
      FAKE_JOBS: JSON.stringify([{ name: jobName, state: "PAUSED" }]),
      GOOGLE_CHAT_SCHEDULE: "*/5 * * * *",
    });
    expect(result.status).toBe(0);
    expect(calls.find(({ args }) => args[2] === "update")?.flags).toMatchObject({
      "--schedule": "*/5 * * * *",
      "--clear-auth-token": true,
      "--update-headers": { Authorization: `Bearer ${token}` },
    });
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(["scheduler", "jobs", "resume"]);
  });

  it("pauses an existing schedule without reading credentials when disabled", () => {
    const { result, calls } = runHelper({
      GOOGLE_CHAT_ENABLED: "false",
      FAKE_JOBS: JSON.stringify([{ name: jobName, state: "ENABLED" }]),
    });
    expect(result.status).toBe(0);
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(["scheduler", "jobs", "pause"]);
    expect(calls.some(({ args }) => args[0] === "secrets")).toBe(false);
  });

  it("does not require the Scheduler API for a disabled installation", () => {
    const { result, calls } = runHelper({ GOOGLE_CHAT_ENABLED: "false", FAKE_API: "" });
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("fails if the Scheduler API is absent when enabled", () => {
    const { result, calls } = runHelper({ FAKE_API: "" });
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed token before creating a job", () => {
    const { result, calls } = runHelper({ FAKE_TOKEN: `${token}\n` });
    expect(result.status).toBe(1);
    expect(calls.some(({ args }) => args[2] === "create")).toBe(false);
    expect(result.stderr).not.toContain(token);
  });

  it("removes its credential file and suppresses CLI response bodies on a failed update", () => {
    const { result, calls } = runHelper({ FAKE_FAIL: "true" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(token);
    const create = calls.find(({ args }) => args[2] === "create");
    expect(() => readFileSync(create?.flagsFile ?? "")).toThrow();
  });
  it.each([
    { SERVICE_URL: "invalid-private-origin-canary" },
    { TMPDIR: "/nonexistent/private-filesystem-canary" },
  ])("does not expose unexpected error details", (overrides) => {
    const { result } = runHelper(overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Scheduler configuration failed\n");
    expect(result.stdout).toBe("");
  });
  it("does not call gcloud for an installation that has never configured Google Chat", () => {
    const { result, calls } = runHelper({
      GOOGLE_CHAT_ENABLED: "false",
      GOOGLE_CHAT_POLL_TOKEN_SECRET: "",
    });
    expect(result.status).toBe(0);
    expect(calls).toEqual([]);
  });
  it("checks prerequisites without requiring a service URL or mutating jobs", () => {
    const { result, calls } = runHelper({ SERVICE_URL: "" }, ["--check"]);
    expect(result.status).toBe(0);
    expect(calls.map(({ args }) => args.slice(0, 3))).toEqual([
      ["services", "list", "--enabled"],
      ["scheduler", "jobs", "list"],
      ["secrets", "versions", "access"],
    ]);
  });

  it("does not pause the existing job during a disabled preflight", () => {
    const { result, calls } = runHelper(
      {
        GOOGLE_CHAT_ENABLED: "false",
        FAKE_JOBS: JSON.stringify([{ name: jobName, state: "ENABLED" }]),
      },
      ["--check"],
    );
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["services list --enabled", "services_list"],
    ["scheduler jobs list", "jobs_list"],
    ["secrets versions access", "secrets_access"],
  ])("reports a safe operation label for a failed prerequisite %s", (operation, label) => {
    const { result, calls } = runHelper({ FAKE_FAIL_OPERATION: operation }, ["--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Cloud Scheduler configuration command failed: ${label}\n`);
    expect(
      calls.every(({ args }) => !["create", "update", "resume", "pause"].includes(args[2] ?? "")),
    ).toBe(true);
  });

  it.each([
    "@hourly",
    "* * * *",
    "99 * * * *",
    "*/0 * * * *",
    "0 0 * XXX *",
    "0 0 * * 8",
    "30-10 * * * *",
  ])("rejects invalid schedules before any command: %s", (schedule) => {
    const { result, calls } = runHelper({ GOOGLE_CHAT_SCHEDULE: schedule }, ["--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("valid five-field cron expression");
    expect(calls).toEqual([]);
  });

  it.each([
    "*/5 * * * *",
    "0,30 8-17 * JAN-MAR MON-FRI",
    "0 0 1 */2 7",
  ])("accepts supported cron syntax: %s", (schedule) => {
    expect(runHelper({ GOOGLE_CHAT_SCHEDULE: schedule }, ["--check"]).result.status).toBe(0);
  });

  it("updates an enabled job without pausing or resuming it", () => {
    const { result, calls } = runHelper({
      FAKE_JOBS: JSON.stringify([{ name: jobName, state: "ENABLED" }]),
    });
    expect(result.status).toBe(0);
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(["scheduler", "jobs", "update"]);
    expect(calls.some(({ args }) => ["pause", "resume"].includes(args[2] ?? ""))).toBe(false);
  });

  it("leaves an already paused disabled job untouched", () => {
    const { result, calls } = runHelper({
      GOOGLE_CHAT_ENABLED: "false",
      FAKE_JOBS: JSON.stringify([{ name: jobName, state: "PAUSED" }]),
    });
    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it.each([
    "http://bridge.example.com",
    "https://bridge.example.com/path",
    "https://user:password@bridge.example.com",
    "https://bridge.example.com?q=private",
  ])("rejects invalid HTTP origins without changing jobs", (origin) => {
    const { result, calls } = runHelper({ SERVICE_URL: origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("SERVICE_URL must be an HTTPS origin\n");
    expect(calls.some(({ args }) => args[2] === "create")).toBe(false);
  });
  it.each([
    ["create", "[]", "true"],
    ["update", JSON.stringify([{ name: jobName, state: "ENABLED" }]), "true"],
    ["resume", JSON.stringify([{ name: jobName, state: "PAUSED" }]), "true"],
    ["pause", JSON.stringify([{ name: jobName, state: "ENABLED" }]), "false"],
  ])("labels failed job %s without disclosing the response", (operation, jobs, enabled) => {
    const { result } = runHelper({
      FAKE_FAIL_OPERATION: `scheduler jobs ${operation}`,
      FAKE_JOBS: jobs,
      GOOGLE_CHAT_ENABLED: enabled,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Cloud Scheduler configuration command failed: jobs_${operation}\n`);
  });
});
