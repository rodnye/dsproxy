export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function safeParseObject(text: string | null | undefined): JsonObject {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mapValues(
  source: JsonObject,
  fn: (value: unknown) => unknown,
): JsonObject {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, fn(value)]),
  );
}
