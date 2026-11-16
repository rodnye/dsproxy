import type { MessageId } from "../deepseek/stream-parser.js";
import type { ClientPrefix } from "./client-prefix.js";

export interface Exchange {
  user: string;
  assistant: string;
}

export interface ChatSession {
  /** DeepSeek chat_session id; null until the first upstream call */
  id: string | null;
  parentMessageId: MessageId | null;
  createdAt: number | null;
  messageCount: number;
  /** Sticky account: a remote session only works with the account that created it */
  accountId: string | null;
  /** Local recovery history, replayed into a fresh remote session when needed */
  history: Exchange[];
  lastActivityAt: number;
  /** Client messages already in the remote chat (stateless clients); see client-prefix.ts */
  clientPrefix: ClientPrefix | null;
}

export interface FailedRemoteSession {
  failedSessionId: string | null;
  failedMessageCount: number;
  accountId: string | null;
}

export type RolloverReason = "max_message_depth" | "session_ttl";

export interface SessionOptions {
  ttlMs: number;
  maxMessageDepth: number;
  maxHistoryLength: number;
  maxHistoryChars: number;
}

export interface SessionSummary {
  agent: string;
  sessionId: string | null;
  messageCount: number;
  account: string | null;
  historySize: number;
  ageMin: number;
}

export function createSession(now = Date.now()): ChatSession {
  return {
    id: null,
    parentMessageId: null,
    createdAt: null,
    messageCount: 0,
    accountId: null,
    history: [],
    lastActivityAt: now,
    clientPrefix: null,
  };
}

/**
 * Drops the remote chat but keeps the local history and the sticky account:
 * a remote chat can be unhealthy without invalidating either
 */
export function resetRemoteSession(session: ChatSession): FailedRemoteSession {
  const failed: FailedRemoteSession = {
    failedSessionId: session.id,
    failedMessageCount: session.messageCount,
    accountId: session.accountId,
  };
  session.id = null;
  session.parentMessageId = null;
  session.createdAt = null;
  session.messageCount = 0;
  return failed;
}

export function buildRecoveryHistoryPrefix(
  history: readonly Exchange[],
): string {
  if (history.length === 0) return "";
  let prefix = "[Previous conversation]\n";
  for (const exchange of history) {
    prefix += `User: ${exchange.user}\nAssistant: ${exchange.assistant}\n\n`;
  }
  return `${prefix}[Continue from here]\n\n`;
}

export class SessionStore {
  private readonly sessions = new Map<string, ChatSession>();

  constructor(private readonly options: SessionOptions) {}

  get size(): number {
    return this.sessions.size;
  }

  /** Returns the agent's session, creating it on first use */
  get(agentId: string): ChatSession {
    let session = this.sessions.get(agentId);
    if (!session) {
      session = createSession();
      this.sessions.set(agentId, session);
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  /** Replaces the session with a pristine one (history dropped). Used by `/new` */
  replace(agentId: string): { clearedHistory: number } {
    const clearedHistory = this.sessions.get(agentId)?.history.length ?? 0;
    this.sessions.set(agentId, createSession());
    return { clearedHistory };
  }

  clear(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  /** Drops the remote chat of one agent, keeping local history. Null when unknown */
  resetRemote(agentId: string): { historyPreserved: number } | null {
    const session = this.sessions.get(agentId);
    if (!session) return null;
    resetRemoteSession(session);
    return { historyPreserved: session.history.length };
  }

  list(now = Date.now()): SessionSummary[] {
    return [...this.sessions].map(([agent, session]) => ({
      agent,
      sessionId: session.id,
      messageCount: session.messageCount,
      account: session.accountId,
      historySize: session.history.length,
      ageMin: session.createdAt
        ? Math.round((now - session.createdAt) / 60_000)
        : 0,
    }));
  }

  /** Evicts sessions idle for more than twice the TTL so the map cannot grow unbounded */
  sweep(maxIdleMs = this.options.ttlMs * 2, now = Date.now()): number {
    let removed = 0;
    for (const [agentId, session] of this.sessions) {
      if (now - session.lastActivityAt > maxIdleMs) {
        this.sessions.delete(agentId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Rolls the remote chat over when it is too deep or too old */
  prepareForPrompt(
    session: ChatSession,
    now = Date.now(),
  ): (FailedRemoteSession & { reason: RolloverReason }) | null {
    if (session.id === null) return null;
    let reason: RolloverReason | null = null;
    if (session.messageCount >= this.options.maxMessageDepth)
      reason = "max_message_depth";
    else if (
      session.createdAt !== null &&
      now - session.createdAt > this.options.ttlMs
    )
      reason = "session_ttl";
    if (reason === null) return null;
    return { reason, ...resetRemoteSession(session) };
  }

  recordExchange(
    session: ChatSession,
    prompt: string,
    assistant: string,
  ): void {
    const shortPrompt =
      prompt.length > 500 ? `...${prompt.slice(-500)}` : prompt;
    session.history.push({ user: shortPrompt, assistant });
    while (session.history.length > this.options.maxHistoryLength)
      session.history.shift();
    let chars = session.history.reduce(
      (sum, e) => sum + e.user.length + e.assistant.length,
      0,
    );
    while (chars > this.options.maxHistoryChars && session.history.length > 1) {
      const removed = session.history.shift() as Exchange;
      chars -= removed.user.length + removed.assistant.length;
    }
  }
}
