import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import readline from "node:readline/promises";
import {
  normalizeAuth,
  validateAuth,
  writeAuthFile,
} from "../accounts/auth-file.js";
import type { AuthData } from "../accounts/types.js";
import { CdpClient, type CdpEvent } from "../auth/cdp.js";
import type { Config } from "../config.js";
import { DEEPSEEK_ORIGIN } from "../deepseek/constants.js";
import { isRecord } from "../util/json.js";
import { sleep } from "../util/time.js";

type Env = Record<string, string | undefined>;

interface DevtoolsTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

const PAGE_STATE_EXPRESSION = `(() => {
  const dump = (store) => Object.fromEntries(
    Array.from({ length: store.length }, (_, i) => { const key = store.key(i); return [key, store.getItem(key)]; })
  );
  return {
    href: location.href,
    localStorage: dump(localStorage),
    sessionStorage: dump(sessionStorage),
    resources: performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /sha3.*\\.wasm/.test(n)).slice(-20),
  };
})()`;

const TOKEN_KEYS = [
  "userToken",
  "token",
  "auth_token",
  "access_token",
  "accessToken",
];

function findOnPath(names: readonly string[], env: Env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveChromePath(env: Env): string | null {
  const explicit = env.DSPROXY_CHROME_PATH || env.CHROME_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const base of [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
    ]) {
      if (base)
        candidates.push(
          path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
        );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  }
  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    findOnPath(
      [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
      ],
      env,
    )
  );
}

const CHROME_HELP = `Chrome/Chromium not found.
  Windows (PowerShell): $env:DSPROXY_CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; dsproxy auth
  macOS:  DSPROXY_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" dsproxy auth
  Linux:  DSPROXY_CHROME_PATH=$(which chromium) dsproxy auth`;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function waitForDevtools(port: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function findPageTarget(
  port: number,
): Promise<DevtoolsTarget & { webSocketDebuggerUrl: string }> {
  for (let i = 0; i < 40; i++) {
    const targets = await fetchJson<DevtoolsTarget[]>(
      `http://127.0.0.1:${port}/json`,
    );
    const pages = targets.filter(
      (target) => target.type === "page" && target.webSocketDebuggerUrl,
    );
    const page =
      pages.find((target) => target.url.includes("chat.deepseek.com")) ??
      pages[0];
    if (page?.webSocketDebuggerUrl)
      return page as DevtoolsTarget & { webSocketDebuggerUrl: string };
    await sleep(250);
  }
  throw new Error("No Chrome page target found");
}

function normalizeToken(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      for (const key of ["value", "token", "access_token", "accessToken"]) {
        if (typeof parsed[key] === "string") return parsed[key] as string;
      }
      return "";
    }
  } catch {
    // not JSON: use as-is
  }
  return raw.trim();
}

function tokenFromStores(stores: Record<string, unknown>[]): string {
  for (const store of stores) {
    for (const key of TOKEN_KEYS) {
      const token = normalizeToken(store[key]);
      if (token) return token;
    }
  }
  for (const store of stores) {
    for (const [key, value] of Object.entries(store)) {
      if (/token/i.test(key)) {
        const token = normalizeToken(value);
        if (token) return token;
      }
    }
  }
  return "";
}

/** The web client sends these headers on API calls; they are only visible on the wire */
function scanHeaders(events: readonly CdpEvent[]): {
  dliq: string;
  leim: string;
  bearer: string;
} {
  const found = { dliq: "", leim: "", bearer: "" };
  for (const event of events) {
    const headers = event.params.headers ?? event.params.request?.headers;
    if (!headers) continue;
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (key === "x-hif-dliq") found.dliq = value;
      else if (key === "x-hif-leim") found.leim = value;
      else if (key === "authorization" && /^Bearer\s+/i.test(value))
        found.bearer = value.replace(/^Bearer\s+/i, "");
    }
  }
  return found;
}

