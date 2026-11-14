import type { ToolDefinition } from "../types.js";
import { isRecord, mapValues, type JsonObject } from "../util/json.js";

// Annotations dominate large agent tool payloads but do not affect validation
const ANNOTATION_KEYS = new Set([
  "description",
  "examples",
  "$comment",
  "title",
]);
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_SINGLE_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/**
 * Drops prose annotations from a JSON schema. Only keywords whose values are
 * themselves schemas are traversed: literal values under const/enum/default
 * must stay byte-for-byte intact, even if they contain "description" keys
 */
export function compactToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactToolSchema);
  if (!isRecord(value)) return value;
  const compact: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
      compact[key] = mapValues(child, compactToolSchema);
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      compact[key] = child.map(compactToolSchema);
    } else if (SCHEMA_SINGLE_KEYS.has(key)) {
      compact[key] = Array.isArray(child)
        ? child.map(compactToolSchema)
        : compactToolSchema(child);
    } else if (key === "dependencies" && isRecord(child)) {
      compact[key] = mapValues(child, (dependency) =>
        Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
      );
    } else {
      compact[key] = child;
    }
  }
  return compact;
}

function schemaLength(schema: unknown): number {
  try {
    return JSON.stringify(schema ?? {}).length;
  } catch {
    return 0;
  }
}

/** Text appended to the system prompt so DeepSeek (no native tool calling) emits parseable requests */
export function formatToolDefinitions(
  tools: readonly ToolDefinition[],
  maxPromptChars: number,
): string {
  if (tools.length === 0) return "";
  const rawChars = tools.reduce(
    (sum, tool) => sum + schemaLength(tool.parameters),
    0,
  );
  const compact = rawChars > Math.floor(maxPromptChars * 0.4);

  const lines: string[] = [
    "",
    "",
    "--- TOOL REQUEST SYSTEM ---",
    "You can REQUEST tool executions. You never execute anything yourself.",
    "To use a tool, reply with exactly one JSON object and nothing else:",
    '{"tool_call":{"name":"<function_name>","arguments":{...}}}',
    "",
    'The client executes the tool and sends the output back in a "[Tool Result]" message.',
    "",
    "RULES:",
    "1. When requesting a tool, output only the JSON request: no text before or after it.",
    "2. Never simulate, guess or fabricate tool output; wait for the real result.",
    "3. Request one tool per reply.",
    "4. Keep arguments compact; do not embed large file contents unless the schema requires it.",
    "",
    "Available functions:",
  ];
  for (const tool of tools) {
    const description = tool.description.replace(/\s+/g, " ").trim();
    lines.push(
      "",
      `## ${tool.name}`,
      description.length > 500
        ? `${description.slice(0, 497)}...`
        : description,
    );
    lines.push(
      `Parameters: ${JSON.stringify(compact ? compactToolSchema(tool.parameters) : tool.parameters)}`,
    );
  }
  lines.push(
    "",
    "--- END TOOL REQUEST SYSTEM ---",
    "",
    "REMEMBER: request tools only with the strict JSON format above.",
  );
  return lines.join("\n");
}
