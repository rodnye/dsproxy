import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { findModel, listModels, type ModelSpec } from "../deepseek/models.js";
import type { CompletionResult } from "../deepseek/stream-parser.js";
import { ProxyError } from "../errors.js";
import { createLogger } from "../logger.js";
import {
  appendInstruction,
  buildBoundedPrompt,
  buildRetryPrompt,
  type BuiltPrompt,
  type PromptParts,
} from "../prompt/bounded.js";
import {
  formatConversation,
  formatToolCallEnvelope,
  hasExplicitHistory,
} from "../prompt/conversation.js";
import {
  buildRecoveryHistoryPrefix,
  resetRemoteSession,
  type ChatSession,
  type SessionStore,
} from "../sessions/session-store.js";
import { looksLikeToolCallMarkup, parseToolCall } from "../tools/parser.js";
import type {
  AssistantTurn,
  FinishReason,
  IdentifiedToolCall,
  NormalizedRequest,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { estimateTokens, isBlank, stripLoneSurrogates } from "../util/text.js";
import { sleep } from "../util/time.js";
import type { ChatRunner } from "./chat-runner.js";
import { classifyRecoveryFailure, isContextTooLongError } from "./recovery.js";

export interface RequestContext {
  agentId: string;
  deadlineAt: number;
  isClientGone(): boolean;
  /** Called when the upstream prompt had to be shortened (surfaced as a response header) */
  onPromptCompacted(): void;
}

interface TurnEnv {
  ctx: RequestContext;
  session: ChatSession;
  model: ModelSpec;
  tag: string;
  parts: PromptParts;
  recoveryPrefix: string;
  fresh: BuiltPrompt;
}

interface Attempt {
  state: CompletionResult;
  promptUsed: string;
  compacted: boolean;
  retries: number;
}

const NEW_CHAT_COMMAND = "/new";
const NEW_CHAT_REPLY =
  "Started a new chat. Session and history have been reset.";
const STRICT_TOOL_INSTRUCTION =
  "[STRICT INSTRUCTION] Your previous response contained incomplete tool-call markup. " +
  'Keep arguments short and output ONLY strict JSON: {"tool_call":{"name":"<function>","arguments":{...}}}';
const CONTINUE_INSTRUCTION =
  "Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.";

/**
 * Turns a normalized request into an assistant turn. Owns the recovery policy:
 * bounded prompts, retries on empty / context-too-long responses, continuation
 * of truncated answers and tool-call extraction with one repair attempt
 */
export class CompletionService {
  private readonly log = createLogger("completion");

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStore,
    private readonly runner: ChatRunner,
  ) {}

  async complete(
    request: NormalizedRequest,
    ctx: RequestContext,
  ): Promise<AssistantTurn> {
    const model = findModel(request.model);
    if (!model) {
      throw new ProxyError(
        `Unknown model: ${request.model}. Available: ${listModels()
          .map((m) => m.id)
          .join(", ")}`,
        { status: 400, type: "invalid_model" },
      );
    }
    const clientPrompt = request.messages
      .map((message) => message.content)
      .join("\n");

    if (this.isNewChatCommand(request)) {
      const { clearedHistory } = this.sessions.replace(ctx.agentId);
      this.log.info(
        `[${ctx.agentId}] /new received (history cleared: ${clearedHistory})`,
      );
      return this.buildTurn(
        model.id,
        NEW_CHAT_REPLY,
        "",
        null,
        "stop",
        clientPrompt,
      );
    }

    const { maxChars } = this.config.prompt;
    const { systemPrompt, conversation } = formatConversation(
      request.messages,
      request.tools,
      maxChars,
    );
    const session = this.sessions.get(ctx.agentId);
    const tag = `[${ctx.agentId}]`;

    const rollover = this.sessions.prepareForPrompt(session);
    if (rollover)
      this.log.info(
        `${tag} session ${rollover.failedSessionId} reset before prompt build (${rollover.reason})`,
      );

    // Local history is only injected into a fresh remote chat, and never duplicates client history
    const recoveryPrefix = hasExplicitHistory(request.messages)
      ? ""
      : buildRecoveryHistoryPrefix(session.history);
    const parts: PromptParts = {
      system: systemPrompt,
      historyPrefix: session.id ? "" : recoveryPrefix,
      conversation,
    };
    const initial = buildBoundedPrompt(parts, maxChars);
    const fresh = buildBoundedPrompt(
      { ...parts, historyPrefix: recoveryPrefix },
      maxChars,
    );
    if (initial.compacted) {
      ctx.onPromptCompacted();
      this.log.info(
        `${tag} compacted prompt ${initial.originalChars} -> ${initial.prompt.length} chars`,
      );
    }

    const env: TurnEnv = {
      ctx,
      session,
      model,
      tag,
      parts,
      recoveryPrefix,
      fresh,
    };
    const first = await this.runner.run({
      session,
      agentId: ctx.agentId,
      model,
      prompt: initial.prompt,
      freshPrompt: fresh.prompt,
    });

    const attempt: Attempt = {
      state: this.sanitize(first.result),
      promptUsed: first.promptUsed,
      compacted: initial.compacted,
      retries: 0,
    };
    if (first.promptUsed !== initial.prompt && fresh.compacted) {
      attempt.compacted = true;
      ctx.onPromptCompacted();
    }

    await this.recoverEmptyResponse(env, attempt);
    if (isBlank(attempt.state.content))
      throw this.emptyResponseError(env, attempt);

    await this.continueTruncated(env, attempt);
    const toolCall = await this.resolveToolCall(env, attempt, request.tools);

    this.sessions.recordExchange(
      session,
      conversation,
      toolCall ? formatToolCallEnvelope(toolCall) : attempt.state.content,
    );

    const finish: FinishReason = toolCall
      ? "tool_calls"
      : attempt.state.finishReason === "length"
        ? "length"
        : "stop";
    this.log.info(
      `${tag} ${attempt.state.content.length} chars (+${attempt.state.reasoning.length} reasoning), tool=${toolCall !== null}`,
    );
    return this.buildTurn(
      model.id,
      attempt.state.content,
      attempt.state.reasoning,
      toolCall,
      finish,
      clientPrompt,
    );
  }

  private isNewChatCommand(request: NormalizedRequest): boolean {
    const lastUser = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    return lastUser?.content.trim() === NEW_CHAT_COMMAND;
  }

  private sanitize(result: CompletionResult): CompletionResult {
    return {
      ...result,
      content: stripLoneSurrogates(result.content),
      reasoning: stripLoneSurrogates(result.reasoning),
    };
  }

  /** Empty / context-too-long recovery: each retry gets a smaller prompt and a fresh remote chat */
  private async recoverEmptyResponse(
    env: TurnEnv,
    attempt: Attempt,
  ): Promise<void> {
    const { prompt: promptConfig } = this.config;
    while (isBlank(attempt.state.content)) {
      if (env.ctx.isClientGone())
        throw new ProxyError("Client closed the request", {
          status: 499,
          type: "client_closed_request",
        });
      if (Date.now() > env.ctx.deadlineAt) break;
      const tooLong = isContextTooLongError(attempt.state.modelError);
      if (attempt.state.modelError && !tooLong) break;
      if (attempt.retries >= promptConfig.maxEmptyRetries) break;
      attempt.retries += 1;

      const ratio = tooLong
        ? Math.max(0.35, 0.8 - attempt.retries * 0.2)
        : Math.max(0.5, 1 - attempt.retries * 0.2);
      const budget = Math.max(
        promptConfig.minChars,
        Math.floor(promptConfig.maxChars * ratio),
      );
      const retry = buildRetryPrompt(
        { ...env.parts, historyPrefix: env.recoveryPrefix },
        attempt.promptUsed,
        budget,
      );
      if (retry.compacted) {
        attempt.compacted = true;
        env.ctx.onPromptCompacted();
      }
      this.log.warn(
        `${env.tag} ${tooLong ? "context-too-long" : "empty"} response (retry ${attempt.retries}/${promptConfig.maxEmptyRetries}, prompt=${retry.prompt.length} chars)`,
      );
      resetRemoteSession(env.session);
      await sleep(Math.min(500 * attempt.retries, 1500));

      const next = await this.runner.run({
        session: env.session,
        agentId: env.ctx.agentId,
        model: env.model,
        prompt: retry.prompt,
        freshPrompt: retry.prompt,
      });
      attempt.promptUsed = retry.prompt;
      attempt.state = this.sanitize(next.result);
    }
  }

  private emptyResponseError(env: TurnEnv, attempt: Attempt): ProxyError {
    const timedOut = Date.now() > env.ctx.deadlineAt;
    const failureClass = classifyRecoveryFailure(
      attempt.state.modelError,
      timedOut,
    );
    const failure = resetRemoteSession(env.session);
    const plural = attempt.retries === 1 ? "y" : "ies";
    const message =
      attempt.state.modelError?.content ||
      (timedOut
        ? "DeepSeek request deadline reached while recovering an empty response"
        : `DeepSeek returned empty content after ${attempt.retries} retr${plural}`);
    this.log.warn(
      `${env.tag} ${failureClass.type} after ${attempt.retries} retr${plural}. Giving up.`,
    );
    return new ProxyError(message, {
      ...failureClass,
      details: {
        agent: env.ctx.agentId,
        failed_session_id: failure.failedSessionId,
        message_count: failure.failedMessageCount,
        history_length: env.session.history.length,
        account: failure.accountId,
        retry_attempts: attempt.retries,
        upstream_prompt_chars: attempt.promptUsed.length,
        prompt_compacted: attempt.compacted,
        model: env.model.id,
      },
    });
  }

  /** Requests the rest of an answer cut off by DeepSeek (finish_reason=length) */
  private async continueTruncated(
    env: TurnEnv,
    attempt: Attempt,
  ): Promise<void> {
    let rounds = 0;
    while (
      attempt.state.finishReason === "length" &&
      rounds < this.config.prompt.maxContinuations
    ) {
      if (env.ctx.isClientGone() || Date.now() > env.ctx.deadlineAt) break;
      rounds += 1;
      this.log.info(
        `${env.tag} response truncated at ${attempt.state.content.length} chars; continuing (${rounds})`,
      );
      await sleep(500);

      const recovery = appendInstruction(
        `${env.fresh.prompt}\n\n[Assistant response so far]\n${attempt.state.content}`,
        CONTINUE_INSTRUCTION,
        this.config.prompt.maxChars,
      );
      const next = await this.runner.run({
        session: env.session,
        agentId: env.ctx.agentId,
        model: env.model,
        prompt: "continue",
        freshPrompt: recovery,
      });
      const addition = this.sanitize(next.result);
      if (isBlank(addition.content)) break;
      attempt.state = {
        ...attempt.state,
        content: attempt.state.content + addition.content,
        reasoning: attempt.state.reasoning + addition.reasoning,
        finishReason: addition.finishReason,
      };
    }
  }

  /** Extracts the tool call, with one strict-prompt repair attempt for broken markup */
  private async resolveToolCall(
    env: TurnEnv,
    attempt: Attempt,
    tools: readonly ToolDefinition[],
  ): Promise<IdentifiedToolCall | null> {
    if (tools.length === 0) return null;
    const allowed = new Set(tools.map((tool) => tool.name));
    const accept = (call: ToolCall | null): IdentifiedToolCall | null =>
      call && allowed.has(call.name)
        ? { ...call, id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}` }
        : null;

    const direct = accept(parseToolCall(attempt.state.content));
    if (direct) return direct;
    if (!looksLikeToolCallMarkup(attempt.state.content)) return null;

    this.log.warn(
      `${env.tag} tool-call markup invalid/unknown (${attempt.state.content.length} chars); retrying with strict prompt`,
    );
    if (!env.ctx.isClientGone() && Date.now() <= env.ctx.deadlineAt) {
      resetRemoteSession(env.session);
      await sleep(1000);
      const strict = appendInstruction(
        env.fresh.prompt,
        STRICT_TOOL_INSTRUCTION,
        this.config.prompt.maxChars,
      );
      const next = await this.runner.run({
        session: env.session,
        agentId: env.ctx.agentId,
        model: env.model,
        prompt: strict,
        freshPrompt: strict,
      });
      const repaired = this.sanitize(next.result);
      const call = accept(parseToolCall(repaired.content));
      if (call) {
        attempt.state = repaired;
        return call;
      }
    }

    // Never leak raw tool markup to the client as a normal assistant answer
    const failure = resetRemoteSession(env.session);
    throw new ProxyError(
      "DeepSeek returned malformed tool-call markup after one repair attempt",
      {
        status: 502,
        type: "malformed_tool_call",
        details: {
          agent: env.ctx.agentId,
          failed_session_id: failure.failedSessionId,
          message_count: failure.failedMessageCount,
          account: failure.accountId,
          prompt_compacted: attempt.compacted,
          model: env.model.id,
        },
      },
    );
  }

  private buildTurn(
    model: string,
    content: string,
    reasoning: string,
    toolCall: IdentifiedToolCall | null,
    finishReason: FinishReason,
    clientPrompt: string,
  ): AssistantTurn {
    const promptTokens = estimateTokens(clientPrompt);
    const reasoningTokens = estimateTokens(reasoning);
    const completionTokens = estimateTokens(content) + reasoningTokens;
    return {
      id: randomUUID().replace(/-/g, ""),
      created: Math.floor(Date.now() / 1000),
      model,
      content,
      // Tool turns carry no reasoning: some agent clients treat any text payload as a final answer
      reasoning: toolCall ? "" : reasoning,
      toolCall,
      finishReason,
      usage: {
        promptTokens,
        completionTokens,
        reasoningTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }
}
