import type { AccountPool } from "../accounts/account-pool.js";
import type { Account } from "../accounts/types.js";
import { DeepSeekClient, type CompletionRequest } from "../deepseek/client.js";
import type { ModelSpec } from "../deepseek/models.js";
import {
  readCompletionStream,
  type CompletionResult,
} from "../deepseek/stream-parser.js";
import { ProxyError } from "../errors.js";
import { createLogger } from "../logger.js";
import {
  resetRemoteSession,
  type ChatSession,
  type SessionStore,
} from "../sessions/session-store.js";

export interface RunInput {
  session: ChatSession;
  agentId: string;
  model: ModelSpec;
  /** Prompt for an established remote session */
  prompt: string;
  /** Prompt (with recovery history) used when the remote session must be recreated */
  freshPrompt: string;
}

export interface RunOutput {
  result: CompletionResult;
  promptUsed: string;
  account: Account;
  /** True when the turn went to a brand-new remote session using the recovery prompt */
  freshSession: boolean;
}

/** Statuses DeepSeek answers with when the remote chat is gone or corrupted */
const SESSION_EXPIRED_STATUSES = new Set([400, 404, 500]);

function isSessionExpired(error: unknown): boolean {
  return (
    error instanceof ProxyError &&
    error.upstreamStatus !== undefined &&
    SESSION_EXPIRED_STATUSES.has(error.upstreamStatus)
  );
}

function requireSessionId(session: ChatSession): string {
  if (session.id === null)
    throw new ProxyError("Remote session was not initialized", {
      status: 500,
      type: "server_error",
    });
  return session.id;
}

/**
 * Executes ONE upstream turn: picks the account, ensures a remote chat exists,
 * streams the completion and advances the session chain. Recovery policy
 * (retries, compaction, continuation) lives in CompletionService
 */
export class ChatRunner {
  private readonly log = createLogger("runner");

  constructor(
    private readonly pool: AccountPool,
    private readonly client: DeepSeekClient,
    private readonly sessions: SessionStore,
  ) {}

  async run(input: RunInput): Promise<RunOutput> {
    const { session, agentId, model } = input;
    const tag = `[${agentId}]`;

    const hadRemoteSession = session.id !== null;
    const { account, rotated } = this.pool.acquire(session.accountId);
    // A DeepSeek chat belongs to the account that created it: never reuse it under another one
    if (rotated) resetRemoteSession(session);
    session.accountId = account.id;
    account.lastUsedAt = Date.now();

    const rollover = this.sessions.prepareForPrompt(session);
    let freshSession = (rotated && hadRemoteSession) || rollover !== null;
    let promptUsed = freshSession ? input.freshPrompt : input.prompt;
    if (rotated && hadRemoteSession)
      this.log.info(`${tag} account rotation reset the remote session`);
    if (rollover)
      this.log.info(
        `${tag} session ${rollover.failedSessionId} rolled over (${rollover.reason})`,
      );

    if (session.id === null)
      await this.openRemoteSession(session, account, tag);

    let response: Response;
    try {
      response = await this.client.complete(
        account,
        this.requestFor(session, model, promptUsed),
      );
    } catch (error) {
      if (!isSessionExpired(error)) throw error;
      this.log.warn(
        `${tag} remote session ${session.id} looks expired; recreating`,
      );
      resetRemoteSession(session);
      await this.openRemoteSession(session, account, tag);
      promptUsed = input.freshPrompt;
      freshSession = true;
      response = await this.client.complete(
        account,
        this.requestFor(session, model, promptUsed),
      );
    }

    if (!response.body) {
      throw new ProxyError("DeepSeek returned an empty response body", {
        status: 502,
        type: "upstream_empty_body",
      });
    }
    const result = await readCompletionStream(response.body);

    if (result.messageId !== null) {
      session.parentMessageId = result.messageId;
      session.messageCount += 1;
    } else {
      this.log.warn(
        `${tag} could not extract message_id; the next turn will not chain`,
      );
    }
    return { result, promptUsed, account, freshSession };
  }

  private async openRemoteSession(
    session: ChatSession,
    account: Account,
    tag: string,
  ): Promise<void> {
    session.id = await this.client.createChatSession(account);
    session.accountId = account.id;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
    this.log.info(`${tag}/${account.id} created remote session ${session.id}`);
  }

  private requestFor(
    session: ChatSession,
    model: ModelSpec,
    prompt: string,
  ): CompletionRequest {
    return {
      sessionId: requireSessionId(session),
      parentMessageId: session.parentMessageId,
      model,
      prompt,
    };
  }
}
