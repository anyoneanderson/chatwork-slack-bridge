import { describe, expect, it } from "vitest";

import { toSlackChannelId } from "@/adapters/slack/types";
import { type ResolveTargetDeps, resolveTarget } from "@/app/services/resolve-target";

// DUMMY 値（実チャンネル ID を含まない / CON-005）。
const DEFAULT_GROUP = toSlackChannelId("C0DUMMYGROUP");
const DEFAULT_DM = toSlackChannelId("C0DUMMYDM");
const MAPPED_CHANNEL = toSlackChannelId("C0DUMMYMAPPED");

const DEPS: ResolveTargetDeps = {
  defaultGroupChannelId: DEFAULT_GROUP,
  defaultDmChannelId: DEFAULT_DM,
};

describe("resolveTarget", () => {
  it("skips with reason 'mychat' when room_type is my", () => {
    // Arrange / Act: my は enabled・channel に関わらず skip（CON-003）。
    const target = resolveTarget(
      { roomType: "my", enabled: true, slackChannelId: MAPPED_CHANNEL },
      DEPS,
    );

    // Assert
    expect(target).toEqual({ kind: "skip", reason: "mychat" });
  });

  it("skips with reason 'disabled' when enabled is false", () => {
    // Arrange / Act: 無効化されたルームは保存のみ（投稿しない）。
    const target = resolveTarget({ roomType: "group", enabled: false, slackChannelId: null }, DEPS);

    // Assert
    expect(target).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("disabled takes precedence over a mapped channel", () => {
    // Arrange / Act: disabled は channel 紐付けがあっても保存のみ。
    const target = resolveTarget(
      { roomType: "group", enabled: false, slackChannelId: MAPPED_CHANNEL },
      DEPS,
    );

    // Assert
    expect(target).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("posts to the mapped channel when slackChannelId is set", () => {
    // Arrange / Act: 紐付け済みは専用チャンネルへ。
    const target = resolveTarget(
      { roomType: "group", enabled: true, slackChannelId: MAPPED_CHANNEL },
      DEPS,
    );

    // Assert
    expect(target).toEqual({ kind: "post", channelId: MAPPED_CHANNEL });
  });

  it("posts a direct room to its mapped channel over the DM fallback", () => {
    // Arrange / Act: direct でも紐付けがあれば専用チャンネルが優先される。
    const target = resolveTarget(
      { roomType: "direct", enabled: true, slackChannelId: MAPPED_CHANNEL },
      DEPS,
    );

    // Assert
    expect(target).toEqual({ kind: "post", channelId: MAPPED_CHANNEL });
  });

  it("falls back to defaultGroup channel for an unmapped group room", () => {
    // Arrange / Act: 紐付けなしの group は種別集約（group）へ。
    const target = resolveTarget({ roomType: "group", enabled: true, slackChannelId: null }, DEPS);

    // Assert
    expect(target).toEqual({ kind: "post", channelId: DEFAULT_GROUP });
  });

  it("falls back to defaultDm channel for an unmapped direct room", () => {
    // Arrange / Act: 紐付けなしの direct は種別集約（DM）へ。
    const target = resolveTarget({ roomType: "direct", enabled: true, slackChannelId: null }, DEPS);

    // Assert
    expect(target).toEqual({ kind: "post", channelId: DEFAULT_DM });
  });
});
