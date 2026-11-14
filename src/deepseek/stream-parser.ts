import { isRecord } from "../util/json.js";

export type MessageId = number | string;

export interface ModelError {
  type: string;
  content: string;
  finishReason: string | null;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  messageId: MessageId | null;
  finishReason: string | null;
  modelError: ModelError | null;
}

export interface Fragment {
  type?: string;
  content?: string;
  [key: string]: unknown;
}

const isOutputFragment = (fragment: Fragment): boolean =>
  (fragment.type === "RESPONSE" || fragment.type === "SEARCH") &&
  typeof fragment.content === "string";

const isReasoningFragment = (fragment: Fragment): boolean =>
  (fragment.type === "THINK" || fragment.type === "REASONING") &&
  typeof fragment.content === "string";

export function rebuildFragmentText(fragments: readonly Fragment[]): {
  responseText: string;
  thinkText: string;
} {
  return {
    responseText: fragments
      .filter(isOutputFragment)
      .map((fragment) => fragment.content)
      .join(""),
    thinkText: fragments
      .filter(isReasoningFragment)
      .map((fragment) => fragment.content)
      .join(""),
  };
}

/** Applies `{p:'fragments', o:'APPEND', v}` operations from a response-level patch */
export function applyPatchOperations(
  ops: unknown,
  append: (value: unknown) => void,
): boolean {
  if (!Array.isArray(ops)) return false;
  let applied = false;
  for (const op of ops) {
    if (
      isRecord(op) &&
      op.p === "fragments" &&
      op.o === "APPEND" &&
      op.v !== undefined
    ) {
      append(op.v);
      applied = true;
    }
  }
  return applied;
}

/**
 * Incremental parser for DeepSeek's SSE completion stream. The stream is a
 * sequence of JSON patches where events without `p` inherit the previous path
 */
export class CompletionStreamParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private lastPath: string | null = null;
  private readonly fragments: Fragment[] = [];
  private content = "";
  private reasoning = "";
  private messageId: MessageId | null = null;
  private finishReason: string | null = null;
  private modelError: ModelError | null = null;

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  finish(): CompletionResult {
    this.buffer += this.decoder.decode();
    if (this.buffer) this.handleLine(this.buffer);
    this.buffer = "";
    return {
      content: this.content,
      reasoning: this.reasoning,
      messageId: this.messageId,
      finishReason: this.finishReason,
      modelError: this.modelError,
    };
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data: ")) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      return;
    }
    if (isRecord(event)) this.handleEvent(event);
  }

  private handleEvent(event: Record<string, unknown>): void {
    const id = event.response_message_id;
    if (
      (typeof id === "number" || typeof id === "string") &&
      this.messageId === null
    )
      this.messageId = id;

    if (event.type === "error") {
      this.modelError = {
        type: "error",
        content: typeof event.content === "string" ? event.content : "",
        finishReason:
          typeof event.finish_reason === "string" ? event.finish_reason : null,
      };
    }
    if (typeof event.finish_reason === "string" && event.finish_reason)
      this.finishReason = event.finish_reason;
    if (typeof event.p === "string") this.lastPath = event.p;

    const value = event.v;
    if (isRecord(value) && isRecord(value.response))
      this.applySnapshot(value.response);
    if (value === undefined) return;

    switch (this.lastPath) {
      case "response/fragments":
        this.appendFragments(value);
        break;
      case "response":
        applyPatchOperations(value, (fragments) =>
          this.appendFragments(fragments),
        );
        break;
      case "response/fragments/-1/content":
        if (typeof value === "string") this.appendToLastFragment(value);
        break;
      case "response/content":
        if (typeof value === "string") this.content += value;
        break;
      case "response/finish_reason":
        this.finishReason = String(value);
        break;
      case "response/status":
        if (value !== "FINISHED" && value !== "WIP")
          this.finishReason = String(value);
        break;
      default:
        break;
    }
  }

  private applySnapshot(response: Record<string, unknown>): void {
    const id = response.message_id;
    if (typeof id === "number" || typeof id === "string") this.messageId = id;
    if (typeof response.content === "string") this.content = response.content;
    if (Array.isArray(response.fragments)) {
      this.fragments.length = 0;
      this.appendFragments(response.fragments);
    }
    if (typeof response.finish_reason === "string")
      this.finishReason = response.finish_reason;
  }

  private appendFragments(value: unknown): void {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) {
      if (isRecord(fragment)) this.fragments.push({ ...fragment });
    }
    this.rebuild();
  }

  private appendToLastFragment(text: string): void {
    const last = this.fragments[this.fragments.length - 1];
    if (!last) return;
    last.content = `${last.content ?? ""}${text}`;
    this.rebuild();
  }

  private rebuild(): void {
    const { responseText, thinkText } = rebuildFragmentText(this.fragments);
    if (responseText) this.content = responseText;
    this.reasoning = thinkText;
  }
}

export async function readCompletionStream(
  body: NonNullable<Response["body"]>,
): Promise<CompletionResult> {
  const parser = new CompletionStreamParser();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value as Uint8Array);
  }
  return parser.finish();
}
