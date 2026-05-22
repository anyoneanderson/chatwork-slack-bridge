import { describe, expect, it } from "vitest";

import { WebhookPayloadSchema } from "@/adapters/chatwork/webhook-schema";

// DUMMY payload（実 ID・本文・クライアント名を含まない / CON-005）。
// 送信者フィールドは account_id（from_account_id ではない / design 6）。
const validMessageCreatedPayload = {
  webhook_setting_id: "1",
  webhook_event_type: "message_created",
  webhook_event_time: 1700000000,
  webhook_event: {
    account_id: 100,
    room_id: 200,
    message_id: "1000000000000000000",
    body: "dummy message body",
    send_time: 1700000000,
    update_time: 1700000000,
  },
} as const;

describe("WebhookPayloadSchema", () => {
  it("succeeds for a valid message_created payload using account_id as the sender field", () => {
    // Act
    const result = WebhookPayloadSchema.safeParse(validMessageCreatedPayload);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhook_event_type).toBe("message_created");
      expect(result.data.webhook_event.account_id).toBe(100);
    }
  });

  it("fails when a required field is missing (webhook_event.body)", () => {
    // Arrange: body を欠落させる。
    const { body: _omitted, ...eventWithoutBody } = validMessageCreatedPayload.webhook_event;
    const payload = { ...validMessageCreatedPayload, webhook_event: eventWithoutBody };

    // Act
    const result = WebhookPayloadSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("fails when a field has the wrong type (room_id as string)", () => {
    // Arrange: room_id は数値で届くため、文字列は拒否される。
    const payload = {
      ...validMessageCreatedPayload,
      webhook_event: { ...validMessageCreatedPayload.webhook_event, room_id: "200" },
    };

    // Act
    const result = WebhookPayloadSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(false);
  });

  it("fails when the sender field is from_account_id instead of account_id (field-name regression guard)", () => {
    // Arrange: from_account_id（mention_to_me 系の項目）を account_id の代わりに使うと弾かれること。
    // 実 webhook の取り違えを防ぐリグレッションガード（design 6 / Chatwork webhook docs）。
    const { account_id: _dropped, ...eventWithoutAccountId } =
      validMessageCreatedPayload.webhook_event;
    const payload = {
      ...validMessageCreatedPayload,
      webhook_event: { ...eventWithoutAccountId, from_account_id: 100 },
    };

    // Act
    const result = WebhookPayloadSchema.safeParse(payload);

    // Assert: account_id が欠けているため失敗する。
    expect(result.success).toBe(false);
  });

  it("parses non-target event types at schema level but keeps them distinguishable by webhook_event_type", () => {
    // Arrange: message_deleted は本フェーズ対象外だが、schema レベルでは構造が同じため通る。
    // 対象判定は webhook_event_type で行う（イベント種別の分別が可能であることを確認）。
    const payload = { ...validMessageCreatedPayload, webhook_event_type: "message_deleted" };

    // Act
    const result = WebhookPayloadSchema.safeParse(payload);

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhook_event_type).toBe("message_deleted");
      expect(result.data.webhook_event_type).not.toBe("message_created");
    }
  });
});
