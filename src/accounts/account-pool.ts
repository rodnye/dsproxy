import { ProxyError } from "../errors.js";
import { createLogger, type Logger } from "../logger.js";
import { parseRetryAfterMs } from "../util/time.js";
import { discoverAuthFiles, readAuthFile, validateAuth } from "./auth-file.js";
import type {
  Account,
  AccountLease,
  AccountStatus,
  AuthData,
} from "./types.js";

const COOLDOWN_STATUSES = new Set([401, 403, 429]);

export function createAccount(
  id: string,
  file: string,
  auth: AuthData,
): Account {
  return { id, file, auth, cooldownUntil: 0, failures: 0, lastUsedAt: 0 };
}

/**
 * Round-robin pool with sticky leases: a DeepSeek chat session belongs to the
 * account that created it, so callers pass the previous account id back in
 * Accounts hit by 401/403/429 cool down (honoring Retry-After on 429)
 */
export class AccountPool {
  private roundRobin = 0;

  constructor(
    private readonly accounts: Account[],
    private readonly cooldownMs: number,
    private readonly logger: Logger = createLogger("pool"),
  ) {}

  static fromFiles(files: readonly string[], cooldownMs: number): AccountPool {
    const logger = createLogger("pool");
    const accounts: Account[] = [];
    for (const file of files) {
      try {
        const auth = readAuthFile(file);
        const problems = validateAuth(auth);
        if (problems.length > 0) {
          logger.warn(`Skipping ${file}: ${problems.join(", ")}`);
          continue;
        }
        accounts.push(
          createAccount(`account_${accounts.length + 1}`, file, auth),
        );
      } catch (error) {
        logger.warn(`Could not load ${file}: ${(error as Error).message}`);
      }
    }
    logger.info(`Loaded ${accounts.length} account(s)`);
    return new AccountPool(accounts, cooldownMs, logger);
  }

  static fromConfig(
    authPaths: readonly string[],
    authDir: string | null,
    cooldownMs: number,
  ): AccountPool {
    return AccountPool.fromFiles(
      discoverAuthFiles(authPaths, authDir),
      cooldownMs,
    );
  }

  get size(): number {
    return this.accounts.length;
  }

  readyCount(now = Date.now()): number {
    return this.accounts.filter((account) => this.isUsable(account, now))
      .length;
  }

  statuses(now = Date.now()): AccountStatus[] {
    return this.accounts.map((account) => ({
      id: account.id,
      ready: this.hasCredentials(account),
      cooldown: account.cooldownUntil > now,
      cooldownRemainingSec: Math.max(
        0,
        Math.ceil((account.cooldownUntil - now) / 1000),
      ),
      failures: account.failures,
      lastUsedAt: account.lastUsedAt || null,
    }));
  }

  acquire(stickyId: string | null, now = Date.now()): AccountLease {
    let rotated = false;
    if (stickyId) {
      const sticky = this.accounts.find((account) => account.id === stickyId);
      if (sticky && this.isUsable(sticky, now))
        return { account: sticky, rotated: false };
      rotated = true;
    }
    const ready = this.accounts.filter((account) =>
      this.isUsable(account, now),
    );
    if (ready.length === 0) throw this.exhausted(now);
    const account = ready[this.roundRobin % ready.length] as Account;
    this.roundRobin += 1;
    return { account, rotated };
  }

  markFailure(
    account: Account,
    status: number,
    reason = "",
    retryAfter: string | null = null,
    now = Date.now(),
  ): void {
    account.failures += 1;
    if (!COOLDOWN_STATUSES.has(status)) return;
    const retryMs = status === 429 ? parseRetryAfterMs(retryAfter, now) : null;
    const cooldownMs = retryMs ?? this.cooldownMs;
    account.cooldownUntil = now + cooldownMs;
    this.logger.warn(
      `${account.id} cooling down for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}` +
        `${reason ? ` (${reason})` : ""}${retryMs === null ? "" : " [Retry-After]"}`,
    );
  }

  private hasCredentials(account: Account): boolean {
    return account.auth.token !== "" && account.auth.cookie !== "";
  }

  private isUsable(account: Account, now: number): boolean {
    return this.hasCredentials(account) && account.cooldownUntil <= now;
  }

  private exhausted(now: number): ProxyError {
    const waiting = this.accounts
      .filter((account) => this.hasCredentials(account))
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    if (waiting) {
      const waitSec = Math.max(
        1,
        Math.ceil((waiting.cooldownUntil - now) / 1000),
      );
      return new ProxyError(
        `All DeepSeek accounts are cooling down. Retry in ~${waitSec}s or add another account (dsproxy auth).`,
        { status: 429, type: "rate_limit_error", retryAfterSec: waitSec },
      );
    }
    return new ProxyError(
      "No valid DeepSeek accounts. Run `dsproxy auth` or `dsproxy import`.",
      {
        status: 503,
        type: "no_auth",
      },
    );
  }
}
