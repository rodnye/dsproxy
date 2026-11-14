import { statSync } from "node:fs";
import { createAccount, AccountPool } from "../accounts/account-pool.js";
import {
  discoverAuthFiles,
  readAuthFile,
  validateAuth,
} from "../accounts/auth-file.js";
import type { Config } from "../config.js";
import { DeepSeekClient } from "../deepseek/client.js";

/** `dsproxy doctor [--offline]`: validates auth files and (online) the PoW round trip */
export async function runDoctor(
  config: Config,
  argv: string[],
): Promise<number> {
  const offline = argv.includes("--offline");
  let files: string[];
  try {
    files = discoverAuthFiles(
      config.accounts.authPaths,
      config.accounts.authDir,
    );
  } catch (error) {
    console.error(
      `err! Could not read the auth directory: ${(error as Error).message}`,
    );
    return 2;
  }

  let ok = true;
  console.log("dsproxy doctor");
  for (const file of files) {
    console.log(`\nAuth file: ${file}`);
    let auth;
    try {
      auth = readAuthFile(file);
    } catch (error) {
      ok = false;
      console.log(`  err! ${(error as Error).message}`);
      continue;
    }

    const problems = validateAuth(auth);
    if (process.platform !== "win32") {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0)
        problems.push(
          `permissions too open: ${mode.toString(8)} (run: chmod 600 ${file})`,
        );
    }
    if (problems.length > 0) {
      ok = false;
      for (const problem of problems) console.log(`  err! ${problem}`);
      continue;
    }
    console.log("  ok.  auth file looks OK");

    if (offline) continue;
    const account = createAccount("doctor", file, auth);
    const client = new DeepSeekClient(
      new AccountPool([account], config.accounts.cooldownMs),
      config.upstream,
    );
    try {
      await client.createPowHeader(account);
      console.log("  ok.  live PoW challenge solved");
    } catch (error) {
      ok = false;
      console.log(`  err! live PoW check failed: ${(error as Error).message}`);
    }
  }

  console.log(
    "\nIf checks fail with 401/403 or a missing challenge, re-run `dsproxy auth` to refresh the session.",
  );
  return ok ? 0 : 2;
}
