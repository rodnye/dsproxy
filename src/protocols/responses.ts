import { normalizeContent } from "../prompt/content.js";
import type {
  AssistantTurn,
  ChatMessage,
  Role,
  ToolDefinition,
} from "../types.js";
import { isRecord, type JsonObject } from "../util/json.js";
import { chunkText, startSse, writeSse } from "./sse.js";
import {
  firstString,
  modelOf,
  requireBody,
  serializeArguments,
  toToolDefinition,
} from "./shared.js";
import type { ProtocolAdapter } from "./types.js";

function mapRole(role: unknown): Role {
  if (role === "assistant" || role === "system") return role;
  if (role === "developer") return "system";
  return "user";
}

function parseInput(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages: ChatMessage[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        content:
          typeof item.output === "string"
            ? item.output
            : normalizeContent(item.output),
        toolCallId: typeof item.call_id === "string" ? item.call_id : "",
      });
    } else if (item.type === "function_call" && typeof item.name === "string") {
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: typeof item.call_id === "string" ? item.call_id : "",
            name: item.name,
            arguments: serializeArguments(item.arguments),
          },
        ],
      });
    } else if (item.type === "message" || item.role !== undefined) {
      messages.push({
        role: mapRole(item.role),
        content: normalizeContent(item.content),
      });
    } else if (item.type === "input_text" && typeof item.text === "string") {
      messages.push({ role: "user", content: item.text });
    }
  }
  return messages;
}

function parseTools(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((tool) => {
    if (!isRecord(tool) || tool.type !== "function") return [];
    const source = isRecord(tool.function) ? tool.function : tool;
    const definition = toToolDefinition(
      source.name,
      source.description,
      source.parameters,
    );
    return definition ? [definition] : [];
  });
}

function buildOutput(turn: AssistantTurn): JsonObject[] {
  const output: JsonObject[] = [];
  if (turn.toolCall) {
    output.push({
      type: "function_call",
      id: `fc_${turn.toolCall.id}`,
      call_id: turn.toolCall.id,
      name: turn.toolCall.name,
      arguments: turn.toolCall.arguments || "{}",
    });
    return output;
  }
  if (turn.reasoning) {
    output.push({
      id: `rs_${turn.id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: turn.reasoning }],
    });
  }
  output.push({
    id: `msg_${turn.id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: turn.content, annotations: [] }],
  });
  return output;
}

function buildResponseObject(turn: AssistantTurn): JsonObject {
  return {
    id: `resp_${turn.id}`,
    object: "response",
    created_at: turn.created,
    status: "completed",
    model: turn.model,
    output: buildOutput(turn),
    output_text: turn.toolCall ? "" : turn.content,
    usage: {
      input_tokens: turn.usage.promptTokens,
      output_tokens: turn.usage.completionTokens,
      total_tokens: turn.usage.totalTokens,
      output_tokens_details: { reasoning_tokens: turn.usage.reasoningTokens },
    },
  };
}

export const responsesAdapter: ProtocolAdapter = {
  name: "responses",

  parseRequest(body) {
    const data = requireBody(body);
    const messages = parseInput(data.input);
    if (typeof data.instructions === "string" && data.instructions) {
      messages.unshift({ role: "system", content: data.instructions });
    }
    return {
      model: modelOf(data.model),
      messages,
      tools: parseTools(data.tools),
      stream: data.stream === true,
      sessionKey: firstString(data.user),
    };
  },

  buildResponse: buildResponseObject,

  writeStream(res, turn) {
    startSse(res);
    const response = buildResponseObject(turn);
    const pending = { ...response, status: "in_progress", output: [] };
    writeSse(res, "response.created", {
      type: "response.created",
      response: pending,
    });
    writeSse(res, "response.in_progress", {
      type: "response.in_progress",
      response: pending,
    });

    buildOutput(turn).forEach((item, index) => {
      const inProgress = { ...item, status: "in_progress" };
      if (item.type === "function_call") {
        const args = String(item.arguments);
        writeSse(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: { ...inProgress, arguments: "" },
        });
        writeSse(res, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          output_index: index,
          item_id: item.id,
          delta: args,
        });
        writeSse(res, "response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          output_index: index,
          item_id: item.id,
          arguments: args,
        });
        writeSse(res, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item: { ...item, status: "completed" },
        });
      } else if (item.type === "reasoning") {
        writeSse(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: { ...inProgress, summary: [] },
        });
        writeSse(res, "response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          output_index: index,
          summary_index: 0,
          delta: turn.reasoning,
        });
        writeSse(res, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item: { ...item, status: "completed" },
        });
      } else {
        writeSse(res, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: { ...inProgress, content: [] },
        });
        writeSse(res, "response.content_part.added", {
          type: "response.content_part.added",
          output_index: index,
          content_index: 0,
          item_id: item.id,
          part: { type: "output_text", text: "", annotations: [] },
        });
        for (const chunk of chunkText(turn.content, 80)) {
          writeSse(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: index,
            content_index: 0,
            item_id: item.id,
            delta: chunk,
          });
        }
        writeSse(res, "response.output_text.done", {
          type: "response.output_text.done",
          output_index: index,
          content_index: 0,
          item_id: item.id,
          text: turn.content,
        });
        writeSse(res, "response.content_part.done", {
          type: "response.content_part.done",
          output_index: index,
          content_index: 0,
          item_id: item.id,
          part: { type: "output_text", text: turn.content, annotations: [] },
        });
        writeSse(res, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item: { ...item, status: "completed" },
        });
      }
    });

    writeSse(res, "response.completed", {
      type: "response.completed",
      response,
    });
    res.write("data: [DONE]\n\n");
    res.end();
  },
};
