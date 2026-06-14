#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = resolve(ROOT_DIR, "index.html");
const ROTATOR_FILE = resolve(ROOT_DIR, "rotator.mjs");
const APP_NAME = "opencode-chatgpt-account-rotator";
const LEGACY_ACCOUNTS_FILE = resolve(ROOT_DIR, "accounts.json");

function userConfigDir(appName = APP_NAME) {
  if (process.env.ROTATOR_CONFIG_DIR) return resolve(process.env.ROTATOR_CONFIG_DIR);
  if (process.platform === "win32") return resolve(process.env.APPDATA || resolve(homedir(), "AppData/Roaming"), appName);
  if (process.platform === "darwin") return resolve(homedir(), "Library/Application Support", appName);
  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), appName);
}

function defaultOpenCodeAuthFile() {
  if (process.env.OPENCODE_AUTH_FILE) return resolve(process.env.OPENCODE_AUTH_FILE);
  if (process.platform === "win32") {
    const candidates = [
      resolve(homedir(), ".local/share/opencode/auth.json"),
      resolve(process.env.LOCALAPPDATA || resolve(homedir(), "AppData/Local"), "opencode", "auth.json"),
    ];
    return candidates.find((filePath) => existsSync(filePath)) || candidates[0];
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library/Application Support", "opencode", "auth.json");
  return resolve(process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"), "opencode", "auth.json");
}

const ACCOUNTS_FILE = process.env.ROTATOR_ACCOUNTS_FILE
  ? resolve(process.env.ROTATOR_ACCOUNTS_FILE)
  : existsSync(LEGACY_ACCOUNTS_FILE)
    ? LEGACY_ACCOUNTS_FILE
    : resolve(userConfigDir(), "accounts.json");
const AUTH_FILE = process.env.ROTATOR_AUTH_FILE
  ? resolve(process.env.ROTATOR_AUTH_FILE)
  : defaultOpenCodeAuthFile();
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.ROTATOR_GUI_PORT || "4317", 10);
const ORIGIN = `http://${HOST}:${PORT}`;
const API_TOKEN = process.env.ROTATOR_API_TOKEN || randomBytes(32).toString("base64url");
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_LINES = 240;

let watchProcess = null;
const watchLogs = [];

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return null;
  return JSON.parse(content);
}

function readJsonControlled(filePath) {
  try {
    return { data: readJson(filePath), error: null };
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : String(error.message || error);
    return { data: null, error: `Invalid JSON in ${filePath}: ${message}` };
  }
}

function readAccountsControlled() {
  const primary = readJsonControlled(ACCOUNTS_FILE);
  return primary;
}

function maskIdentifier(value) {
  if (!value || typeof value !== "string") return null;
  if (value.length <= 14) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function accountIdentity(acc, index) {
  const stableCredentialId = acc?.openai?.accountId || acc?.openai?.refresh || "unknown";
  return `${stableCredentialId}:${acc?.addedAt || ""}:${acc?.label || ""}:${index}`;
}

function accountKey(acc, index) {
  return createHmac("sha256", API_TOKEN).update(String(accountIdentity(acc, index))).digest("base64url");
}

function safeAccount(acc, index, activeIndex, authAccountId) {
  return {
    index,
    accountKey: accountKey(acc, index),
    label: acc?.label || `account-${index + 1}`,
    status: acc?.status || "unknown",
    active: index === activeIndex,
    inAuth: Boolean(acc?.openai?.accountId && acc.openai.accountId === authAccountId),
    accountId: maskIdentifier(acc?.openai?.accountId),
    addedAt: acc?.addedAt || null,
    cooldownUntil: acc?.cooldownUntil || null,
    disableReason: acc?.disableReason || null,
    usageBlockedUntil: acc?.usageBlockedUntil || null,
    usageBlockReason: acc?.usageBlockReason || null,
    lastSwitchReason: acc?.lastSwitchReason || null,
    codexUsage: acc?.codexUsage || null,
  };
}

function getState() {
  const stateErrors = [];
  const accountsResult = readAccountsControlled();
  const authResult = readJsonControlled(AUTH_FILE);
  if (accountsResult.error) stateErrors.push(accountsResult.error);
  if (authResult.error) stateErrors.push(authResult.error);

  const accountsData = accountsResult.data || { activeIndex: 0, accounts: [] };
  const authData = authResult.data;
  const activeIndex = Number.isInteger(accountsData.activeIndex) ? accountsData.activeIndex : 0;
  const accounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
  const authAccountId = authData?.openai?.accountId || null;

  return {
    activeIndex,
    authAccountId: maskIdentifier(authAccountId),
    authExists: Boolean(authData?.openai),
    accountsFile: ACCOUNTS_FILE,
    authFile: AUTH_FILE,
    stateErrors,
    accounts: accounts.map((acc, index) => safeAccount(acc, index, activeIndex, authAccountId)),
    watch: {
      running: Boolean(watchProcess),
      pid: watchProcess?.pid || null,
      logs: watchLogs.slice(-MAX_LOG_LINES),
    },
  };
}

function appendWatchLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    watchLogs.push({ at: Date.now(), line });
  }
  if (watchLogs.length > MAX_LOG_LINES) {
    watchLogs.splice(0, watchLogs.length - MAX_LOG_LINES);
  }
}

