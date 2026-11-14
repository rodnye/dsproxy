import { AccountPool } from "../accounts/account-pool.js";
import type { Config } from "../config.js";
import { DeepSeekClient } from "../deepseek/client.js";
import { createProxyServer } from "../http/server.js";
import { isLoopbackHost } from "../http/security.js";
import { createLogger } from "../logger.js";
import { ChatRunner } from "../services/chat-runner.js";
import { CompletionService } from "../services/completion-service.js";
import { SessionStore } from "../sessions/session-store.js";

/** Composition root: wires the pool, sessions, client, services and HTTP server */
export async function runServe(config: Config): Promise<void> {
  const log = createLogger("serve");
  const { server: serverConfig } = config;

  if (serverConfig.requireApiKey && !serverConfig.apiKey) {
    throw new Error(
      "DSPROXY_API_KEY is required. Set it, or mount a secret and set DSPROXY_API_KEY_FILE.",
    );
  }
  if (!isLoopbackHost(serverConfig.host) && !serverConfig.apiKey) {
    log.warn(
      `DSPROXY_HOST=${serverConfig.host} exposes the proxy without authentication. Set DSPROXY_API_KEY or bind to 127.0.0.1.`,
    );
  }

  const pool = AccountPool.fromConfig(
    config.accounts.authPaths,
    config.accounts.authDir,
    config.accounts.cooldownMs,
  );
  if (pool.size === 0)
    throw new Error(
      "No valid DeepSeek auth found. Run `dsproxy auth` or `dsproxy import` first.",
    );

  const sessions = new SessionStore(config.sessions);
  const client = new DeepSeekClient(pool, config.upstream);
  const runner = new ChatRunner(pool, client, sessions);
  const service = new CompletionService(config, sessions, runner);
  const server = createProxyServer({ config, pool, sessions, service });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverConfig.port, serverConfig.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log.info(
    `dsproxy listening on http://${serverConfig.host}:${serverConfig.port}`,
  );

  setInterval(
    () => {
      const removed = sessions.sweep();
      if (removed > 0)
        log.info(`swept ${removed} idle session(s); ${sessions.size} remain`);
    },
    10 * 60 * 1000,
  ).unref();

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) =>
    log.error("unhandledRejection:", reason),
  );
}
