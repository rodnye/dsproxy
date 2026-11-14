export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds
 * Returns null when absent or unparseable. Clamped to at least one second
 */
export function parseRetryAfterMs(
  raw: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Math.max(1000, Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(1000, at - now);
}
