import type { ServerResponse } from "node:http";
import type { AssistantTurn, NormalizedRequest } from "../types.js";

/** Translates one wire protocol to/from the internal request/turn model */
export interface ProtocolAdapter {
  readonly name: "openai" | "anthropic" | "responses";
  parseRequest(body: unknown): NormalizedRequest;
  buildResponse(turn: AssistantTurn): unknown;
  /** Writes a complete SSE response and ends it */
  writeStream(res: ServerResponse, turn: AssistantTurn): void;
}
