import { WebClient } from "@slack/web-api";
import type {
  SlackChannelId,
  SlackMessage,
  SlackTs,
  SlackUploadFileInput,
} from "@/adapters/slack/types";
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

  /**
   * 指定スレッドにファイルをアップロードする（`files.uploadV2` / REQ-003）。
   *
   * `input.bytes`（`Uint8Array`）は adapter 内部で `Buffer.from` に変換してから SDK に渡す
   * （`@slack/web-api` の `file` 引数型は `Buffer | Stream | string` / ASM-003）。本文投稿の
   * `threadTs` を `thread_ts` に渡し、本文と添付の対応をスレッドで明示する（REQ-005）。
   *
   * @param input アップロード入力（チャンネル ID／スレッド `ts`／ファイル名／MIME／バイト列）
   * @returns Slack 側で採番された `file.id`（`{ slackFileId }`）
   * @throws SlackApiError API 失敗（`ok: false`）・例外送出・`file.id` 欠落時。エラーには
   *   bot token・ファイル名・バイトを含めない（操作名／チャンネル ID／Slack エラーコードのみ）
   */
  uploadFile(input: SlackUploadFileInput): Promise<{ slackFileId: string }>;
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

    async uploadFile(input: SlackUploadFileInput): Promise<{ slackFileId: string }> {
      const op = "slack.uploadFile";

      let response: Awaited<ReturnType<typeof web.files.uploadV2>>;
      try {
        response = await web.files.uploadV2({
          channel_id: input.channelId,
          thread_ts: input.threadTs,
          filename: input.filename,
          // ASM-003: SDK の `file` 型は `Buffer | Stream | string`。`Uint8Array` は
          // 直接渡せないため必ず Buffer 化する（Codex 重大指摘）。
          file: Buffer.from(input.bytes),
        });
      } catch (error) {
        // SDK は API エラー（platform / rate-limit / network）で例外を送出する。
        // 生エラーには token・ファイル名・バイトを載せず、Slack のエラーコードのみ抽出する。
        throw new SlackApiError(op, input.channelId, extractSlackErrorCode(error));
      }

      if (response.ok === false) {
        // ok: false は SDK が例外化しないケースもあるため明示的に弾く。
        throw new SlackApiError(op, input.channelId, response.error);
      }

      const slackFileId = extractSlackFileId(response);
      if (slackFileId === undefined) {
        // 成功扱いでも file.id が取れない（レスポンス形ブレ・欠落）場合は失敗とする。
        throw new SlackApiError(op, input.channelId, response.error);
      }

      return { slackFileId };
    },
  };
}

/**
 * `files.uploadV2` のレスポンスから Slack の `file.id` を取り出す。
 *
 * 現行 SDK（`@slack/web-api ^7.16.0`）は `{ ok, files: FilesCompleteUploadExternalResponse[] }`
 * を返し、各要素が `files?: [{ id }]` を持つ **入れ子**構造になる（ASM-003）。過渡期の旧 SDK 形
 * （`{ files: [{ id }] }` / `{ file: { id } }`）も保険としてフォールバックで吸収する。
 *
 * バイト・ファイル名・token は参照せず、`id`（識別子）のみを抽出する（NFR-002）。
 *
 * @param response `files.uploadV2` の戻り値（型は緩いため `unknown` 扱いで解析）
 * @returns Slack の `file.id`。どの形にもマッチしなければ undefined
 */
function extractSlackFileId(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }

  const files = (response as { files?: unknown }).files;
  if (Array.isArray(files) && files.length > 0) {
    const first = files[0];
    if (typeof first === "object" && first !== null) {
      // 1. 主: 現行 SDK の入れ子形 response.files[0].files[0].id
      const nested = (first as { files?: unknown }).files;
      if (Array.isArray(nested) && nested.length > 0) {
        const nestedId = extractId(nested[0]);
        if (nestedId !== undefined) {
          return nestedId;
        }
      }
      // 2. 旧形 a: response.files[0].id
      const flatId = extractId(first);
      if (flatId !== undefined) {
        return flatId;
      }
    }
  }

  // 3. 旧形 b: response.file.id
  return extractId((response as { file?: unknown }).file);
}

/**
 * 任意の値から `id`（文字列）フィールドを安全に取り出す。
 *
 * @param value 検査対象（オブジェクト以外・id 欠落・非文字列は undefined）
 * @returns `id` の文字列値。取得できなければ undefined
 */
function extractId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") {
      return id;
    }
  }
  return undefined;
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
