import { isRecord } from "../util/json.js";

/** Flattens any protocol's message content (string, parts, blocks) into plain text */
export function normalizeContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(normalizePart).filter(Boolean).join("\n");
  if (isRecord(content)) return normalizePart(content);
  return String(content);
}

function normalizePart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  switch (part.type) {
    case "text":
    case "input_text":
    case "output_text":
      return typeof part.text === "string" ? part.text : "";
    case "tool_result": {
      const id =
        typeof part.tool_use_id === "string" ? ` ${part.tool_use_id}` : "";
      return `[Tool Result${id}]\n${normalizeContent(part.content)}`;
    }
    case "image":
    case "image_url":
    case "input_image":
      // Never inline base64 payloads into the prompt
      return "[image omitted: images are not supported]";
    default:
      // Unknown blocks (e.g. Anthropic "thinking") are dropped; plain `text` is kept
      return typeof part.text === "string" ? part.text : "";
  }
}
