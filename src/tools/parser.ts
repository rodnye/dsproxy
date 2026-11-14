import type { ToolCall } from "../types.js";
import { isRecord } from "../util/json.js";
import { DSML_MARKER, parseDsmlToolCall } from "./dsml.js";
import {
  extractBalancedJsonAt,
  extractBalancedJsonObjects,
} from "./json-extract.js";
import { buildToolCall, MAX_TOOL_MARKUP_CHARS } from "./tool-call.js";

const LOOKS_LIKE_TOOL_CALL =
  /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i;

export function looksLikeToolCallMarkup(text: string): boolean {
  return LOOKS_LIKE_TOOL_CALL.test(text) || DSML_MARKER.test(text);
}

/** Accepts only explicit envelopes unless `allowBare` (used for <tool_call> wrappers). */
function coerceEnvelope(value: unknown, allowBare = false): ToolCall | null {
  if (!isRecord(value)) return null;
  let candidate: unknown;
  if (Object.hasOwn(value, "tool_call")) {
    candidate = value.tool_call;
  } else if (Object.hasOwn(value, "function_call")) {
    candidate = value.function_call;
  } else if (Object.hasOwn(value, "tool_calls")) {
    if (!Array.isArray(value.tool_calls) || value.tool_calls.length !== 1)
      return null;
    candidate = value.tool_calls[0];
  } else if (allowBare) {
    candidate = value;
  }
  if (!isRecord(candidate)) return null;
  const fn = isRecord(candidate.function) ? candidate.function : candidate;
  return buildToolCall(
    fn.name ?? candidate.name,
    fn.arguments ?? candidate.arguments ?? candidate.input ?? {},
  );
}

function parseJsonCandidate(raw: string, allowBare = false): ToolCall | null {
  try {
    return coerceEnvelope(JSON.parse(raw) as unknown, allowBare);
  } catch {
    return null;
  }
}

/**
 * Extracts a tool call from model text. Supported, in priority order:
 *  1. DeepSeek DSML markup (complete only)
 *  2. <tool_call>{...}</tool_call>
 *  3. fenced JSON with an explicit tool_call / tool_calls / function_call envelope
 *  4. legacy `TOOL_CALL: name` followed by a JSON object
 *  5. an inline JSON envelope
 * Bare `{name, arguments}` examples in prose are never executable.
 */
export function parseToolCall(text: string): ToolCall | null {
  if (!text || text.length > MAX_TOOL_MARKUP_CHARS) return null;

  if (DSML_MARKER.test(text)) return parseDsmlToolCall(text);

  const xml = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
  if (xml) {
    const call = parseJsonCandidate((xml[1] as string).trim(), true);
    if (call) return call;
  }

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    const call = parseJsonCandidate((match[1] as string).trim());
    if (call) return call;
  }

  const legacy = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
  if (legacy) {
    const rest = text.slice((legacy.index ?? 0) + legacy[0].length);
    const braceIndex = rest.indexOf("{");
    const rawJson =
      braceIndex === -1 ? null : extractBalancedJsonAt(rest, braceIndex);
    if (rawJson) {
      try {
        const call = buildToolCall(legacy[1], JSON.parse(rawJson) as unknown);
        if (call) return call;
      } catch {
        // fall through to the inline scan
      }
    }
  }

  for (const raw of extractBalancedJsonObjects(text)) {
    const call = parseJsonCandidate(raw);
    if (call) return call;
  }
  return null;
}
