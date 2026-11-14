import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_USER_AGENT } from "./deepseek/constants.js";
import { normalizeOrigin } from "./http/security.js";

type Env = Record<string, string | undefined>;

export interface UpstreamConfig {
  fetchTimeoutMs: number;
  completionTimeoutMs: number;
  locale: string;
  userAgent: string;
}

export interface Config {
  logLevel: string;
  server: {
    host: string;
    port: number;
    apiKey: string;
    requireApiKey: boolean;
    corsOrigins: ReadonlySet<string>;
    maxBodyBytes: number;
    maxConcurrent: number;
    requestDeadlineMs: number;
  };
  accounts: {
    authPaths: string[];
    authDir: string | null;
    cooldownMs: number;
  };
  upstream: UpstreamConfig;
  prompt: {
    maxChars: number;
    minChars: number;
    maxEmptyRetries: number;
    maxContinuations: number;
  };
  sessions: {
    ttlMs: number;
    maxMessageDepth: number;
    maxHistoryLength: number;
    maxHistoryChars: number;
  };
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readFlag(env: Env, name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[name] ?? "");
}

function readApiKey(env: Env): string {
  if (env.DSPROXY_API_KEY) return env.DSPROXY_API_KEY;
  const secretPath = env.DSPROXY_API_KEY_FILE?.trim();
  if (!secretPath) return "";
  try {
    return readFileSync(secretPath, "utf8").trim();
  } catch (error) {
    // A missing optional secret equals an unset key; `serve` fails closed
    // when DSPROXY_REQUIRE_API_KEY=1
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(
      `Could not read DSPROXY_API_KEY_FILE (${secretPath}): ${(error as Error).message}`,
    );
  }
}

export function loadConfig(env: Env = process.env): Config {
  const cwd = process.cwd();
  const authPathList = env.DSPROXY_AUTH_PATH?.trim() || "deepseek-auth.json";
  const authDir = env.DSPROXY_AUTH_DIR?.trim();

  return {
    logLevel: env.DSPROXY_LOG_LEVEL?.trim() || "info",
    server: {
      host: env.DSPROXY_HOST?.trim() || "127.0.0.1",
      port: readInt(env, "DSPROXY_PORT", 9655, 1, 65535),
      apiKey: readApiKey(env),
      requireApiKey: readFlag(env, "DSPROXY_REQUIRE_API_KEY"),
      corsOrigins: new Set(
        (env.DSPROXY_CORS_ORIGINS ?? "")
          .split(",")
          .map((origin) => normalizeOrigin(origin))
          .filter(Boolean),
      ),
      maxBodyBytes: 10 * 1024 * 1024,
      maxConcurrent: readInt(env, "DSPROXY_MAX_CONCURRENT", 24, 1, 1024),
      requestDeadlineMs: readInt(
        env,
        "DSPROXY_REQUEST_DEADLINE_MS",
        120_000,
        1000,
        3_600_000,
      ),
    },
    accounts: {
      authPaths: authPathList
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => path.resolve(cwd, entry)),
      authDir: authDir ? path.resolve(cwd, authDir) : null,
      cooldownMs: readInt(
        env,
        "DSPROXY_ACCOUNT_COOLDOWN_MS",
        600_000,
        1000,
        86_400_000,
      ),
    },
    upstream: {
      fetchTimeoutMs: readInt(
        env,
        "DSPROXY_FETCH_TIMEOUT_MS",
        30_000,
        1000,
        600_000,
      ),
      completionTimeoutMs: readInt(
        env,
        "DSPROXY_COMPLETION_TIMEOUT_MS",
        120_000,
        1000,
        1_800_000,
      ),
      locale: env.DSPROXY_LOCALE?.trim() || "en",
      userAgent: env.DSPROXY_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    },
    prompt: {
      maxChars: Math.max(
        16_000,
        readInt(env, "DSPROXY_MAX_PROMPT_CHARS", 80_000, 1000, 10_000_000),
      ),
      minChars: 16_000,
      maxEmptyRetries: readInt(env, "DSPROXY_MAX_RETRIES", 2, 0, 10),
      maxContinuations: 2,
    },
    sessions: {
      ttlMs: 2 * 60 * 60 * 1000,
      maxMessageDepth: 100,
      maxHistoryLength: 15,
      maxHistoryChars: 10_000,
    },
  };
}
