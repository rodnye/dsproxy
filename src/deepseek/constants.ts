import type { AuthData } from "../accounts/types.js";

export const DEEPSEEK_ORIGIN = "https://chat.deepseek.com";

export const ENDPOINTS = {
  powChallenge: "/api/v0/chat/create_pow_challenge",
  createSession: "/api/v0/chat_session/create",
  completion: "/api/v0/chat/completion",
} as const;

/** PoW module location. The hash changes with web deployments; `dsproxy auth` captures the current one */
export const DEFAULT_WASM_URL =
  "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

export const CLIENT_VERSION = "2.0.0";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface HeaderOptions {
  locale: string;
  userAgent: string;
}

/** Headers the DeepSeek web client sends on every API call */
export function buildRequestHeaders(
  auth: AuthData,
  options: HeaderOptions,
): Record<string, string> {
  const timezoneOffsetSec = -new Date().getTimezoneOffset() * 60;
  return {
    "User-Agent": options.userAgent,
    "x-client-platform": "web",
    "x-client-version": CLIENT_VERSION,
    "x-client-locale": options.locale,
    "x-client-timezone-offset": String(timezoneOffsetSec),
    "x-app-version": CLIENT_VERSION,
    Authorization: `Bearer ${auth.token}`,
    "x-hif-dliq": auth.hifDliq,
    "x-hif-leim": auth.hifLeim,
    Origin: DEEPSEEK_ORIGIN,
    Referer: `${DEEPSEEK_ORIGIN}/`,
    Cookie: auth.cookie,
    "Content-Type": "application/json",
  };
}
