import type { ToolCall } from "../types.js";
import { isRecord } from "../util/json.js";

export const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
export const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;

const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

/** Validates name and arguments and serializes the arguments. Returns null when unusable */
export function buildToolCall(
  name: unknown,
  args: unknown = {},
): ToolCall | null {
  const toolName = typeof name === "string" ? name.trim() : "";
  if (!TOOL_NAME.test(toolName)) return null;

  let parsed = args;
  if (typeof parsed === "string") {
    if (parsed.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (!isRecord(parsed)) return null;

  const serialized = JSON.stringify(parsed);
  if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
  return { name: toolName, arguments: serialized };
}
