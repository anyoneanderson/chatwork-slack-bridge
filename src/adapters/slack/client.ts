import { WebClient } from "@slack/web-api";
import type { SlackChannelId, SlackMessage, SlackTs } from "@/adapters/slack/types";
import { toSlackTs } from "@/adapters/slack/types";

/**
 * Slack API 呼び出しの失敗を表す（REQ-008）。
 *
 * bot token・メッセージ本文・送信者名は **保持しない**。操作名・対象チャンネル ID・（あれば）
 * Slack のエラーコードのみを持ち、`serializeError` 経由で構造化ログに載せても秘密・本文が漏れない
 * ようにする（NFR-003 / coding-rules ログへの秘密情報出力禁止）。
 */
export class SlackApiError extends Error {
  /** 失敗した操作名（構造化ログの `op` に対応）。 */
  public readonly op: string;
  /** 対象チャンネル ID（識別子。秘密ではない）。 */
  public readonly channelId: SlackChannelId;
  /** Slack が返したエラーコード（`ok: false` の `error` フィールド等）。取得できない場合は undefined。 */
  public readonly slackError: string | undefined;

  /**
   * 失敗した操作名・チャンネル ID・Slack エラーコードを保持する。
   *
   * @param op 失敗した操作名（例: `slack.postMessage`）
   * @param channelId 対象チャンネル ID
   * @param slackError Slack のエラーコード（取得できない場合は省略）
   * @returns SlackApiError インスタンス
   */
  constructor(op: string, channelId: SlackChannelId, slackError?: string) {
    super(
      slackError === undefined
        ? `Slack API call failed: ${op}`
        : `Slack API call failed: ${op} (${slackError})`,
    );
    this.name = "SlackApiError";
    this.op = op;
    this.channelId = channelId;
    this.slackError = slackError;
  }
}

/** Slack API の薄い client。外部 SDK（`@slack/web-api`）依存は adapter 内に閉じる（NFR-004）。 */
export interface SlackClient {
  /**
   * 指定チャンネルにメッセージを投稿する（`chat.postMessage`）。
   *
   * 本フェーズはトップレベル投稿のみ（スレッド化は slack-reply 以降）。
   *
   * @param channelId 投稿先チャンネル ID
   * @param message 投稿ペイロード（`format` の出力。`{ text }`）
   * @returns 投稿された Slack メッセージの `ts`（ブランド型 `SlackTs`。実行時は文字列）
   * @throws SlackApiError API 失敗（`ok: false`）・例外送出・`ts` 欠落時。エラーには
   *   bot token・本文を含めない（操作名／チャンネル ID／Slack エラーコードのみ）
   */
  postMessage(channelId: SlackChannelId, message: SlackMessage): Promise<{ ts: SlackTs }>;
}

/**
 * `@slack/web-api` の `WebClient` を使った Slack client を生成する（REQ-008）。
 *
 * `botToken`（`SLACK_BOT_TOKEN`。secret adapter 経由）で `WebClient` を初期化する。token は
 * ログ・エラーに出さない。`chat.postMessage` は失敗時に例外を送出する（`WebAPIPlatformError`
 * 等）うえ、成功扱いでも `ok: false` を返しうるため、両方を `SlackApiError` に正規化する。
 *
 * @param deps `botToken`（`SLACK_BOT_TOKEN`。secret adapter 経由）
 * @returns `SlackClient` 実装
 */
export function createSlackClient(deps: { botToken: string }): SlackClient {
  const web = new WebClient(deps.botToken);

  return {
    async postMessage(channelId: SlackChannelId, message: SlackMessage): Promise<{ ts: SlackTs }> {
      const op = "slack.postMessage";

      let response: Awaited<ReturnType<typeof web.chat.postMessage>>;
      try {
        response = await web.chat.postMessage({
          channel: channelId,
          text: message.text,
        });
      } catch (error) {
        // SDK は API エラー（platform / rate-limit / network）で例外を送出する。
        // 生エラーには token が載らない設計だが、念のため Slack のエラーコードのみ抽出して伝える。
        throw new SlackApiError(op, channelId, extractSlackErrorCode(error));
      }

      if (!response.ok || typeof response.ts !== "string") {
        // ok: false（または ts 欠落）は SDK が例外化しないケースもあるため明示的に弾く。
        throw new SlackApiError(op, channelId, response.error);
      }

      return { ts: toSlackTs(response.ts) };
    },
  };
}

/**
 * Slack SDK が送出したエラーから安全なエラーコードのみを取り出す。
 *
 * token・リクエスト本文・スタックは取り出さず、`data.error`（Slack のエラーコード文字列）が
 * あればそれだけを返す（NFR-003）。
 *
 * @param error catch したエラー
 * @returns Slack のエラーコード文字列（取得できない場合は undefined）
 */
function extractSlackErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data: unknown }).data === "object" &&
    (error as { data: unknown }).data !== null
  ) {
    const data = (error as { data: { error?: unknown } }).data;
    if (typeof data.error === "string") {
      return data.error;
    }
  }
  return undefined;
}
