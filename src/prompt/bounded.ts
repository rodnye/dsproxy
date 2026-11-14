export const COMPACTION_MARKER =
  "\n\n[Earlier context compacted by dsproxy]\n\n";

export interface PromptParts {
  system: string;
  /** Local recovery history; only a hint, dropped first when the prompt is too long */
  historyPrefix: string;
  conversation: string;
}

export interface BuiltPrompt {
  prompt: string;
  compacted: boolean;
  historyDropped: boolean;
  originalChars: number;
}

/** Keeps the start and the end of `text`, replacing the middle with a marker */
export function truncateMiddle(
  text: string,
  maxChars: number,
  headRatio = 0.35,
): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  if (maxChars <= COMPACTION_MARKER.length)
    return text.slice(text.length - maxChars);
  const payload = maxChars - COMPACTION_MARKER.length;
  const head = Math.max(0, Math.min(payload, Math.floor(payload * headRatio)));
  const tail = payload - head;
  return (
    text.slice(0, head) + COMPACTION_MARKER + text.slice(text.length - tail)
  );
}

/**
 * Builds the single prompt string sent upstream, within `maxChars`. Preserves
 * the beginning of the task/system instructions and the most recent tool loop
 * (the tool adapter lives at the end of the system prompt)
 */
export function buildBoundedPrompt(
  parts: PromptParts,
  maxChars: number,
): BuiltPrompt {
  const system = parts.system.trim();
  const history = parts.historyPrefix;
  const conversation = parts.conversation.trim();
  const original = system
    ? `${system}\n\n${history}${conversation}`
    : `${history}${conversation}`;
  const safeMax = Math.max(1, Math.floor(maxChars));

  if (original.length <= safeMax) {
    return {
      prompt: original,
      compacted: false,
      historyDropped: false,
      originalChars: original.length,
    };
  }

  // Server-side history is only a recovery hint and may duplicate client turns: drop it first
  const separator = system && conversation ? 2 : 0;
  let systemBudget = system ? Math.floor((safeMax - separator) * 0.5) : 0;
  let conversationBudget = Math.max(0, safeMax - separator - systemBudget);

  // Unused capacity on a short side goes to the other side
  if (system.length < systemBudget) {
    systemBudget = system.length;
    conversationBudget = Math.max(0, safeMax - separator - systemBudget);
  } else if (conversation.length < conversationBudget) {
    conversationBudget = conversation.length;
    systemBudget = Math.max(0, safeMax - separator - conversationBudget);
  }

  const boundedSystem = truncateMiddle(system, systemBudget, 0.35);
  const boundedConversation = truncateMiddle(
    conversation,
    conversationBudget,
    0.25,
  );
  let prompt =
    boundedSystem && boundedConversation
      ? `${boundedSystem}\n\n${boundedConversation}`
      : boundedSystem || boundedConversation;
  if (prompt.length > safeMax) prompt = prompt.slice(0, safeMax);

  return {
    prompt,
    compacted: true,
    historyDropped: history.length > 0,
    originalChars: original.length,
  };
}

export function buildRetryPrompt(
  parts: PromptParts,
  currentPrompt: string,
  maxChars: number,
): BuiltPrompt {
  const built = buildBoundedPrompt(parts, maxChars);
  return {
    ...built,
    compacted: built.compacted || built.prompt.length < currentPrompt.length,
  };
}

export function appendInstruction(
  prompt: string,
  instruction: string,
  maxChars: number,
): string {
  const suffix = `\n\n${instruction.trim()}`;
  return (
    truncateMiddle(prompt, Math.max(0, maxChars - suffix.length), 0.35) + suffix
  );
}
