import type { ModelError } from "../deepseek/stream-parser.js";

const CONTEXT_TOO_LONG =
  /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i;

/** DeepSeek reports overflow in several languages; match the known phrasings */
export function isContextTooLongError(
  error: ModelError | string | null | undefined,
): boolean {
  if (!error) return false;
  const text =
    typeof error === "string"
      ? error
      : `${error.content} ${error.finishReason ?? ""} ${error.type}`;
  return CONTEXT_TOO_LONG.test(text);
}

export function classifyRecoveryFailure(
  error: ModelError | null,
  timedOut: boolean,
): { status: number; type: string } {
  if (isContextTooLongError(error))
    return { status: 400, type: "context_length_exceeded" };
  if (timedOut) return { status: 504, type: "request_timeout" };
  return { status: 502, type: error?.type ?? "empty_response" };
}
