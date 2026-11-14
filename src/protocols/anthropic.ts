import { normalizeContent } from "../prompt/content.js";
import type {
  AssistantTurn,
  ChatMessage,
  IdentifiedToolCall,
  ToolDefinition,
} from "../types.js";
import { isRecord, safeParseObject, type JsonObject } from "../util/json.js";
import { chunkText, startSse, writeSse } from "./sse.js";
import {
  firstString,
  invalidRequest,
  modelOf,
  requireBody,
  toToolDefinition,
} from "./shared.js";
import type { ProtocolAdapter } from "./types.js";

function convertMessage(raw: unknown): ChatMessage[] {
  const message = isRecord(raw) ? raw : {};
  const role = message.role === "assistant" ? "assistant" : "user";
  if (!Array.isArray(message.content))
    return [{ role, content: normalizeContent(message.content) }];

  const blocks: unknown[] = message.content;
  if (role === "assistant") {
    const toolCalls: IdentifiedToolCall[] = blocks
      .filter(isRecord)
      .filter(
        (block) => block.type === "tool_use" && typeof block.name === "string",
      )
      .map((block) => ({
        id: typeof block.id === "string" ? block.id : "",
        name: block.name as string,
        arguments: JSON.stringify(block.input ?? {}),
      }));
    const text = normalizeContent(
      blocks.filter((block) => !(isRecord(block) && block.type === "tool_use")),
    );
    return [
      { role, content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
    ];
  }

  // User turns may mix text with tool_result blocks; tool results become `tool` messages
  const out: ChatMessage[] = [];
  let pending: unknown[] = [];
  const flush = (): void => {
    if (pending.length > 0)
      out.push({ role: "user", content: normalizeContent(pending) });
    pending = [];
  };
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_result") {
      flush();
      out.push({
        role: "tool",
        content: normalizeContent(block.content),
        toolCallId:
          typeof block.tool_use_id === "string" ? block.tool_use_id : "",
      });
    } else {
      pending.push(block);
    }
  }
  flush();
  return out;
}

function parseTools(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((tool) => {
    if (!isRecord(tool)) return [];
    const definition = toToolDefinition(
      tool.name,
      tool.description,
      tool.input_schema ?? tool.parameters,
    );
    return definition ? [definition] : [];
  });
}

function stopReason(turn: AssistantTurn): string {
  if (turn.finishReason === "tool_calls") return "tool_use";
  return turn.finishReason === "length" ? "max_tokens" : "end_turn";
}

function buildMessage(turn: AssistantTurn): JsonObject {
  const content = turn.toolCall
    ? [
        {
          type: "tool_use",
          id: turn.toolCall.id,
          name: turn.toolCall.name,
          input: safeParseObject(turn.toolCall.arguments),
        },
      ]
    : [{ type: "text", text: turn.content }];
  return {
    id: `msg_${turn.id}`,
    type: "message",
    role: "assistant",
    model: turn.model,
    content,
    stop_reason: stopReason(turn),
    stop_sequence: null,
    usage: {
      input_tokens: turn.usage.promptTokens,
      output_tokens: turn.usage.completionTokens,
    },
  };
}

// Reasoning is intentionally omitted: Anthropic "thinking" blocks require signatures,
// and mixing reasoning into text blocks makes agents treat tool turns as plain answers
export const anthropicAdapter: ProtocolAdapter = {
  name: "anthropic",

  parseRequest(body) {
    const data = requireBody(body);
    if (!Array.isArray(data.messages))
      throw invalidRequest('"messages" must be an array');
    const messages: ChatMessage[] = [];
    const system = normalizeContent(data.system);
    if (system) messages.push({ role: "system", content: system });
    for (const raw of data.messages) messages.push(...convertMessage(raw));
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    return {
      model: modelOf(data.model),
      messages,
      tools: parseTools(data.tools),
      stream: data.stream === true,
      sessionKey: firstString(metadata.user_id, data.user),
    };
  },

  buildResponse: buildMessage,

  writeStream(res, turn) {
    startSse(res);
    const message = buildMessage(turn);
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: turn.usage.promptTokens, output_tokens: 0 },
      },
    });

    if (turn.toolCall) {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: turn.toolCall.id,
          name: turn.toolCall.name,
          input: {},
        },
      });
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: turn.toolCall.arguments || "{}",
        },
      });
    } else {
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      for (const chunk of chunkText(turn.content, 80)) {
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk },
        });
      }
    }
    writeSse(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });
    writeSse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason(turn), stop_sequence: null },
      usage: { output_tokens: turn.usage.completionTokens },
    });
    writeSse(res, "message_stop", { type: "message_stop" });
    res.end();
  },
};
