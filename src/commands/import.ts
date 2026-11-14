import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  normalizeAuth,
  validateAuth,
  writeAuthFile,
} from "../accounts/auth-file.js";
import type { Config } from "../config.js";

type Env = Record<string, string | undefined>;

const USAGE = `dsproxy import — import credentials into a deepseek-auth.json

Usage:
  dsproxy import --input ./deepseek-auth.json
  DSPROXY_TOKEN="<token>" dsproxy import --input ./cookies.json

Options:
  -i, --input    Source: a ready deepseek-auth.json or a browser cookie export
  -o, --output   Target path (default: the first DSPROXY_AUTH_PATH entry)

The token is read from DSPROXY_TOKEN, never from the command line (shell history / process list).`;

export function runImport(
  config: Config,
  argv: string[],
  env: Env = process.env,
): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      token: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.token !== undefined) {
    console.error(
      "[import] Refusing --token: CLI arguments leak into shell history and process lists. Use DSPROXY_TOKEN.",
    );
    return 2;
  }
  if (values.help || !values.input) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const outPath = path.resolve(
    values.output ?? config.accounts.authPaths[0] ?? "deepseek-auth.json",
  );
  const source = JSON.parse(
    readFileSync(path.resolve(values.input), "utf8"),
  ) as unknown;
  const auth = normalizeAuth(
    source,
    env.DSPROXY_TOKEN ? { token: env.DSPROXY_TOKEN.trim() } : {},
  );

  const problems = validateAuth(auth);
  if (problems.length > 0) {
    console.error(`[import] Invalid auth: ${problems.join(", ")}`);
    console.error(
      "[import] When importing browser cookies, pass the token via DSPROXY_TOKEN.",
    );
    return 2;
  }
  writeAuthFile(outPath, auth);
  console.log(
    `[import] Imported auth to ${outPath} (token ${auth.token.length} chars, permissions 0600)`,
  );
  return 0;
}