function runRotator(args) {
  return new Promise((resolveCommand) => {
    const child = spawn(process.execPath, [ROTATOR_FILE, ...args], {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveCommand({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolveCommand({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function normalizeThresholdPercent(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return null;
  if (threshold < 0) return 0;
  if (threshold > 100) return 100;
  return Math.round(threshold);
}

function startWatch(intervalMs, thresholdPercent) {
  if (watchProcess) {
    return { ok: true, message: "Watch already running.", pid: watchProcess.pid };
  }

  const args = [ROTATOR_FILE, "watch"];
  if (Number.isFinite(intervalMs) && intervalMs >= 1000) {
    args.push(`--interval=${Math.round(intervalMs)}`);
  }

  const normalizedThreshold = normalizeThresholdPercent(thresholdPercent);
  const env = normalizedThreshold === null
    ? process.env
    : { ...process.env, CODEX_USAGE_THRESHOLD_PERCENT: String(normalizedThreshold) };

  watchProcess = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  appendWatchLog(`GUI started watch process ${watchProcess.pid}${normalizedThreshold === null ? "" : ` with ${normalizedThreshold}% threshold`}.`);
  watchProcess.stdout.on("data", appendWatchLog);
  watchProcess.stderr.on("data", appendWatchLog);
  watchProcess.on("error", (error) => {
    appendWatchLog(`watch error: ${error.message}`);
  });
  watchProcess.on("close", (code) => {
    appendWatchLog(`watch stopped with code ${code}.`);
    watchProcess = null;
  });

  return { ok: true, message: "Watch started.", pid: watchProcess.pid };
}

function stopWatch() {
  if (!watchProcess) {
    return { ok: true, message: "Watch is not running." };
  }

  const pid = watchProcess.pid;
  watchProcess.kill("SIGTERM");
  appendWatchLog(`GUI requested watch stop for process ${pid}.`);
  return { ok: true, message: "Watch stop requested.", pid };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function isSameOriginRequest(request) {
  const origin = request.headers.origin;
  if (origin && origin !== ORIGIN) return false;

  const referer = request.headers.referer;
  if (referer) {
    try {
      return new URL(referer).origin === ORIGIN;
    } catch {
      return false;
    }
  }

  return true;
}

function validatePostRequest(request) {
  const contentType = request.headers["content-type"] || "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    return "POST requests must use application/json.";
  }

  if (!isSameOriginRequest(request)) {
    return "Cross-origin requests are not allowed.";
  }

  const token = request.headers["x-rotator-token"] || request.headers["x-rotator-csrf"];
  if (token !== API_TOKEN) {
    return "Invalid rotator API token.";
  }

  return null;
}

function parseBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        rejectBody(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolveBody({});
        return;
      }

      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          rejectBody(new Error("Request body must be a JSON object."));
          return;
        }
        resolveBody(parsed);
      } catch {
        rejectBody(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", rejectBody);
  });
}

function toIndex(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("A valid account index is required.");
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("A valid account index is required.");
  }
  const index = Number(text);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("A valid account index is required.");
  }
  return index;
}

function toLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length > 80) {
    throw new Error("Label must be 80 characters or less.");
  }
  return label;
}

function resolveAccountTarget(body) {
  const index = toIndex(body.index);
  const expectedKey = typeof body.accountKey === "string" ? body.accountKey : "";
  if (!expectedKey) {
    const error = new Error("A stable account key is required. Refresh the dashboard and try again.");
    error.statusCode = 409;
    throw error;
  }

  const accountsResult = readAccountsControlled();
  if (accountsResult.error) {
    const error = new Error(accountsResult.error);
    error.statusCode = 409;
    throw error;
  }
  const accounts = Array.isArray(accountsResult.data?.accounts) ? accountsResult.data.accounts : [];
  const account = accounts[index];
  if (!account || accountKey(account, index) !== expectedKey) {
    const error = new Error("Account list changed. Refresh the dashboard before retrying this action.");
    error.statusCode = 409;
    throw error;
  }

  return String(index);
}

function safeState() {
  return getState();
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, { ok: true, state: getState() });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  const validationError = validatePostRequest(request);
  if (validationError) {
    sendJson(response, 403, { ok: false, error: validationError });
    return;
  }

  let body;
  try {
    body = await parseBody(request);
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
    return;
  }

  try {
    let result;
    switch (url.pathname) {
      case "/api/add":
        result = await runRotator(["add", toLabel(body.label)].filter(Boolean));
        break;
      case "/api/switch":
        result = await runRotator(["switch", body.index === undefined ? undefined : resolveAccountTarget(body)].filter(Boolean));
        break;
      case "/api/enable":
        result = await runRotator(["enable", resolveAccountTarget(body)]);
        break;
      case "/api/disable":
        result = await runRotator(["disable", resolveAccountTarget(body), toLabel(body.reason) || "manual_gui_disable"]);
        break;
      case "/api/delete":
        result = await runRotator(["delete", resolveAccountTarget(body)]);
        break;
      case "/api/probe":
        result = await runRotator(["probe", resolveAccountTarget(body)]);
        break;
      case "/api/usage":
        result = await runRotator(body.index === undefined ? ["usage", "--all", "--json"] : ["usage", resolveAccountTarget(body), "--json"]);
        break;
      case "/api/usage/account":
        result = await runRotator(["usage", resolveAccountTarget(body), "--json"]);
        break;
      case "/api/watch/start":
        sendJson(response, 200, { ...startWatch(Number(body.intervalMs), body.thresholdPercent), state: getState() });
        return;
      case "/api/watch/stop":
        sendJson(response, 200, { ...stopWatch(), state: getState() });
        return;
      default:
        sendJson(response, 404, { ok: false, error: "API route not found." });
        return;
    }

    sendJson(response, result.ok ? 200 : 400, { ...result, state: safeState() });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message, state: safeState() });
  }
}

const server = createServer(async (request, response) => {
  const host = request.headers.host || "";
  if (!host.startsWith(`${HOST}:`) && host !== HOST) {
    sendText(response, 403, "Forbidden");
    return;
  }

  const url = new URL(request.url || "/", `http://${host}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(readFileSync(INDEX_FILE, "utf8").replace("__ROTATOR_CSRF_TOKEN__", API_TOKEN));
    return;
  }

  sendText(response, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Rotator GUI running at http://${HOST}:${PORT}`);
  if (!process.env.ROTATOR_API_TOKEN) {
    console.log("Set OPENCODE_ROTATOR_TOKEN to the displayed session token for TUI POST actions.");
    console.log(`OPENCODE_ROTATOR_TOKEN=${API_TOKEN}`);
  }
});

process.on("SIGINT", () => {
  stopWatch();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  stopWatch();
  server.close(() => process.exit(0));
});
