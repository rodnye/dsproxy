#!/usr/bin/env node
import { runAuth } from "./commands/auth.js";
import { runDoctor } from "./commands/doctor.js";
import { runImport } from "./commands/import.js";
import { runServe } from "./commands/serve.js";
import { loadConfig } from "./config.js";
import { setLogLevel } from "./logger.js";

const HELP = `dsproxy — local OpenAI / Anthropic / Responses proxy for the DeepSeek web chat

Usage: dsproxy <command> [options]

Commands:
  serve                Start the proxy (default)
  auth [-o file]       Log in through an isolated Chrome and save credentials
  import -i file       Import deepseek-auth.json or a browser cookie export
  doctor [--offline]   Validate auth files and the PoW round trip
  help                 Show this help`;

function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Returns an exit code, or null when the process must keep running (serve) */
async function main(argv: string[]): Promise<number | null> {
  loadDotEnv();
  const [command = "serve", ...rest] = argv;
  const config = loadConfig();
  setLogLevel(config.logLevel);

  switch (command) {
    case "serve":
      await runServe(config);
      return null;
    case "auth":
      return runAuth(config, rest);
    case "import":
      return runImport(config, rest);
    case "doctor":
      return runDoctor(config, rest);
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(
      `[dsproxy] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
