import type { IncomingMessage } from "node:http";
import { ProxyError } from "../errors.js";

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new ProxyError("Request body too large", {
        status: 413,
        type: "payload_too_large",
      });
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProxyError("Request body is not valid JSON", {
      status: 400,
      type: "invalid_json",
    });
  }
}
