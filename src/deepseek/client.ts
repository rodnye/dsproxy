import type { Account } from "../accounts/types.js";
import type { AccountPool } from "../accounts/account-pool.js";
import type { UpstreamConfig } from "../config.js";
import { ProxyError, upstreamHttpError } from "../errors.js";
import { getPath } from "../util/json.js";
import {
  buildRequestHeaders,
  DEEPSEEK_ORIGIN,
  ENDPOINTS,
} from "./constants.js";
import type { ModelSpec } from "./models.js";
import { buildPowHeader, solvePow, type PowChallenge } from "./pow.js";
import type { MessageId } from "./stream-parser.js";

export interface CompletionRequest {
  sessionId: string;
  parentMessageId: MessageId | null;
  model: ModelSpec;
  prompt: string;
}

/** Thin wrapper over the three DeepSeek web endpoints. Reports failures to the account pool */
export class DeepSeekClient {
  constructor(
    private readonly pool: AccountPool,
    private readonly config: UpstreamConfig,
  ) {}

  /** Fetches and solves a PoW challenge; returns the `X-DS-PoW-Response` header value */
  async createPowHeader(account: Account): Promise<string> {
    const data = await this.postJson(
      account,
      ENDPOINTS.powChallenge,
      { target_path: ENDPOINTS.completion },
      "pow challenge",
    );
    const challenge = getPath(data, ["data", "biz_data", "challenge"]) as
      | PowChallenge
      | undefined;
    if (!challenge) {
      throw new ProxyError(
        "DeepSeek PoW response has no challenge. Auth may be expired, a captcha may be required, or the web API changed. " +
          "Run `dsproxy doctor`, then `dsproxy auth`.",
        { status: 502, type: "upstream_pow_missing" },
      );
    }
    const answer = await solvePow(
      challenge,
      account.auth.wasmUrl,
      this.config.fetchTimeoutMs,
    );
    return buildPowHeader(challenge, answer);
  }

  async createChatSession(account: Account): Promise<string> {
    const data = await this.postJson(
      account,
      ENDPOINTS.createSession,
      {},
      "session create",
    );
    const id =
      getPath(data, ["data", "biz_data", "chat_session", "id"]) ??
      getPath(data, ["data", "biz_data", "id"]);
    if (typeof id !== "string" || !id) {
      throw new ProxyError(
        "Could not create a DeepSeek chat session. Auth may be expired or captcha-blocked. Run `dsproxy doctor`.",
        { status: 502, type: "upstream_session_error" },
      );
    }
    return id;
  }

  /** Starts a completion. A fresh PoW is solved for every call. Returns the live SSE response */
  async complete(
    account: Account,
    request: CompletionRequest,
  ): Promise<Response> {
    const pow = await this.createPowHeader(account);
    const response = await fetch(`${DEEPSEEK_ORIGIN}${ENDPOINTS.completion}`, {
      method: "POST",
      headers: { ...this.headers(account), "X-DS-PoW-Response": pow },
      body: JSON.stringify({
        chat_session_id: request.sessionId,
        parent_message_id: request.parentMessageId,
        model_type: request.model.modelType,
        prompt: request.prompt,
        ref_file_ids: [],
        thinking_enabled: request.model.thinking,
        search_enabled: request.model.search,
        action: null,
        preempt: false,
      }),
      signal: AbortSignal.timeout(this.config.completionTimeoutMs),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      this.pool.markFailure(account, response.status, "completion", retryAfter);
      throw upstreamHttpError(
        response.status,
        await response.text(),
        retryAfter,
      );
    }
    return response;
  }

  private headers(account: Account): Record<string, string> {
    return buildRequestHeaders(account.auth, this.config);
  }

  private async postJson(
    account: Account,
    endpoint: string,
    body: unknown,
    label: string,
  ): Promise<unknown> {
    const response = await fetch(`${DEEPSEEK_ORIGIN}${endpoint}`, {
      method: "POST",
      headers: this.headers(account),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.fetchTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      this.pool.markFailure(account, response.status, label, retryAfter);
      throw upstreamHttpError(response.status, text, retryAfter);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.pool.markFailure(account, response.status, label);
      throw new ProxyError(
        `DeepSeek returned a non-JSON ${label} response. Run \`dsproxy doctor\`. First chars: ${text.slice(0, 120)}`,
        { status: 502, type: "upstream_invalid_response" },
      );
    }
  }
}
