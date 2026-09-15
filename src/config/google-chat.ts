import { z } from "zod";
import type { SecretProvider } from "@/adapters/secrets/types";

const CredentialsSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    refresh_token: z.string().min(1),
    sender_names: z
      .record(z.string().regex(/^users\/[A-Za-z0-9_-]+$/), z.string().trim().min(1).max(200))
      .optional(),
  })
  .transform((value) => ({
    clientId: value.client_id,
    clientSecret: value.client_secret,
    refreshToken: value.refresh_token,
    ...(value.sender_names !== undefined ? { senderNames: value.sender_names } : {}),
  }));
const GoogleChatConfigSchema = z.object({
  accountEmail: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  spaceName: z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/),
  spaceDisplayName: z.string().trim().min(1),
  slackChannelId: z.string().regex(/^[CG][A-Z0-9]+$/),
  startTime: z.string().datetime({ offset: true }),
  pollIntervalMs: z.coerce.number().int().min(10000).max(2147483647).default(60000),
  allowedReplyUserIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)),
  credentials: CredentialsSchema,
});
export type GoogleChatConfig = z.infer<typeof GoogleChatConfigSchema>;

/** 設定実値・Zod の入力値をエラーへ含めない。 */
export class GoogleChatConfigError extends Error {
  public readonly issues: readonly { field: string; code: string }[];
  /**
   * @param issues 既知の変数名と検証コードだけを含む診断情報
   * @returns 秘密を含まない設定エラー
   */
  constructor(issues: readonly { field: string; code: string }[] = []) {
    super("Invalid Google Chat configuration");
    this.name = "GoogleChatConfigError";
    this.issues = issues;
  }
}

/**
 * @param provider 設定と秘密の取得元
 * @returns 明示的な有効化時だけ検証済み設定。未設定は無効
 * @throws GoogleChatConfigError 有効化値・必須設定・credentials が不正
 */
export function loadGoogleChatConfig(provider: SecretProvider): GoogleChatConfig | undefined {
  const enabled = z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .safeParse(provider.get("GOOGLE_CHAT_ENABLED"));
  if (!enabled.success)
    throw new GoogleChatConfigError([{ field: "GOOGLE_CHAT_ENABLED", code: "invalid_value" }]);
  if (enabled.data === "false" || enabled.data === "0") return undefined;
  let credentials: unknown;
  try {
    credentials = JSON.parse(provider.get("GOOGLE_CHAT_CREDENTIALS") ?? "null");
  } catch {
    throw new GoogleChatConfigError([{ field: "GOOGLE_CHAT_CREDENTIALS", code: "invalid_json" }]);
  }
  const parsed = GoogleChatConfigSchema.safeParse({
    accountEmail: provider.get("GOOGLE_CHAT_ACCOUNT_EMAIL"),
    spaceName: provider.get("GOOGLE_CHAT_SPACE_NAME"),
    spaceDisplayName: provider.get("GOOGLE_CHAT_SPACE_DISPLAY_NAME"),
    slackChannelId: provider.get("GOOGLE_CHAT_SLACK_CHANNEL_ID"),
    startTime: provider.get("GOOGLE_CHAT_START_TIME"),
    pollIntervalMs: provider.get("GOOGLE_CHAT_POLL_INTERVAL_MS"),
    allowedReplyUserIds: (provider.get("GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    credentials,
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {
      accountEmail: "GOOGLE_CHAT_ACCOUNT_EMAIL",
      spaceName: "GOOGLE_CHAT_SPACE_NAME",
      spaceDisplayName: "GOOGLE_CHAT_SPACE_DISPLAY_NAME",
      slackChannelId: "GOOGLE_CHAT_SLACK_CHANNEL_ID",
      startTime: "GOOGLE_CHAT_START_TIME",
      pollIntervalMs: "GOOGLE_CHAT_POLL_INTERVAL_MS",
      allowedReplyUserIds: "GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS",
      credentials: "GOOGLE_CHAT_CREDENTIALS",
    };
    // path の末尾には sender_names の実ユーザー ID が入るため、既知の最上位キーだけ使う。
    throw new GoogleChatConfigError(
      parsed.error.issues.map((issue) => ({
        field: fields[String(issue.path[0])] ?? "GOOGLE_CHAT_CONFIG",
        code: issue.code,
      })),
    );
  }
  return parsed.data;
}