async function readAuthFromPage(
  cdp: CdpClient,
): Promise<{ auth: AuthData; cookieCount: number }> {
  const evaluated = await cdp.send<{ result: { value?: unknown } }>(
    "Runtime.evaluate",
    {
      expression: PAGE_STATE_EXPRESSION,
      returnByValue: true,
    },
  );
  const page = isRecord(evaluated.result.value) ? evaluated.result.value : {};
  const stores = [page.localStorage, page.sessionStorage].filter(isRecord);
  const resources = Array.isArray(page.resources)
    ? page.resources.filter((r): r is string => typeof r === "string")
    : [];

  const cookieResult = await cdp.send<{
    cookies?: { name: string; value: string; domain: string }[];
  }>("Network.getAllCookies");
  const cookies = (cookieResult.cookies ?? []).filter((cookie) =>
    /deepseek\.com$/.test(cookie.domain),
  );
  const headers = scanHeaders(cdp.recentEvents());

  const auth = normalizeAuth({
    token: tokenFromStores(stores) || headers.bearer,
    cookie: cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
    hif_dliq: headers.dliq,
    hif_leim: headers.leim,
    wasmUrl: resources.find((resource) => /sha3.*\.wasm/.test(resource)) ?? "",
  });
  return { auth, cookieCount: cookies.length };
}

function chromeArgs(profileDir: string, port: number): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    `${DEEPSEEK_ORIGIN}/`,
  ];
}

async function ask(question: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question(question);
  rl.close();
}

/** `dsproxy auth`: opens an isolated Chrome profile, waits for the login and stores the credentials */
export async function runAuth(
  config: Config,
  argv: string[],
  env: Env = process.env,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { output: { type: "string", short: "o" } },
    strict: true,
  });
  const outPath = path.resolve(
    values.output ?? config.accounts.authPaths[0] ?? "deepseek-auth.json",
  );

  const chromePath = resolveChromePath(env);
  if (!chromePath) {
    console.error(CHROME_HELP);
    return 1;
  }

  const port = Number(env.DSPROXY_CHROME_PORT) || 9334;
  const keepProfile = /^(1|true|yes|on)$/i.test(env.DSPROXY_KEEP_PROFILE ?? "");
  const profileDir =
    env.DSPROXY_CHROME_PROFILE ||
    mkdtempSync(path.join(os.tmpdir(), "dsproxy-chrome-"));
  let chrome: ChildProcess | null = null;
  let cdp: CdpClient | null = null;

  try {
    console.log(`[auth] Starting Chrome with profile ${profileDir}`);
    chrome = spawn(chromePath, chromeArgs(profileDir, port), {
      stdio: "ignore",
    });
    await waitForDevtools(port);
    const target = await findPageTarget(port);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    console.log(
      "\n[auth] Log in to DeepSeek in the Chrome window that just opened.",
    );
    console.log(
      '[auth] After logging in, send a short message such as "ok" so the web client initializes.',
    );
    await ask("[auth] Press ENTER here when done: ");

    let result = await readAuthFromPage(cdp);
    for (let i = 0; i < 20 && validateAuth(result.auth).length > 0; i++) {
      await sleep(500);
      result = await readAuthFromPage(cdp);
    }

    const problems = validateAuth(result.auth);
    if (problems.length > 0) {
      console.error(
        `[auth] Incomplete credentials (${problems.join(", ")}). Nothing was saved. Make sure you are logged in.`,
      );
      return 2;
    }
    writeAuthFile(outPath, result.auth);
    console.log(`[auth] Saved ${outPath}`);
    console.log(
      `[auth] token: OK (${result.auth.token.length} chars), cookies: ${result.cookieCount}`,
    );
    console.log(
      `[auth] hif headers: ${result.auth.hifDliq || result.auth.hifLeim ? "captured" : "not captured (optional)"}`,
    );
    return 0;
  } finally {
    cdp?.close();
    chrome?.kill();
    if (!keepProfile && !env.DSPROXY_CHROME_PROFILE) {
      await sleep(300);
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      });
    }
  }
}
