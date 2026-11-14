export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. `arguments` is a serialized JSON object */
export interface ToolCall {
  name: string;
  arguments: string;
}

export interface IdentifiedToolCall extends ToolCall {
  id: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Tool calls issued by an assistant message */
  toolCalls?: IdentifiedToolCall[];
  /** Id of the tool call a `tool` message answers */
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Protocol-independent request produced by every adapter in `protocols/` */
export interface NormalizedRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  stream: boolean;
  sessionKey?: string | undefined;
}

export type FinishReason = "stop" | "length" | "tool_calls";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Protocol-independent result consumed by every adapter in `protocols/` */
export interface AssistantTurn {
  id: string;
  created: number;
  model: string;
  content: string;
  reasoning: string;
  toolCall: IdentifiedToolCall | null;
  finishReason: FinishReason;
  usage: Usage;
}
