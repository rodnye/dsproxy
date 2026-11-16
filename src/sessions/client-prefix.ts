import { createHash } from "node:crypto";
import type { ChatMessage, ToolDefinition } from "../types.js";

/**
 * What the chained remote chat already holds from a stateless client (one that
 * resends its whole history every turn): the first `messageCount` messages of
 * the last request, plus the assistant reply DeepSeek produced for them
 */
export interface ClientPrefix {
  /** Remote chat the prefix lives in; stale once the session id changes */
  sessionId: string;
  messageCount: number;
  hash: string;
}

/** Stable hash of the messages (and tool definitions, which shape the system prompt) */
export function fingerprintMessages(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
): string {
  const canonical = messages.map((message) => [
    message.role,
    message.content,
    message.toolCallId ?? null,
    (message.toolCalls ?? []).map((call) => [call.name, call.arguments]),
  ]);
  return createHash("sha256")
    .update(JSON.stringify([canonical, tools]))
    .digest("hex");
}

export function recordClientPrefix(
  sessionId: string,
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
): ClientPrefix {
  return {
    sessionId,
    messageCount: messages.length,
    hash: fingerprintMessages(messages, tools),
  };
}

/**
 * Messages the remote chat has not seen yet, or null when the request does not
 * extend what was sent before (edited / retried / compacted history, new tools,
 * a different remote chat). The client's copy of our previous reply is skipped:
 * the remote chat already contains the original
 */
export function newMessagesSince(
  prefix: ClientPrefix | null,
  sessionId: string | null,
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
): ChatMessage[] | null {
  if (!prefix || sessionId === null || prefix.sessionId !== sessionId)
    return null;
  const { messageCount } = prefix;
  if (messages.length <= messageCount + 1) return null;
  if (messages[messageCount]?.role !== "assistant") return null;
  if (
    fingerprintMessages(messages.slice(0, messageCount), tools) !== prefix.hash
  )
    return null;
  const delta = messages.slice(messageCount + 1);
  // A changed system prompt cannot be applied to an existing chat
  if (delta.some((message) => message.role === "system")) return null;
  return delta;
}
