import { DEFAULT_MODEL_ID } from "../deepseek/models.js";
import { ProxyError } from "../errors.js";
import type { ToolDefinition } from "../types.js";
import { isRecord, type JsonObject } from "../util/json.js";

export function invalidRequest(message: string): ProxyError {
  return new ProxyError(message, {
    status: 400,
    type: "invalid_request_error",
  });
}

export function requireBody(body: unknown): JsonObject {
  if (!isRecord(body))
    throw invalidRequest("Request body must be a JSON object");
  return body;
}

export function modelOf(raw: unknown): string {
  return typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase()
    : DEFAULT_MODEL_ID;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function toToolDefinition(
  name: unknown,
  description: unknown,
  parameters: unknown,
): ToolDefinition | null {
  if (typeof name !== "string" || !name) return null;
  return {
    name,
    description: typeof description === "string" ? description : "",
    parameters: isRecord(parameters)
      ? parameters
      : { type: "object", properties: {} },
  };
}

/** Tool-call arguments as a JSON string, whatever shape the client sent */
export function serializeArguments(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}
