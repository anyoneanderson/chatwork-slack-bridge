import { z } from "zod";
import {
  type GoogleChatClient,
  GoogleChatError,
  type GoogleChatMessage,
} from "@/adapters/google-chat/types";
import type { GoogleChatConfig } from "@/config/google-chat";

const API_URL = "https://chat.googleapis.com/v1/";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REQUEST_TIMEOUT_MS = 10000;
const TOKEN_MARGIN_MS = 30000;
const ResourceSegmentSchema = z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
const RawMessageSchema = z.object({
  name: z.string(),
  thread: z.object({ name: z.string() }),
  space: z.object({ name: z.string() }).optional(),
  createTime: z.string().datetime({ offset: true }),
  text: z.string().default(""),
  sender: z.object({ name: z.string().min(1), displayName: z.string().optional() }),
  clientAssignedMessageId: z.string().optional(),
});
const ListSchema = z.object({
  messages: z.array(RawMessageSchema).default([]),
  nextPageToken: z.string().optional(),
});
const TokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
});
const IdentitySchema = z.object({ email: z.string().email(), email_verified: z.literal(true) });
const ListInputSchema = z
  .object({
    after: z.string().datetime({ offset: true }),
    before: z.string().datetime({ offset: true }),
    pageToken: z.string().min(1).optional(),
  })
  .refine((value) => Date.parse(value.after) < Date.parse(value.before));
const ReplyInputSchema = z.object({
  threadName: z.string(),
  text: z.string().min(1).max(32000),
  messageId: z
    .string()
    .regex(/^client-[a-z0-9-]+$/)
    .max(63),
  requestId: z.string().uuid(),
});

/**
 * @param config SecretProvider から検証済みの単一接続設定
 * @returns 設定 space と認証アカウントに固定したクライアント
 * @throws GoogleChatError 各メソッドで通信・認証・応答検証に失敗した場合
 */
