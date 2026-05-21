import type { SlackChannelId } from "@/adapters/slack/types";
import type { RoomType } from "@/db/schema";

/**
 * ルーティング結果。投稿する/しないを discriminated union で表す（REQ-007 / 設計 §4.4）。
 *
 * `boolean` フラグの組み合わせではなく `kind` で相互排他を表現し、不正な状態を型で排除する
 * （coding-rules [SHOULD] 型安全）。
 */
export type ForwardTarget =
  | { kind: "post"; channelId: SlackChannelId }
  | { kind: "skip"; reason: "mychat" | "disabled" };

/** ルーティングに必要なルームの状態（DB キャッシュの部分ビュー）。 */
export interface ResolveTargetRoom {
  /** ルーム種別（`group` / `direct` / `my`）。 */
  roomType: RoomType;
  /** ルームが有効か。`false` のとき保存はするが Slack 投稿はしない。 */
  enabled: boolean;
  /** 紐付け済み専用チャンネル。null は種別集約フォールバックを意味する（CON-004）。 */
  slackChannelId: SlackChannelId | null;
}

/** 種別集約チャンネル（フォールバック先）。config の `SLACK_DEFAULT_*_CHANNEL_ID` 由来。 */
export interface ResolveTargetDeps {
  /** group 種別の集約フォールバックチャンネル。 */
  defaultGroupChannelId: SlackChannelId;
  /** direct 種別の集約フォールバックチャンネル。 */
  defaultDmChannelId: SlackChannelId;
}

/**
 * ルームの状態から Slack 投稿先（または skip）を決定する（REQ-007 / 設計 §4.4）。
 *
 * 判定順:
 * 1. `room_type = my` → skip（マイチャットは転送対象外 / CON-003）
 * 2. `enabled = false` → skip（明示的に無効化されたルームは保存のみ）
 * 3. `slack_channel_id` あり → その専用チャンネルへ post（紐付け済み）
 * 4. `slack_channel_id` なし → 種別集約（group → defaultGroup / direct → defaultDm）
 *
 * `my` は本フローでは保存前（forward-message 手順3）に弾くが、種別取得経路の差異に備えて
 * ルーティング層でも skip し、二重に守る（設計 §4.4 注記）。
 *
 * @param room 対象ルームの状態（DB キャッシュ）
 * @param deps 種別集約チャンネル（フォールバック先）
 * @returns 投稿先（`post`）またはスキップ理由（`skip`）
 */
export function resolveTarget(room: ResolveTargetRoom, deps: ResolveTargetDeps): ForwardTarget {
  if (room.roomType === "my") return { kind: "skip", reason: "mychat" };
  if (!room.enabled) return { kind: "skip", reason: "disabled" };
  if (room.slackChannelId) return { kind: "post", channelId: room.slackChannelId };

  switch (room.roomType) {
    case "group":
      return { kind: "post", channelId: deps.defaultGroupChannelId };
    case "direct":
      return { kind: "post", channelId: deps.defaultDmChannelId };
    default: {
      // never 網羅性チェック（種別追加時にコンパイルエラーで気付く / coding-rules [SHOULD]）。
      const _exhaustive: never = room.roomType;
      return _exhaustive;
    }
  }
}
