import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(
    normalized,
  );
}

export function normalizeOrigin(origin: string): string {
  const value = origin.trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.origin === "null" ? value : parsed.origin;
  } catch {
    return value;
  }
}

/** Non-browser clients (no Origin) pass; browsers must come from loopback or an allow-listed origin */
export function isBrowserOriginAllowed(
  origin: string | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (allowed.has(normalized)) return true;
  try {
    const parsed = new URL(normalized);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** `Authorization: Bearer <key>` (OpenAI / Claude Code) or `x-api-key: <key>` (Anthropic SDK) */
export function extractCredential(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  if (
    typeof authorization === "string" &&
    authorization.startsWith("Bearer ")
  ) {
    return authorization.slice("Bearer ".length);
  }
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : null;
}

export function isAuthorized(
  credential: string | null,
  expectedKey: string,
): boolean {
  if (!expectedKey) return true;
  if (credential === null) return false;
  const supplied = Buffer.from(credential, "utf8");
  const expected = Buffer.from(expectedKey, "utf8");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
