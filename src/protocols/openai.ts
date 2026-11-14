import { normalizeContent } from "../prompt/content.js";
import type {
  AssistantTurn,
  ChatMessage,
  IdentifiedToolCall,
  Role,
  ToolDefinition,
} from "../types.js";
import { isRecord } from "../util/json.js";
import { chunkText, startSse, writeSse } from "./sse.js";
import {
  firstString,
  invalidRequest,
  modelOf,
  requireBody,
  serializeArguments,
  toToolDefinition,
} from "./shared.js";
import type { ProtocolAdapter } from "./types.js";

function mapRole(role: unknown): Role {
  if (role === "assistant" || role === "tool" || role === "system") return role;
  if (role === "developer") return "system";
  return "user";
}

function parseToolCalls(raw: unknown): IdentifiedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: IdentifiedToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isRecord(entry.function)) continue;
    const name = entry.function.name;
    if (typeof name !== "string" || !name) continue;
    calls.push({
      id: typeof entry.id === "string" ? entry.id : "",
      name,
      arguments: serializeArguments(entry.function.arguments),
    });
  }
  return calls;
}

function toChatMessage(raw: unknown): ChatMessage {
  const message = isRecord(raw) ? raw : {};
  const toolCalls = parseToolCalls(message.tool_calls);
  return {
    role: mapRole(message.role),
    content: normalizeContent(message.content),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(typeof message.tool_call_id === "string"
      ? { toolCallId: message.tool_call_id }
      : {}),
  };
}

function parseTools(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function))
      return [];
    const definition = toToolDefinition(
      tool.function.name,
      tool.function.description,
      tool.function.parameters,
    );
    return definition ? [definition] : [];
  });
}

export const openaiAdapter: ProtocolAdapter = {
  name: "openai",

  parseRequest(body) {
    const data = requireBody(body);
    if (!Array.isArray(data.messages))
      throw invalidRequest('"messages" must be an array');
    return {
      model: modelOf(data.model),
      messages: data.messages.map(toChatMessage),
      tools: parseTools(data.tools),
      stream: data.stream === true,
      sessionKey: firstString(data.session, data.user),
    };
  },

  buildResponse(turn) {
    const message = turn.toolCall
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: turn.toolCall.id,
              type: "function",
              function: {
                name: turn.toolCall.name,
                arguments: turn.toolCall.arguments,
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: turn.content,
          ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
        };
    return {
      id: `chatcmpl-${turn.id}`,
      object: "chat.completion",
      created: turn.created,
      model: turn.model,
      choices: [{ index: 0, message, finish_reason: turn.finishReason }],
      usage: {
        prompt_tokens: turn.usage.promptTokens,
        completion_tokens: turn.usage.completionTokens,
        total_tokens: turn.usage.totalTokens,
        completion_tokens_details: {
          reasoning_tokens: turn.usage.reasoningTokens,
        },
      },
    };
  },

  writeStream(res, turn: AssistantTurn) {
    startSse(res);
    const base = {
      id: `chatcmpl-${turn.id}`,
      object: "chat.completion.chunk",
      created: turn.created,
      model: turn.model,
    };
    const emit = (
      delta: Record<string, unknown>,
      finishReason: string | null,
    ): void =>
      writeSse(res, null, {
        ...base,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

    if (turn.toolCall) {
      emit(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: turn.toolCall.id,
              type: "function",
              function: {
                name: turn.toolCall.name,
                arguments: turn.toolCall.arguments,
              },
            },
          ],
        },
        null,
      );
      emit({}, "tool_calls");
    } else {
      emit({ role: "assistant", content: "" }, null);
      for (const chunk of chunkText(turn.reasoning, 50))
        emit({ reasoning_content: chunk }, null);
      for (const chunk of chunkText(turn.content, 50))
        emit({ content: chunk }, null);
      emit({}, turn.finishReason);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  },
};
