import type { ChatMessage, ToolCall, ToolDefinition } from "../types.js";
import { safeParseObject } from "../util/json.js";
import { formatToolDefinitions } from "./tools.js";

/** Canonical JSON envelope the model is asked to emit (and which is replayed in history) */
export function formatToolCallEnvelope(call: ToolCall): string {
  return JSON.stringify({
    tool_call: { name: call.name, arguments: safeParseObject(call.arguments) },
  });
}

/** True when the client already sent multi-turn history (so local recovery history would duplicate it) */
export function hasExplicitHistory(messages: readonly ChatMessage[]): boolean {
  const turns = messages.filter((message) => message.role !== "system");
  return (
    turns.length > 1 ||
    turns.some(
      (message) => message.role === "assistant" || message.role === "tool",
    )
  );
}

export function formatConversation(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  maxPromptChars: number,
): { systemPrompt: string; conversation: string } {
  const systemParts = messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => m.content);
  const systemPrompt =
    `${systemParts.join("\n")}${formatToolDefinitions(tools, maxPromptChars)}`.trim();

  let conversation = "";
  for (const message of messages) {
    if (message.role === "user" && message.content) {
      conversation += `User: ${message.content}\n\n`;
    } else if (message.role === "assistant") {
      if (message.content) conversation += `Assistant: ${message.content}\n\n`;
      for (const call of message.toolCalls ?? []) {
        conversation += `Assistant: ${formatToolCallEnvelope(call)}\n\n`;
      }
    } else if (message.role === "tool" && message.content) {
      // No per-result cap: one large result may be the essential input. The single
      // global cap in buildBoundedPrompt keeps the latest tail
      const id = message.toolCallId ? ` ${message.toolCallId}` : "";
      conversation += `[Tool Result${id}]\n${message.content}\n\n`;
    }
  }
  return { systemPrompt, conversation: conversation.trim() };
}
