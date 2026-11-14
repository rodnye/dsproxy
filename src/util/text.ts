// Lone surrogates break JSON/URL encoders downstream. Valid pairs (emoji) must survive
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, "");
}

export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function isBlank(text: string | null | undefined): boolean {
  return !text || text.trim().length === 0;
}