export function createGoogleChatClient(config: GoogleChatConfig): GoogleChatClient {
  let token: { value: string; expiresAt: number } | undefined;
  let refreshPromise: Promise<string> | undefined;

  async function refreshToken(): Promise<string> {
    const payload = await requestJson(
      TOKEN_URL,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.credentials.clientId,
          client_secret: config.credentials.clientSecret,
          refresh_token: config.credentials.refreshToken,
        }),
      },
      true,
    );
    const parsed = TokenSchema.safeParse(payload);
    if (!parsed.success) throw new GoogleChatError("invalid_response");
    const identity = IdentitySchema.safeParse(
      await requestJson(USERINFO_URL, {
        headers: { Authorization: `Bearer ${parsed.data.access_token}` },
      }),
    );
    if (!identity.success) throw new GoogleChatError("invalid_response");
    if (identity.data.email.toLowerCase() !== config.accountEmail.toLowerCase()) {
      throw new GoogleChatError("account_mismatch");
    }
    token = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    };
    return token.value;
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + TOKEN_MARGIN_MS) return token.value;
    if (!refreshPromise) {
      refreshPromise = refreshToken().finally(() => {
        refreshPromise = undefined;
      });
    }
    return refreshPromise;
  }

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const access = await accessToken();
    try {
      return await requestJson(`${API_URL}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      });
    } catch (error) {
      if (error instanceof GoogleChatError && error.code === "auth_revoked") token = undefined;
      throw error;
    }
  }

  function validateResource(name: string, kind: "messages" | "threads"): void {
    const prefix = `${config.spaceName}/${kind}/`;
    if (
      !name.startsWith(prefix) ||
      !ResourceSegmentSchema.safeParse(name.slice(prefix.length)).success
    ) {
      throw new GoogleChatError("resource_mismatch");
    }
  }

  function normalize(payload: unknown): GoogleChatMessage {
    const parsed = RawMessageSchema.safeParse(payload);
    if (!parsed.success) throw new GoogleChatError("invalid_response");
    const message = parsed.data;
    if (message.space && message.space.name !== config.spaceName) {
      throw new GoogleChatError("resource_mismatch");
    }
    validateResource(message.name, "messages");
    validateResource(message.thread.name, "threads");
    return {
      name: message.name,
      threadName: message.thread.name,
      createTime: message.createTime,
      text: message.text,
      senderName:
        config.credentials.senderNames?.[message.sender.name] ||
        message.sender.displayName ||
        message.sender.name,
      senderId: message.sender.name,
      ...(message.clientAssignedMessageId
        ? { clientAssignedMessageId: message.clientAssignedMessageId }
        : {}),
    };
  }

  return {
    async listMessages(input) {
      const parsed = ListInputSchema.safeParse(input);
      if (!parsed.success) throw new GoogleChatError("invalid_input");
      const query = new URLSearchParams({
        filter: `createTime > "${parsed.data.after}" AND createTime < "${parsed.data.before}"`,
        orderBy: "createTime ASC",
        pageSize: "100",
      });
      if (parsed.data.pageToken) query.set("pageToken", parsed.data.pageToken);
      const payload = ListSchema.safeParse(await api(`${config.spaceName}/messages?${query}`));
      if (!payload.success) throw new GoogleChatError("invalid_response");
      return {
        messages: payload.data.messages.map(normalize),
        ...(payload.data.nextPageToken ? { nextPageToken: payload.data.nextPageToken } : {}),
      };
    },
    async createReply(input) {
      const parsed = ReplyInputSchema.safeParse(input);
      if (!parsed.success) throw new GoogleChatError("invalid_input");
      validateResource(parsed.data.threadName, "threads");
      const query = new URLSearchParams({
        messageReplyOption: "REPLY_MESSAGE_OR_FAIL",
        messageId: parsed.data.messageId,
        requestId: parsed.data.requestId,
      });
      // 成否不明でも再送しない。永続化した custom ID による照合は呼び出し元が行う。
      const message = normalize(
        await api(`${config.spaceName}/messages?${query}`, {
          method: "POST",
          body: JSON.stringify({
            text: parsed.data.text,
            thread: { name: parsed.data.threadName },
          }),
        }),
      );
      if (
        message.threadName !== parsed.data.threadName ||
        message.text !== parsed.data.text ||
        (message.clientAssignedMessageId &&
          message.clientAssignedMessageId !== parsed.data.messageId)
      ) {
        throw new GoogleChatError("resource_mismatch");
      }
      return message;
    },
    async getMessage(messageId) {
      const name = messageId.startsWith("spaces/")
        ? messageId
        : `${config.spaceName}/messages/${messageId}`;
      validateResource(name, "messages");
      try {
        const message = normalize(await api(name));
        const requestedId = name.slice(`${config.spaceName}/messages/`.length);
        if (requestedId.startsWith("client-")) {
          if (message.clientAssignedMessageId !== requestedId)
            throw new GoogleChatError("resource_mismatch");
        } else if (message.name !== name) throw new GoogleChatError("resource_mismatch");
        return message;
      } catch (error) {
        if (error instanceof GoogleChatError && error.code === "not_found") return undefined;
        throw error;
      }
    },
  };
}

async function requestJson(url: string, init: RequestInit, oauth = false): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      // error_description や本文は保持しない。OAuth の失効コードだけを分類する。
      if (oauth && response.status === 400) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new GoogleChatError("invalid_response", 400);
        }
        const revoked = z
          .object({ error: z.enum(["invalid_grant", "invalid_client", "unauthorized_client"]) })
          .safeParse(payload);
        if (revoked.success) throw new GoogleChatError("auth_revoked", 400);
      }
      throw statusError(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new GoogleChatError("invalid_response");
    }
  } catch (error) {
    if (error instanceof GoogleChatError) throw error;
    throw new GoogleChatError("unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function statusError(status: number): GoogleChatError {
  if (status === 401) return new GoogleChatError("auth_revoked", status);
  if (status === 403) return new GoogleChatError("forbidden", status);
  if (status === 404) return new GoogleChatError("not_found", status);
  if (status === 409) return new GoogleChatError("conflict", status);
  if (status === 429) return new GoogleChatError("rate_limited", status);
  if (status >= 500) return new GoogleChatError("unavailable", status);
  return new GoogleChatError("invalid_input", status);
}
