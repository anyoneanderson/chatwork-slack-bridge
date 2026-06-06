import { describe, expect, it } from "vitest";

import { BlockActionsSchema, SlackEventEnvelopeSchema } from "@/adapters/slack/event-schema";

// DUMMY 値（実 channel/ts/user・実本文を含まない / CON-003）。
const DUMMY_CHANNEL = "C0DUMMYCHAN";
const DUMMY_TS = "1700000000.000100";
const DUMMY_THREAD_TS = "1700000000.000000";
const DUMMY_USER = "U0DUMMYUSER";
const DUMMY_TEXT = "dummy reply text";

describe("SlackEventEnvelopeSchema", () => {
  it("parses a url_verification challenge", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "url_verification",
      challenge: "dummy-challenge",
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "url_verification") {
      expect(result.data.challenge).toBe("dummy-challenge");
    }
  });

  it("parses an event_callback message event with a thread_ts", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: {
        type: "message",
        user: DUMMY_USER,
        text: DUMMY_TEXT,
        ts: DUMMY_TS,
        thread_ts: DUMMY_THREAD_TS,
        channel: DUMMY_CHANNEL,
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "event_callback") {
      expect(result.data.event.thread_ts).toBe(DUMMY_THREAD_TS);
      expect(result.data.event.channel).toBe(DUMMY_CHANNEL);
    }
  });

  it("parses a message event without a thread_ts (top-level)", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: {
        type: "message",
        user: DUMMY_USER,
        text: DUMMY_TEXT,
        ts: DUMMY_TS,
        channel: DUMMY_CHANNEL,
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "event_callback") {
      expect(result.data.event.thread_ts).toBeUndefined();
    }
  });

  it("parses a message event with a subtype and ignores unknown fields", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        ts: DUMMY_TS,
        channel: DUMMY_CHANNEL,
        unknown_field: "ignored",
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "event_callback") {
      expect(result.data.event.subtype).toBe("message_changed");
      expect(result.data.event).not.toHaveProperty("unknown_field");
    }
  });

  it("parses a bot_message event (bot_id present)", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B0DUMMYBOT",
        text: DUMMY_TEXT,
        ts: DUMMY_TS,
        channel: DUMMY_CHANNEL,
      },
    });

    expect(result.success).toBe(true);
    if (result.success && result.data.type === "event_callback") {
      expect(result.data.event.bot_id).toBe("B0DUMMYBOT");
    }
  });

  it("rejects an invalid payload (unknown top-level type)", () => {
    const result = SlackEventEnvelopeSchema.safeParse({ type: "something_else" });
    expect(result.success).toBe(false);
  });

  it("rejects an event_callback with a non-message event", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: { type: "reaction_added", ts: DUMMY_TS, channel: DUMMY_CHANNEL },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message event missing channel", () => {
    const result = SlackEventEnvelopeSchema.safeParse({
      type: "event_callback",
      event: { type: "message", ts: DUMMY_TS },
    });
    expect(result.success).toBe(false);
  });
});

describe("BlockActionsSchema", () => {
  it("parses a valid block_actions payload", () => {
    const result = BlockActionsSchema.safeParse({
      type: "block_actions",
      user: { id: DUMMY_USER },
      actions: [{ action_id: "cw_send", value: "12345" }],
      message: { ts: DUMMY_TS },
      channel: { id: DUMMY_CHANNEL },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actions[0]?.action_id).toBe("cw_send");
      expect(result.data.actions[0]?.value).toBe("12345");
      expect(result.data.user.id).toBe(DUMMY_USER);
    }
  });

  it("parses a block_actions payload without optional message/channel/value", () => {
    const result = BlockActionsSchema.safeParse({
      type: "block_actions",
      user: { id: DUMMY_USER },
      actions: [{ action_id: "cw_cancel" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a block_actions payload with an empty actions array", () => {
    const result = BlockActionsSchema.safeParse({
      type: "block_actions",
      user: { id: DUMMY_USER },
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload of the wrong type", () => {
    const result = BlockActionsSchema.safeParse({
      type: "view_submission",
      user: { id: DUMMY_USER },
      actions: [{ action_id: "cw_send", value: "1" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload missing user id", () => {
    const result = BlockActionsSchema.safeParse({
      type: "block_actions",
      user: {},
      actions: [{ action_id: "cw_send", value: "1" }],
    });
    expect(result.success).toBe(false);
  });
});
