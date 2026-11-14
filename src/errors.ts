import { parseRetryAfterMs } from "./util/time.js";

export interface ProxyErrorOptions {
  status: number;
  type: string;
  retryAfterSec?: number;
  upstreamStatus?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Error that maps 1:1 to an HTTP response sent to the proxy client */
export class ProxyError extends Error {
  readonly status: number;
  readonly type: string;
  readonly retryAfterSec: number | undefined;
  readonly upstreamStatus: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(message: string, options: ProxyErrorOptions) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ProxyError";
    this.status = options.status;
    this.type = options.type;
    this.retryAfterSec = options.retryAfterSec;
    this.upstreamStatus = options.upstreamStatus;
    this.details = options.details ?? {};
  }
}

/**
 * Builds the error for a non-2xx DeepSeek response. Upstream auth failures are
 * reported as 502 so clients do not confuse them with a bad proxy API key
 */
export function upstreamHttpError(
  status: number,
  body = "",
  retryAfter: string | null = null,
): ProxyError {
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  const authFailure = status === 401 || status === 403;
  const retryMs = status === 429 ? parseRetryAfterMs(retryAfter) : null;
  const clientStatus =
    authFailure || status < 400 || status > 599 ? 502 : status;
  return new ProxyError(
    `DeepSeek upstream HTTP ${status}${detail ? `: ${detail}` : ""}`,
    {
      status: clientStatus,
      type:
        status === 429
          ? "rate_limit_error"
          : authFailure
            ? "upstream_authentication_error"
            : "upstream_http_error",
      upstreamStatus: status,
      ...(retryMs === null ? {} : { retryAfterSec: Math.ceil(retryMs / 1000) }),
    },
  );
}

export function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timed?\s*out|timeout/i.test(message)
  );
}
