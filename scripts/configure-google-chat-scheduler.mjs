import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

class ConfigurationError extends Error {}

function required(name) {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`Missing configuration: ${name}`);
  return value;
}

function gcloud(operation, args, trim = true) {
  try {
    const output = execFileSync("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true",
        CLOUDSDK_CORE_LOG_HTTP: "false",
        CLOUDSDK_CORE_VERBOSITY: "error",
      },
    });
    return trim ? output.trim() : output;
  } catch {
    // CLI のエラーには HTTP ヘッダーが含まれる可能性があるため転載しない。
    throw new ConfigurationError(`Cloud Scheduler configuration command failed: ${operation}`);
  }
}

function scheduleValue() {
  const schedule = process.env.GOOGLE_CHAT_SCHEDULE || "* * * * *";
  const fields = schedule.trim().split(/\s+/);
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const names = [
    [],
    [],
    [],
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
    ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
  ];
  const valid =
    fields.length === 5 &&
    fields.every((field, index) => {
      const [minimum, maximum] = bounds[index];
      const parseEndpoint = (value) =>
        /^\d{1,2}$/.test(value)
          ? Number(value)
          : names[index].indexOf(value) + (index === 3 ? 1 : 0);
      return field.split(",").every((part) => {
        if (
          !/^(?:\*|[0-9]{1,2}|[A-Z]{3})(?:-(?:[0-9]{1,2}|[A-Z]{3}))?(?:\/[0-9]{1,2})?$/.test(part)
        )
          return false;
        const [range, step] = part.split("/");
        if (step !== undefined && (Number(step) < 1 || Number(step) > maximum)) return false;
        if (range === "*") return true;
        const endpoints = range.split("-").map(parseEndpoint);
        return (
          endpoints.every((value) => value >= minimum && value <= maximum) &&
          (endpoints.length === 1 || endpoints[0] <= endpoints[1])
        );
      });
    });
  if (!valid)
    throw new ConfigurationError("GOOGLE_CHAT_SCHEDULE must be a valid five-field cron expression");
  return fields.join(" ");
}

function configure() {
  const enabled = ["true", "1"].includes(process.env.GOOGLE_CHAT_ENABLED ?? "false");
  if (!enabled && !process.env.GOOGLE_CHAT_POLL_TOKEN_SECRET) return;
  const project = required("APP_PROJECT_ID");
  const location = required("CLOUD_RUN_REGION");
  const jobId = `${required("APP_SERVICE")}-google-chat-poll`;
  const common = [`--project=${project}`, "--quiet"];
  const preflight = process.argv.includes("--check");
  const schedule = enabled ? scheduleValue() : undefined;
  const api = gcloud("services_list", [
    "services",
    "list",
    "--enabled",
    "--filter=config.name:cloudscheduler.googleapis.com",
    "--format=value(config.name)",
    ...common,
  ]);
  if (!api.split("\n").includes("cloudscheduler.googleapis.com")) {
    if (enabled)
      throw new ConfigurationError("Enable the Cloud Scheduler API before enabling Google Chat");
    return;
  }

  const jobName = `projects/${project}/locations/${location}/jobs/${jobId}`;
  const jobList = gcloud("jobs_list", [
    "scheduler",
    "jobs",
    "list",
    `--location=${location}`,
    `--filter=name=${jobName}`,
    "--format=json(name,state)",
    ...common,
  ]);
  let jobs;
  try {
    jobs = z
      .array(z.object({ name: z.string(), state: z.string().optional() }))
      .safeParse(JSON.parse(jobList));
  } catch {
    throw new ConfigurationError("Invalid Cloud Scheduler job list");
  }
  if (!jobs.success) throw new ConfigurationError("Invalid Cloud Scheduler job list");
  const job = jobs.data.find((entry) => entry.name === jobName);
  const jobArgs = [jobId, `--location=${location}`, ...common, "--format=none"];
  if (!enabled) {
    if (!preflight && job && job.state !== "PAUSED")
      gcloud("jobs_pause", ["scheduler", "jobs", "pause", ...jobArgs]);
    return;
  }

  const token = gcloud(
    "secrets_access",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${required("GOOGLE_CHAT_POLL_TOKEN_SECRET")}`,
      ...common,
    ],
    false,
  );
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new ConfigurationError("Invalid Google Chat poll token");

  if (preflight) return;

  const serviceUrl = new URL(required("SERVICE_URL"));
  if (
    serviceUrl.protocol !== "https:" ||
    serviceUrl.username ||
    serviceUrl.password ||
    serviceUrl.pathname !== "/" ||
    serviceUrl.search ||
    serviceUrl.hash
  ) {
    throw new ConfigurationError("SERVICE_URL must be an HTTPS origin");
  }

  const flags = {
    "--schedule": schedule,
    "--time-zone": "Etc/UTC",
    "--uri": `${serviceUrl.origin}/internal/poll-google-chat`,
    "--http-method": "POST",
    "--message-body": "{}",
    "--attempt-deadline": "180s",
    "--max-retry-attempts": 0,
    "--max-retry-duration": "0s",
    [job ? "--update-headers" : "--headers"]: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(job ? { "--clear-auth-token": true } : {}),
  };
  const directory = mkdtempSync(join(tmpdir(), "bridge-scheduler-"));
  try {
    const flagsFile = join(directory, "flags.json");
    writeFileSync(flagsFile, JSON.stringify(flags), { mode: 0o600 });
    gcloud(job ? "jobs_update" : "jobs_create", [
      "scheduler",
      "jobs",
      job ? "update" : "create",
      "http",
      ...jobArgs,
      `--flags-file=${flagsFile}`,
    ]);
    if (job?.state === "PAUSED") gcloud("jobs_resume", ["scheduler", "jobs", "resume", ...jobArgs]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  configure();
} catch (error) {
  process.stderr.write(
    `${error instanceof ConfigurationError ? error.message : "Scheduler configuration failed"}\n`,
  );
  process.exitCode = 1;
}
