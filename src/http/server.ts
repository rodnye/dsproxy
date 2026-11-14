import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AccountPool } from "../accounts/account-pool.js";
import type { Config } from "../config.js";
import { listModels } from "../deepseek/models.js";
import { isTimeoutError, ProxyError } from "../errors.js";
import { createLogger } from "../logger.js";
import { anthropicAdapter } from "../protocols/anthropic.js";
import { openaiAdapter } from "../protocols/openai.js";
import { responsesAdapter } from "../protocols/responses.js";
import type { ProtocolAdapter } from "../protocols/types.js";
import type { CompletionService } from "../services/completion-service.js";
import type { SessionStore } from "../sessions/session-store.js";
import { readJsonBody } from "./body.js";
import {
  extractCredential,
  isAuthorized,
  isBrowserOriginAllowed,
  isLoopbackHost,
  normalizeOrigin,
} from "./security.js";

export const COMPACTED_HEADER = "X-Dsproxy-Context-Compacted";

const ADAPTERS: Record<string, ProtocolAdapter> = {
  "/v1/chat/completions": openaiAdapter,
  "/v1/messages": anthropicAdapter,
  "/v1/responses": responsesAdapter,
};

export interface ServerDeps {
  config: Config;
  pool: AccountPool;
  sessions: SessionStore;
  service: CompletionService;
}

function errorBody(
  message: string,
  type: string,
  details: Record<string, unknown> = {},
): unknown {
  return { error: { message, type, ...details } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export function createProxyServer(deps: ServerDeps): http.Server {
  const { config, pool, sessions, service } = deps;
  const log = createLogger("http");
  let inFlight = 0;

  function applyCors(res: ServerResponse, origin: string | undefined): void {
    res.setHeader("Vary", "Origin");
    if (origin)
      res.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin));
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, x-agent-session, anthropic-version",
    );
    res.setHeader("Access-Control-Expose-Headers", COMPACTED_HEADER);
  }

  function resolveAgentId(
    req: IncomingMessage,
    sessionKey: string | undefined,
  ): string {
    const header = req.headers["x-agent-session"];
    const explicit =
      (typeof header === "string" && header.trim()) || sessionKey;
    if (explicit) return explicit;
    const remote = req.socket.remoteAddress ?? "unknown";
    return isLoopbackHost(remote) ? "default" : remote;
  }

  function handleFailure(
    res: ServerResponse,
    error: unknown,
    clientGone: boolean,
  ): void {
    if (clientGone || res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const proxyError =
      error instanceof ProxyError
        ? error
        : isTimeoutError(error)
          ? new ProxyError("Upstream request timed out", {
              status: 504,
              type: "request_timeout",
              cause: error,
            })
          : null;
    if (!proxyError) {
      log.error("Unhandled error:", error);
      sendJson(res, 500, errorBody("Internal server error", "server_error"));
      return;
    }
    if (proxyError.status >= 500)
      log.warn(`${proxyError.type}: ${proxyError.message}`);
    const headers: Record<string, string> = {};
    if (proxyError.retryAfterSec !== undefined)
      headers["Retry-After"] = String(proxyError.retryAfterSec);
    if (proxyError.status === 413) headers.Connection = "close";
    sendJson(
      res,
      proxyError.status,
      errorBody(proxyError.message, proxyError.type, proxyError.details),
      headers,
    );
  }

  async function handleCompletion(
    req: IncomingMessage,
    res: ServerResponse,
    adapter: ProtocolAdapter,
  ): Promise<void> {
    if (inFlight >= config.server.maxConcurrent) {
      sendJson(
        res,
        503,
        errorBody(
          `Server busy (${inFlight}/${config.server.maxConcurrent} requests in flight). Retry shortly.`,
          "overloaded",
        ),
        { "Retry-After": "2" },
      );
      return;
    }
    inFlight += 1;
    let clientGone = false;
    res.on("close", () => {
      if (!res.writableEnded) clientGone = true;
    });
    try {
      const body = await readJsonBody(req, config.server.maxBodyBytes);
      const request = adapter.parseRequest(body);
      const agentId = resolveAgentId(req, request.sessionKey);
      const turn = await service.complete(request, {
        agentId,
        deadlineAt: Date.now() + config.server.requestDeadlineMs,
        isClientGone: () => clientGone,
        onPromptCompacted: () => res.setHeader(COMPACTED_HEADER, "true"),
      });
      if (clientGone) return;
      if (request.stream) adapter.writeStream(res, turn);
      else sendJson(res, 200, adapter.buildResponse(turn));
    } catch (error) {
      handleFailure(res, error, clientGone);
    } finally {
      inFlight -= 1;
    }
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const origin = req.headers.origin;
    if (!isBrowserOriginAllowed(origin, config.server.corsOrigins)) {
      sendJson(
        res,
        403,
        errorBody("Browser origin is not allowed", "cors_error"),
      );
      return;
    }
    applyCors(res, origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const authorized = isAuthorized(
      extractCredential(req.headers),
      config.server.apiKey,
    );
    const isProbe =
      route === "GET /" || route === "GET /health" || route === "GET /readyz";
    if (!isProbe && !authorized) {
      sendJson(
        res,
        401,
        errorBody("Invalid or missing proxy API key", "authentication_error"),
        {
          "WWW-Authenticate": "Bearer",
        },
      );
      return;
    }

    switch (route) {
      case "GET /":
      case "GET /health": {
        const health: Record<string, unknown> = {
          status: "ok",
          service: "dsproxy",
        };
        if (authorized) {
          Object.assign(health, {
            models: listModels().map((model) => model.id),
            agents: sessions.size,
            in_flight: inFlight,
            accounts: pool.statuses(),
            config_ready: pool.readyCount() > 0,
          });
        }
        sendJson(res, 200, health);
        return;
      }
      case "GET /readyz": {
        const ready = pool.readyCount();
        sendJson(res, ready > 0 ? 200 : 503, {
          ready: ready > 0,
          ready_accounts: ready,
          total_accounts: pool.size,
        });
        return;
      }
      case "GET /v1/models":
        sendJson(res, 200, {
          object: "list",
          data: listModels().map((model) => ({
            id: model.id,
            object: "model",
            created: 1_700_000_000,
            owned_by: "deepseek-web",
            description: model.description,
            capabilities: model.capabilities,
          })),
        });
        return;
      case "GET /v1/sessions": {
        const agents = sessions.list();
        sendJson(res, 200, { agents, total: agents.length });
        return;
      }
      case "POST /reset-session": {
        const agent = url.searchParams.get("agent") || "default";
        if (agent === "all") {
          sendJson(res, 200, {
            status: "all_sessions_cleared",
            count: sessions.clear(),
          });
          return;
        }
        const reset = sessions.resetRemote(agent);
        if (!reset)
          sendJson(
            res,
            404,
            errorBody(`No session for agent: ${agent}`, "not_found"),
          );
        else
          sendJson(res, 200, {
            status: "session_reset",
            agent,
            history_preserved: reset.historyPreserved,
          });
        return;
      }
      default: {
        const adapter =
          req.method === "POST" ? ADAPTERS[url.pathname] : undefined;
        if (adapter) {
          await handleCompletion(req, res, adapter);
          return;
        }
        sendJson(res, 404, errorBody("Not found", "not_found"));
      }
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) =>
      handleFailure(res, error, false),
    );
  });
}
