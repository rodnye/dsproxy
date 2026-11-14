import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DEFAULT_WASM_URL } from "../deepseek/constants.js";
import { isRecord, type JsonObject } from "../util/json.js";
import type { AuthData } from "./types.js";

const asText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function cookieHeaderFromExport(cookies: unknown[]): string {
  return cookies
    .filter(isRecord)
    .filter(
      (cookie) =>
        asText(cookie.name) &&
        asText(cookie.value) &&
        /deepseek/i.test(asText(cookie.domain)),
    )
    .map((cookie) => `${asText(cookie.name)}=${asText(cookie.value)}`)
    .join("; ");
}

function extractCookie(source: JsonObject): string {
  if (Array.isArray(source.cookies))
    return cookieHeaderFromExport(source.cookies);
  if (typeof source.cookie === "string") return source.cookie.trim();
  if (typeof source.cookies === "string") return source.cookies.trim();
  return "";
}

/**
 * Accepts the canonical auth file (`deepseek-auth.json`) or a browser cookie
 * export (array of cookies). `fallback` fills fields the input does not carry
 */
export function normalizeAuth(
  input: unknown,
  fallback: Partial<AuthData> = {},
): AuthData {
  const source: JsonObject = Array.isArray(input)
    ? { cookies: input }
    : isRecord(input)
      ? input
      : {};
  const rawToken =
    asText(source.token) ||
    asText(source.access_token) ||
    asText(source.accessToken) ||
    asText(source.auth_token) ||
    fallback.token ||
    "";
  return {
    token: rawToken.replace(/^Bearer\s+/i, ""),
    cookie: extractCookie(source) || fallback.cookie || "",
    hifDliq:
      asText(source.hif_dliq) ||
      asText(source["x-hif-dliq"]) ||
      fallback.hifDliq ||
      "",
    hifLeim:
      asText(source.hif_leim) ||
      asText(source["x-hif-leim"]) ||
      fallback.hifLeim ||
      "",
    wasmUrl:
      asText(source.wasmUrl) ||
      asText(source.wasm_url) ||
      fallback.wasmUrl ||
      DEFAULT_WASM_URL,
  };
}

export function validateAuth(auth: AuthData): string[] {
  const problems: string[] = [];
  if (!auth.token) problems.push("token missing");
  if (!auth.cookie) problems.push("cookie missing");
  if (!auth.wasmUrl) problems.push("wasmUrl missing");
  return problems;
}

/** On-disk shape; kept compatible with existing deepseek-auth.json files */
export function serializeAuth(auth: AuthData): JsonObject {
  return {
    token: auth.token,
    hif_dliq: auth.hifDliq,
    hif_leim: auth.hifLeim,
    cookie: auth.cookie,
    wasmUrl: auth.wasmUrl,
  };
}

export function readAuthFile(file: string): AuthData {
  return normalizeAuth(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

export function writeAuthFile(file: string, auth: AuthData): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(serializeAuth(auth), null, 2)}\n`, {
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

export function discoverAuthFiles(
  authPaths: readonly string[],
  authDir: string | null,
): string[] {
  if (authDir) {
    return readdirSync(authDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(authDir, name));
  }
  return [...authPaths];
}
