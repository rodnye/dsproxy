import type { ServerResponse } from "node:http";

export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

export function writeSse(
  res: ServerResponse,
  event: string | null,
  data: unknown,
): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Splits text into chunks without cutting a surrogate pair in half */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
