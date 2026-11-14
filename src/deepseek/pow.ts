import { ProxyError } from "../errors.js";
import { ENDPOINTS } from "./constants.js";

export interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
}

interface PowExports {
  memory: WebAssembly.Memory;
  __wbindgen_export_0(length: number, align: number): number;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  wasm_solve(
    sp: number,
    cPtr: number,
    cLen: number,
    pPtr: number,
    pLen: number,
    difficulty: number,
  ): void;
}

// The WASM module is immutable per URL: compile once, instantiate per solve
// (fresh linear memory each time)
const moduleCache = new Map<string, Promise<WebAssembly.Module>>();

async function loadModule(
  wasmUrl: string,
  timeoutMs: number,
): Promise<WebAssembly.Module> {
  if (!wasmUrl)
    throw new ProxyError("PoW: missing wasmUrl in auth data", {
      status: 500,
      type: "pow_error",
    });
  let cached = moduleCache.get(wasmUrl);
  if (!cached) {
    cached = (async () => {
      const response = await fetch(wasmUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new ProxyError(
          `PoW: could not fetch WASM (HTTP ${response.status}). Re-run \`dsproxy auth\`.`,
          {
            status: 502,
            type: "pow_error",
          },
        );
      }
      return WebAssembly.compile(await response.arrayBuffer());
    })();
    moduleCache.set(wasmUrl, cached);
    // Do not cache failures: the next solve retries the download
    cached.catch(() => moduleCache.delete(wasmUrl));
  }
  return cached;
}

export async function solvePow(
  challenge: PowChallenge,
  wasmUrl: string,
  timeoutMs = 15_000,
): Promise<number> {
  const module = await loadModule(wasmUrl, timeoutMs);
  const instance = await WebAssembly.instantiate(module, { wbg: {} });
  const exports = instance.exports as unknown as PowExports;

  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode(challenge.challenge);
  const prefixBytes = encoder.encode(
    `${challenge.salt}_${challenge.expire_at}_`,
  );
  const challengePtr =
    exports.__wbindgen_export_0(challengeBytes.length, 1) >>> 0;
  const prefixPtr = exports.__wbindgen_export_0(prefixBytes.length, 1) >>> 0;
  new Uint8Array(
    exports.memory.buffer,
    challengePtr,
    challengeBytes.length,
  ).set(challengeBytes);
  new Uint8Array(exports.memory.buffer, prefixPtr, prefixBytes.length).set(
    prefixBytes,
  );

  const sp = exports.__wbindgen_add_to_stack_pointer(-16);
  exports.wasm_solve(
    sp,
    challengePtr,
    challengeBytes.length,
    prefixPtr,
    prefixBytes.length,
    challenge.difficulty,
  );
  const view = new DataView(exports.memory.buffer);
  const code = view.getInt32(sp, true);
  const answer = view.getFloat64(sp + 8, true);
  exports.__wbindgen_add_to_stack_pointer(16);

  if (code === 0 || !Number.isFinite(answer) || answer <= 0) {
    throw new ProxyError("PoW solver failed", {
      status: 502,
      type: "pow_error",
    });
  }
  return Math.floor(answer);
}

/** Value of the `X-DS-PoW-Response` header */
export function buildPowHeader(
  challenge: PowChallenge,
  answer: number,
): string {
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: ENDPOINTS.completion,
    }),
  ).toString("base64");
}
