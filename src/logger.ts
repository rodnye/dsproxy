export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
let threshold: LogLevel = "info";

export function setLogLevel(level: string): void {
  if (level in LEVELS) threshold = level as LogLevel;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

/** Never log tokens, cookies or prompt contents through this logger */
export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, args: unknown[]): void => {
    if (LEVELS[level] < LEVELS[threshold]) return;
    const prefix = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}]`;
    const sink =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    sink(prefix, ...args);
  };
  return {
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}
