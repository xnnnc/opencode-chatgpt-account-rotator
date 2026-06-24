#!/usr/bin/env node

/**
 * opencode-chatgpt-account-rotator
 *
 * Simple account rotator for OpenCode.
 * - accounts.json: pool of all accounts + active index
 * - auth.json: OpenCode reads this file for credentials
 * - On rate limit / quota: swap auth.json to next healthy account
 * - Token refresh: auto-refresh expired access tokens
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_NAME = "opencode-chatgpt-account-rotator";
const LEGACY_ACCOUNTS_FILE = resolve(SCRIPT_DIR, "accounts.json");

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
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_USAGE_THRESHOLD_PERCENT = normalizeThreshold(process.env.CODEX_USAGE_THRESHOLD_PERCENT, 95);
const UNGROUPED_GROUP_SENTINEL = "__ungrouped__";

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return null;

  try {
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof SyntaxError ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readAccounts() {
  const data = readJson(ACCOUNTS_FILE);
  if (!data) return { activeIndex: 0, accounts: [] };
  return data;
}

function parseStrictIndex(value, maxExclusive, label = "index") {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value ?? "missing"}. Expected a non-negative integer.`);
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= maxExclusive) {
    throw new Error(`Invalid ${label}: ${value}. Valid: 0-${Math.max(0, maxExclusive - 1)}`);
  }
  return index;
}

function parsePositiveInteger(value, label) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value ?? "missing"}. Expected a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}. Expected a positive integer.`);
  }
  return parsed;
}

function normalizeGroup(value) {
  const group = typeof value === "string" ? value.trim() : "";
  if (group.length > 60) {
    throw new Error("Group must be 60 characters or less.");
  }
  return group;
}

function normalizeLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label) {
    throw new Error("Label is required.");
  }
  if (label.length > 80) {
    throw new Error("Label must be 80 characters or less.");
  }
  return label;
}

function accountInGroup(acc, group) {
  const normalizedGroup = normalizeGroup(group);
  if (!normalizedGroup) return true;
  if (normalizedGroup === UNGROUPED_GROUP_SENTINEL) return !normalizeGroup(acc?.group);
  return normalizeGroup(acc?.group) === normalizedGroup;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function writeAccounts(data) {
  writeJson(ACCOUNTS_FILE, data);
}

function readAuth() {
  return readJson(AUTH_FILE);
}

function writeAuth(authData) {
  writeJson(AUTH_FILE, authData);
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeThreshold(value, fallback) {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

function parseJwtPayload(token) {
  if (!token || typeof token !== "string") return null;

  const [, payload] = token.split(".");
  if (!payload) return null;

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);

  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveAccountId(openai = {}) {
  if (openai.accountId) return openai.accountId;
  const payload = parseJwtPayload(openai.access);
  return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}

function normalizeResetAtMs(window = {}) {
  const resetAt = toFiniteNumber(window.reset_at ?? window.resetAt);
  if (resetAt !== null) {
    return resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
  }

  const resetAfterSeconds = toFiniteNumber(window.reset_after_seconds ?? window.resetAfterSeconds ?? window.resets_in_seconds);
  if (resetAfterSeconds !== null) {
    return Date.now() + resetAfterSeconds * 1000;
  }

  return null;
}

function normalizeUsageWindow(window) {
  if (!window || typeof window !== "object") return null;

  const usedPercent = toFiniteNumber(window.used_percent ?? window.usedPercent);
  const limitWindowSeconds = toFiniteNumber(window.limit_window_seconds ?? window.limitWindowSeconds ?? window.window_seconds);
  const resetAt = normalizeResetAtMs(window);

  if (usedPercent === null && limitWindowSeconds === null && resetAt === null) {
    return null;
  }

  return {
    usedPercent,
    limitWindowSeconds,
    resetAt,
  };
}

function normalizeCodexUsage(payload) {
  const primaryWindow = normalizeUsageWindow(
    payload?.rate_limit?.primary_window ?? payload?.primaryWindow ?? payload?.five_hour ?? payload?.fiveHour
  );
  const secondaryWindow = normalizeUsageWindow(
    payload?.rate_limit?.secondary_window ?? payload?.secondaryWindow ?? payload?.weekly ?? payload?.seven_day ?? payload?.sevenDay
  );

  const usagePercents = [primaryWindow?.usedPercent, secondaryWindow?.usedPercent].filter((value) => value !== null);
  const maxUsedPercent = usagePercents.length > 0 ? Math.max(...usagePercents) : null;
  const credits = payload?.credits && typeof payload.credits === "object"
    ? {
        hasCredits: typeof payload.credits.has_credits === "boolean" ? payload.credits.has_credits : null,
        unlimited: typeof payload.credits.unlimited === "boolean" ? payload.credits.unlimited : null,
        overageLimitReached: typeof payload.credits.overage_limit_reached === "boolean" ? payload.credits.overage_limit_reached : null,
        balance: toFiniteNumber(payload.credits.balance),
      }
    : null;

  return {
    endpoint: CODEX_USAGE_URL,
    fetchedAt: Date.now(),
    planType: typeof payload?.plan_type === "string" ? payload.plan_type : null,
    limitReached: Boolean(payload?.rate_limit?.limit_reached),
    maxUsedPercent,
    primaryWindow,
    secondaryWindow,
    credits,
    lastError: null,
  };
}

function getActiveUsageWindow(usage) {
  if (!usage) return null;

  const candidates = [usage.primaryWindow, usage.secondaryWindow].filter(Boolean);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, current) => {
    if (!best) return current;
    const bestPercent = best.usedPercent ?? -1;
    const currentPercent = current.usedPercent ?? -1;
    if (currentPercent > bestPercent) return current;
    if (currentPercent < bestPercent) return best;

    const bestReset = best.resetAt ?? Number.MAX_SAFE_INTEGER;
    const currentReset = current.resetAt ?? Number.MAX_SAFE_INTEGER;
    return currentReset < bestReset ? current : best;
  }, null);
}

function clearExpiredUsageBlock(acc) {
  if (acc?.usageBlockedUntil && acc.usageBlockedUntil <= Date.now()) {
    delete acc.usageBlockedUntil;
    delete acc.usageBlockReason;
  }
}

function isUsageBlocked(acc) {
  clearExpiredUsageBlock(acc);
  return Boolean(acc?.usageBlockedUntil && acc.usageBlockedUntil > Date.now());
}

function buildUsageErrorSnapshot(error) {
  return {
    endpoint: CODEX_USAGE_URL,
    fetchedAt: Date.now(),
    lastError: error instanceof Error ? error.message : String(error),
  };
}

function formatUsageWindow(label, window) {
  if (!window) return `${label}: n/a`;
  const percent = window.usedPercent === null ? "n/a" : `${window.usedPercent}%`;
  const reset = window.resetAt ? new Date(window.resetAt).toLocaleString() : "unknown reset";
  const duration = window.limitWindowSeconds ? `${Math.round(window.limitWindowSeconds / 3600)}h` : "?h";
  return `${label}: ${percent} / ${duration} (reset: ${reset})`;
}

function formatUsageSummary(acc) {
  const usage = acc?.codexUsage;
  if (!usage) return null;
  if (usage.lastError) return `usage error: ${usage.lastError}`;

  const parts = [];
  if (usage.planType) parts.push(`plan: ${usage.planType}`);
  if (usage.limitReached) parts.push("limit reached");
  if (usage.maxUsedPercent !== null) parts.push(`max usage: ${usage.maxUsedPercent}%`);
  parts.push(formatUsageWindow("5h", usage.primaryWindow));
  parts.push(formatUsageWindow("7d", usage.secondaryWindow));
  return parts.join(" | ");
}

function buildSelectionCandidate(accounts, idx, thresholdPercent) {
  const acc = accounts.accounts[idx];
  const usage = acc.codexUsage;
  const hasUsage = Boolean(usage && !usage.lastError && usage.maxUsedPercent !== null);
  const overThreshold = Boolean(usage && !usage.lastError && (usage.limitReached || (usage.maxUsedPercent !== null && usage.maxUsedPercent >= thresholdPercent)));
  const distance = ((idx - accounts.activeIndex) + accounts.accounts.length) % accounts.accounts.length;

  return {
    idx,
    hasUsage,
    overThreshold,
    maxUsedPercent: hasUsage ? usage.maxUsedPercent : Number.POSITIVE_INFINITY,
    distance,
  };
}

function choosePreferredAccount(accounts, thresholdPercent = DEFAULT_USAGE_THRESHOLD_PERCENT, excludedIndices = new Set(), group = "") {
  const candidates = [];

  for (let idx = 0; idx < accounts.accounts.length; idx += 1) {
    if (excludedIndices.has(idx)) continue;
    const acc = accounts.accounts[idx];
    if (!accountInGroup(acc, group)) continue;
    if (!acc || acc.status !== "healthy" || isUsageBlocked(acc)) continue;
    candidates.push(buildSelectionCandidate(accounts, idx, thresholdPercent));
  }

  if (candidates.length === 0) return -1;

  candidates.sort((a, b) => {
    if (a.overThreshold !== b.overThreshold) return a.overThreshold ? 1 : -1;
    if (a.hasUsage !== b.hasUsage) return a.hasUsage ? -1 : 1;
    if (a.maxUsedPercent !== b.maxUsedPercent) return a.maxUsedPercent - b.maxUsedPercent;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.idx - b.idx;
  });

  return candidates[0].idx;
}

function chooseNextHealthyAccount(accounts, excludedIndices = new Set(), group = "") {
  const total = accounts.accounts.length;
  if (total === 0) return -1;

  for (let offset = 1; offset <= total; offset += 1) {
    const idx = (accounts.activeIndex + offset) % total;
    if (excludedIndices.has(idx)) continue;

    const acc = accounts.accounts[idx];
    if (!accountInGroup(acc, group)) continue;
    if (acc?.status === "healthy" && !isUsageBlocked(acc)) return idx;
  }

  return -1;
}

function getUsageSwitchReason(acc, thresholdPercent = DEFAULT_USAGE_THRESHOLD_PERCENT) {
  const usage = acc?.codexUsage;
  if (!usage || usage.lastError) return null;
  if (usage.limitReached) return "usage_limit_reached";
  if (usage.maxUsedPercent !== null && usage.maxUsedPercent >= thresholdPercent) {
    return "usage_threshold_exceeded";
  }
  return null;
}

function getUsageBlockUntil(acc) {
  const usage = acc?.codexUsage;
  const activeWindow = getActiveUsageWindow(usage);
  return activeWindow?.resetAt ?? (Date.now() + 15 * 60_000);
}

async function refreshStoredToken(acc, force = false) {
  if (!acc?.openai?.refresh) return false;

  const expiresAt = acc.openai.expires || 0;
  const shouldRefresh = force || expiresAt === 0 || Date.now() >= expiresAt - 120_000;
  if (!shouldRefresh) return false;

  const refreshed = await refreshAccessToken(acc.openai.refresh);
  acc.openai.access = refreshed.access_token;
  acc.openai.refresh = refreshed.refresh_token;
  acc.openai.expires = Date.now() + refreshed.expires_in * 1000;
  acc.openai.accountId = resolveAccountId(acc.openai) ?? acc.openai.accountId;
  return true;
}

async function fetchCodexUsageForAccount(acc) {
  if (!acc?.openai?.access) {
    throw new Error("Missing access token for Codex usage request");
  }

  await refreshStoredToken(acc);

  const requestUsage = async () => {
    const headers = {
      Authorization: `Bearer ${acc.openai.access}`,
      Accept: "application/json",
    };

    const accountId = resolveAccountId(acc.openai);
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    return fetch(CODEX_USAGE_URL, { headers });
  };

  let response = await requestUsage();
  if ((response.status === 401 || response.status === 403) && acc?.openai?.refresh) {
    await refreshStoredToken(acc, true);
    response = await requestUsage();
  }

  if (!response.ok) {
    throw new Error(`Codex usage request failed: ${response.status} ${response.statusText}`);
  }

  return normalizeCodexUsage(await response.json());
}

async function refreshUsageSnapshots(accounts, indices = null) {
  const targetIndices = Array.isArray(indices)
    ? indices
    : accounts.accounts.map((_, idx) => idx).filter((idx) => accounts.accounts[idx]?.status !== "disabled");

  if (targetIndices.length === 0) return;

  const concurrency = Math.max(1, Math.min(4, targetIndices.length));

  for (let start = 0; start < targetIndices.length; start += concurrency) {
    const batch = targetIndices.slice(start, start + concurrency);

    await Promise.all(batch.map(async (idx) => {
      const acc = accounts.accounts[idx];
      if (!acc || acc.status === "disabled") return;

      clearExpiredUsageBlock(acc);

      try {
        acc.codexUsage = await fetchCodexUsageForAccount(acc);
        if (!getUsageSwitchReason(acc)) {
          delete acc.usageBlockedUntil;
          delete acc.usageBlockReason;
        }
      } catch (error) {
        acc.codexUsage = buildUsageErrorSnapshot(error);
      }
    }));
  }
}

function writeActiveAccount(accounts, nextIdx) {
  const nextAcc = accounts.accounts[nextIdx];
  const auth = readAuth() || {};
  auth.openai = { ...nextAcc.openai };
  writeAuth(auth);
  accounts.activeIndex = nextIdx;
}

async function maybeRotateOnUsage(thresholdPercent = DEFAULT_USAGE_THRESHOLD_PERCENT, group = "") {
  const accounts = readAccounts();
  const currentIdx = accounts.activeIndex;
  const currentAcc = accounts.accounts[currentIdx];

  if (!currentAcc || currentAcc.status === "disabled") return;

  if (!accountInGroup(currentAcc, group)) {
    const nextIdx = choosePreferredAccount(accounts, thresholdPercent, new Set(), group);
    if (nextIdx === -1) {
      console.log(`[watch] Active account is outside group "${group}", but no healthy account exists in that group.`);
      return;
    }

    writeActiveAccount(accounts, nextIdx);
    writeAccounts(accounts);
    console.log(`[watch] ✓ Switched to group "${group}" account "${accounts.accounts[nextIdx].label}" (index: ${nextIdx})`);
    return;
  }

  await refreshUsageSnapshots(accounts, [currentIdx]);

  const switchReason = getUsageSwitchReason(currentAcc, thresholdPercent);

  if (!switchReason) {
    writeAccounts(accounts);
    return;
  }

  const nextIdx = chooseNextHealthyAccount(accounts, new Set([currentIdx]), group);
  if (nextIdx === -1) {
    writeAccounts(accounts);
    console.log(`[usage] "${currentAcc.label}" crossed the ${thresholdPercent}% threshold, but no alternate healthy account is available${group ? ` in group "${group}"` : ""}.`);
    return;
  }

  currentAcc.usageBlockedUntil = getUsageBlockUntil(currentAcc);
  currentAcc.usageBlockReason = switchReason;
  currentAcc.lastSwitchReason = switchReason;

  writeActiveAccount(accounts, nextIdx);
  writeAccounts(accounts);

  console.log(`[usage] ✓ Switched from "${currentAcc.label}" to "${accounts.accounts[nextIdx].label}" (reason: ${switchReason})`);
}

// ── Token Refresh ────────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  const body = JSON.stringify({
    client_id: OPENAI_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? 3600,
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * add - Read current auth.json, save it as a new account in accounts.json.
 * Usage: node rotator.mjs add [label]
 */
function cmdAdd(label, groupValue) {
  const auth = readAuth();
  if (!auth?.openai) {
    console.error("Error: No openai entry found in auth.json. Run 'opencode auth login' first.");
    process.exit(1);
  }

  const accounts = readAccounts();
  const entry = {
    label: label || `account-${accounts.accounts.length + 1}`,
    group: normalizeGroup(groupValue),
    openai: { ...auth.openai },
    status: "healthy",
    addedAt: Date.now(),
  };

  accounts.accounts.push(entry);
  accounts.activeIndex = accounts.accounts.length - 1;
  writeAccounts(accounts);

  console.log(`✓ Added "${entry.label}" (group: ${entry.group || "ungrouped"}, accountId: ${auth.openai.accountId || "unknown"})`);
  console.log(`  Total accounts: ${accounts.accounts.length}`);
}

/**
 * status - Show all accounts and which one is active.
 */
function cmdStatus() {
  const accounts = readAccounts();
  if (accounts.accounts.length === 0) {
    console.log("No accounts registered. Run 'node rotator.mjs add' after logging in.");
    return;
  }

  const auth = readAuth();
  const currentAccountId = auth?.openai?.accountId;

  console.log(`Active index: ${accounts.activeIndex}`);
  console.log(`Active auth.json accountId: ${currentAccountId || "unknown"}`);
  console.log("");

  accounts.accounts.forEach((acc, i) => {
    clearExpiredUsageBlock(acc);
    const active = i === accounts.activeIndex ? " ← ACTIVE" : "";
    const matchTag = acc.openai?.accountId === currentAccountId ? " [in auth.json]" : "";
    const group = normalizeGroup(acc.group) || "ungrouped";
    console.log(`  [${i}] ${acc.label} | group: ${group} | status: ${acc.status} | accountId: ${acc.openai?.accountId || "?"}${active}${matchTag}`);
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) {
      console.log(`      cooldown until: ${new Date(acc.cooldownUntil).toLocaleString()}`);
    }
    if (acc.disableReason) {
      console.log(`      disabled: ${acc.disableReason}`);
    }
    if (acc.usageBlockedUntil && acc.usageBlockedUntil > Date.now()) {
      console.log(`      usage blocked until: ${new Date(acc.usageBlockedUntil).toLocaleString()} (${acc.usageBlockReason || "usage"})`);
    }
    const usageSummary = formatUsageSummary(acc);
    if (usageSummary) {
      console.log(`      ${usageSummary}`);
    }
  });
}

/**
 * group <index> [group] - Set or clear an account group.
 */
function cmdGroup(indexStr, groupValue) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);
  const group = normalizeGroup(groupValue);
  const acc = accounts.accounts[index];

  if (group) {
    acc.group = group;
  } else {
    delete acc.group;
  }

  writeAccounts(accounts);
  console.log(`✓ Set group for "${acc.label}" (index: ${index}) to ${group || "ungrouped"}`);
}

function cmdRename(indexStr, labelValue) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);
  const label = normalizeLabel(labelValue);
  const acc = accounts.accounts[index];
  const oldLabel = acc.label;

  acc.label = label;
  writeAccounts(accounts);
  console.log(`✓ Renamed account "${oldLabel}" (index: ${index}) to "${label}"`);
}

function cmdRenameGroup(oldGroupValue, newGroupValue) {
  const accounts = readAccounts();
  const oldGroup = normalizeGroup(oldGroupValue);
  const newGroup = normalizeGroup(newGroupValue);
  if (!oldGroup) throw new Error("Existing group name is required.");
  if (!newGroup) throw new Error("New group name is required.");

  let changed = 0;
  for (const acc of accounts.accounts) {
    if (normalizeGroup(acc.group) === oldGroup) {
      acc.group = newGroup;
      changed += 1;
    }
  }

  writeAccounts(accounts);
  console.log(`✓ Renamed group "${oldGroup}" to "${newGroup}" on ${changed} account(s)`);
}

function cmdDeleteGroup(groupValue) {
  const accounts = readAccounts();
  const group = normalizeGroup(groupValue);
  if (!group) throw new Error("Group name is required.");

  let changed = 0;
  for (const acc of accounts.accounts) {
    if (normalizeGroup(acc.group) === group) {
      delete acc.group;
      changed += 1;
    }
  }

  writeAccounts(accounts);
  console.log(`✓ Deleted group "${group}" from ${changed} account(s)`);
}

/**
 * switch [index] - Switch auth.json to the account at given index (or next healthy).
 */
function cmdSwitch(targetIndex) {
  const accounts = readAccounts();

  if (accounts.accounts.length === 0) {
    console.error("No accounts to switch to. Run 'node rotator.mjs add' first.");
    process.exit(1);
  }

  let nextIndex;

  if (targetIndex !== undefined) {
    nextIndex = parseStrictIndex(targetIndex, accounts.accounts.length);
    if (accounts.accounts[nextIndex].status === "disabled") {
      fail(`Account "${accounts.accounts[nextIndex].label}" is disabled. Enable it first.`);
    }
  } else {
    nextIndex = choosePreferredAccount(accounts, DEFAULT_USAGE_THRESHOLD_PERCENT, new Set([accounts.activeIndex]));
    if (nextIndex === -1) {
      console.error("No healthy account available to switch to.");
      process.exit(1);
    }
  }

  const acc = accounts.accounts[nextIndex];
  const auth = readAuth() || {};

  auth.openai = { ...acc.openai };
  writeAuth(auth);

  accounts.activeIndex = nextIndex;
  writeAccounts(accounts);

  console.log(`✓ Switched to "${acc.label}" (index: ${nextIndex})`);
}

/**
 * enable <index> - Re-enable a disabled account.
 */
function cmdEnable(indexStr) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);

  const acc = accounts.accounts[index];
  if (acc.status !== "disabled") {
    console.log(`Account "${acc.label}" is already ${acc.status}.`);
    return;
  }

  acc.status = "healthy";
  delete acc.disableReason;
  delete acc.cooldownUntil;
  delete acc.usageBlockedUntil;
  delete acc.usageBlockReason;
  writeAccounts(accounts);

  console.log(`✓ Enabled "${acc.label}" (index: ${index})`);
}

/**
 * disable <index> [reason] - Disable an account.
 */
function cmdDisable(indexStr, reason) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);

  const acc = accounts.accounts[index];
  acc.status = "disabled";
  acc.disableReason = reason || "manually_disabled";
  delete acc.cooldownUntil;
  delete acc.usageBlockedUntil;
  delete acc.usageBlockReason;
  writeAccounts(accounts);

  console.log(`✓ Disabled "${acc.label}" (index: ${index}): ${acc.disableReason}`);
}

/**
 * delete <index> - Remove an account from accounts.json.
 */
function cmdDelete(indexStr) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);

  const wasActive = index === accounts.activeIndex;
  const removed = accounts.accounts.splice(index, 1)[0];

  if (accounts.accounts.length === 0) {
    accounts.activeIndex = 0;
    writeAccounts(accounts);
    console.log(`✓ Deleted "${removed.label}" (index: ${index})`);
    console.log("  No accounts remain. auth.json was left unchanged.");
    return;
  }

  if (wasActive) {
    accounts.activeIndex = Math.min(index, accounts.accounts.length - 1);
    const nextIndex = choosePreferredAccount(accounts);
    if (nextIndex === -1) {
      writeAccounts(accounts);
      console.log(`✓ Deleted "${removed.label}" (index: ${index})`);
      console.log("  No healthy account remains. auth.json was left unchanged.");
      return;
    }

    writeActiveAccount(accounts, nextIndex);
    writeAccounts(accounts);
    console.log(`✓ Deleted "${removed.label}" (index: ${index})`);
    console.log(`  Active account switched to "${accounts.accounts[nextIndex].label}" (index: ${nextIndex})`);
    return;
  }

  if (index < accounts.activeIndex) {
    accounts.activeIndex -= 1;
  }

  writeAccounts(accounts);
  console.log(`✓ Deleted "${removed.label}" (index: ${index})`);
}

/**
 * watch - Periodically check the active account's live usage endpoint.
 *         On threshold breach: auto-switch to next healthy account + refresh expired tokens.
 * Usage: node rotator.mjs watch [--interval 5000]
 */
async function cmdWatch(intervalMs = 30_000, groupValue = process.env.ROTATOR_WATCH_GROUP) {
  const group = normalizeGroup(groupValue);
  console.log(`Rotator watch started (interval: ${intervalMs}ms${group ? `, group: ${group}` : ""})`);
  console.log(`Monitoring active account token expiry + live usage threshold`);
  console.log("Press Ctrl+C to stop.\n");

  let stopped = false;
  let timer = null;

  const runTick = async () => {
    try {
      // 1. Check if current active account's token is expired → refresh
      await refreshIfExpired(group);

      // 2. Check if auth.json has been replaced externally (manual login) → sync
      await syncAuthChanges();

      // 3. Check the live Codex usage window before we actually hit the limit
      await maybeRotateOnUsage(DEFAULT_USAGE_THRESHOLD_PERCENT, group);
    } catch (err) {
      // Silently log, don't crash
      console.error(`[watch error] ${err.message}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(runTick, intervalMs);
      }
    }
  };

  process.on("SIGINT", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log("\nRotator watch stopped.");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.exit(0);
  });

  await runTick();
}

/**
 * probe <index> - Try to restore a cooldown account by checking if it's usable.
 */
async function cmdProbe(indexStr) {
  const accounts = readAccounts();
  const index = parseStrictIndex(indexStr, accounts.accounts.length);

  const acc = accounts.accounts[index];
  if (acc.status !== "cooldown") {
    console.log(`Account "${acc.label}" is ${acc.status}, not in cooldown. Skip.`);
    return;
  }

  if (acc.cooldownUntil && Date.now() < acc.cooldownUntil) {
    console.log(`Cooldown not yet expired. Wait until ${new Date(acc.cooldownUntil).toLocaleString()}`);
    return;
  }

  // Try refreshing the token - if it works, the account is likely usable
  try {
    if (acc.openai?.refresh) {
      const refreshed = await refreshAccessToken(acc.openai.refresh);
      acc.openai.access = refreshed.access_token;
      acc.openai.refresh = refreshed.refresh_token;
      acc.openai.expires = Date.now() + refreshed.expires_in * 1000;
    }

    acc.status = "healthy";
    delete acc.cooldownUntil;
    delete acc.usageBlockedUntil;
    delete acc.usageBlockReason;
    writeAccounts(accounts);

    console.log(`✓ Probe successful: "${acc.label}" is healthy again.`);
  } catch (err) {
    console.error(`✗ Probe failed: ${err.message}`);
  }
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

async function refreshIfExpired(group = "") {
  const accounts = readAccounts();
  if (accounts.accounts.length === 0) return;

  const acc = accounts.accounts[accounts.activeIndex];
  if (!acc?.openai?.refresh) return;

  const expiresAt = acc.openai.expires || 0;
  // Refresh 2 minutes before expiry
  if (Date.now() >= expiresAt - 120_000) {
    try {
      console.log(`[refresh] Token for "${acc.label}" ${expiresAt === 0 ? "has no expiry" : "expiring soon"}. Refreshing...`);

      const refreshed = await refreshAccessToken(acc.openai.refresh);

      acc.openai.access = refreshed.access_token;
      acc.openai.refresh = refreshed.refresh_token;
      acc.openai.expires = Date.now() + refreshed.expires_in * 1000;

      writeAccounts(accounts);

      // Also update auth.json if this is the active account
      const auth = readAuth() || {};
      auth.openai = { ...acc.openai };
      writeAuth(auth);

      console.log(`[refresh] ✓ Token refreshed for "${acc.label}"`);
    } catch (err) {
      console.error(`[refresh] ✗ Failed for "${acc.label}": ${err.message}`);

      // Mark account as cooldown if refresh fails
      if (acc.status === "healthy") {
        acc.status = "cooldown";
        acc.cooldownUntil = Date.now() + 60_000; // 1 min cooldown
        writeAccounts(accounts);
      }

      // Try switching to next healthy
      await autoSwitchOnError("token_refresh_failed", group);
    }
  }
}

async function syncAuthChanges() {
  const auth = readAuth();
  if (!auth?.openai) return;

  const accounts = readAccounts();
  if (accounts.accounts.length === 0) return;

  const activeAcc = accounts.accounts[accounts.activeIndex];

  // If auth.json's accountId differs from active account's → someone logged in manually
  if (auth.openai.accountId && activeAcc?.openai?.accountId &&
      auth.openai.accountId !== activeAcc.openai.accountId) {
    // Check if this accountId matches any existing account
    const matchIdx = accounts.accounts.findIndex(
      (a) => a.openai?.accountId === auth.openai.accountId
    );

    if (matchIdx !== -1) {
      // It's a known account → update active index
      accounts.activeIndex = matchIdx;
      accounts.accounts[matchIdx].openai = { ...auth.openai };
      writeAccounts(accounts);
      console.log(`[sync] Detected switch to known account "${accounts.accounts[matchIdx].label}" (index: ${matchIdx})`);
    } else {
      // Unknown account → user did `opencode auth login` for a new account
      // Prompt them to run `rotator add`
      console.log(`[sync] New account detected in auth.json (accountId: ${auth.openai.accountId}). Run 'node rotator.mjs add' to register it.`);
    }
  }
}

async function autoSwitchOnError(reason, group = "") {
  const accounts = readAccounts();
  if (accounts.accounts.length <= 1) {
    console.log("[switch] No other accounts to switch to.");
    return;
  }

  const currentIdx = accounts.activeIndex;
  const currentAcc = accounts.accounts[currentIdx];

  // Put current account in cooldown
  if (currentAcc.status === "healthy") {
    currentAcc.status = "cooldown";
    currentAcc.cooldownUntil = Date.now() + (reason === "quota_exceeded" ? 900_000 : 60_000); // 15min / 1min
    currentAcc.lastSwitchReason = reason;
  }

  await refreshUsageSnapshots(
    accounts,
    accounts.accounts
      .map((acc, idx) => ({ acc, idx }))
      .filter(({ acc, idx }) => idx !== currentIdx && acc?.status === "healthy" && accountInGroup(acc, group))
      .map(({ idx }) => idx)
  );

  const nextIdx = choosePreferredAccount(accounts, DEFAULT_USAGE_THRESHOLD_PERCENT, new Set([currentIdx]), group);
  if (nextIdx === -1) {
    writeAccounts(accounts);
    console.error(`[switch] No healthy account available${group ? ` in group "${group}"` : ""}!`);
    return;
  }

  writeActiveAccount(accounts, nextIdx);
  writeAccounts(accounts);

  console.log(`[switch] ✓ Switched from "${currentAcc.label}" to "${accounts.accounts[nextIdx].label}" (reason: ${reason})`);
}

async function cmdUsage(args) {
  const accounts = readAccounts();
  if (accounts.accounts.length === 0) {
    console.error("No accounts registered. Run 'node rotator.mjs add' first.");
    process.exit(1);
  }

  const allowedFlags = new Set(["--json", "--all"]);
  const unknownArg = args.find((arg) => arg.startsWith("-") && !allowedFlags.has(arg));
  if (unknownArg) fail(`Unknown usage option: ${unknownArg}`);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (positional.length > 1) fail("usage accepts at most one index.");
  const jsonOutput = args.includes("--json");
  const allAccounts = args.includes("--all");
  const indexArg = positional[0];
  if (allAccounts && indexArg !== undefined) fail("usage accepts either --all or an index, not both.");

  let indices;
  if (allAccounts) {
    indices = accounts.accounts.map((_, idx) => idx);
  } else if (indexArg !== undefined) {
    const index = parseStrictIndex(indexArg, accounts.accounts.length);
    indices = [index];
  } else {
    indices = [accounts.activeIndex];
  }

  await refreshUsageSnapshots(accounts, indices);
  writeAccounts(accounts);

  const output = indices.map((idx) => {
    const acc = accounts.accounts[idx];
    return {
      index: idx,
      label: acc.label,
      status: acc.status,
      usageBlockedUntil: acc.usageBlockedUntil ?? null,
      usageBlockReason: acc.usageBlockReason ?? null,
      codexUsage: acc.codexUsage ?? null,
    };
  });

  if (jsonOutput) {
    console.log(JSON.stringify(allAccounts ? output : output[0], null, 2));
    return;
  }

  output.forEach((entry) => {
    console.log(`[${entry.index}] ${entry.label} | status: ${entry.status}`);
    if (entry.usageBlockedUntil && entry.usageBlockedUntil > Date.now()) {
      console.log(`  usage blocked until: ${new Date(entry.usageBlockedUntil).toLocaleString()} (${entry.usageBlockReason || "usage"})`);
    }

    if (entry.codexUsage?.lastError) {
      console.log(`  usage error: ${entry.codexUsage.lastError}`);
      return;
    }

    console.log(`  ${formatUsageWindow("5h", entry.codexUsage?.primaryWindow)}`);
    console.log(`  ${formatUsageWindow("7d", entry.codexUsage?.secondaryWindow)}`);
    console.log(`  limit reached: ${entry.codexUsage?.limitReached ? "yes" : "no"}`);
    console.log(`  threshold: ${DEFAULT_USAGE_THRESHOLD_PERCENT}%`);
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;

function printUsage() {
  console.log(`opencode-chatgpt-account-rotator

Usage:
  node rotator.mjs add [label] [group] Save current auth.json as new account
  node rotator.mjs status            Show all accounts and active one
  node rotator.mjs switch [index]    Switch to account (next healthy, or by index)
  node rotator.mjs enable <index>    Re-enable a disabled account
  node rotator.mjs disable <index>   Disable an account
  node rotator.mjs rename <index> <label>
  node rotator.mjs group <index> [group]
  node rotator.mjs rename-group <old> <new>
  node rotator.mjs delete-group <group>
  node rotator.mjs delete <index>    Delete an account from accounts.json
  node rotator.mjs probe <index>     Try restoring a cooldown account
  node rotator.mjs usage [--all|index] [--json]
  node rotator.mjs watch [--interval <ms>|--interval=<ms>] [--group <group>|--group=<group>]

Credential files:
  accounts.json: ${ACCOUNTS_FILE}
  auth.json: ${AUTH_FILE}

Workflow:
  1. Run 'opencode auth login' → log in to ChatGPT
  2. Run 'node rotator.mjs add "my-account"' → saves credentials
  3. Repeat 1-2 for each account
  4. Run 'node rotator.mjs watch' → auto-rotates when active usage crosses threshold
`);
}

function parseWatchArgs(args) {
  const parsed = { intervalMs: 30_000, group: "" };

  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg.startsWith("--interval=")) {
      parsed.intervalMs = parsePositiveInteger(arg.slice("--interval=".length), "watch interval");
    } else if (arg === "--interval") {
      idx += 1;
      parsed.intervalMs = parsePositiveInteger(args[idx], "watch interval");
    } else if (arg.startsWith("--group=")) {
      parsed.group = normalizeGroup(arg.slice("--group=".length));
    } else if (arg === "--group") {
      idx += 1;
      parsed.group = normalizeGroup(args[idx]);
    } else {
      throw new Error("Usage: node rotator.mjs watch [--interval <ms>|--interval=<ms>] [--group <group>|--group=<group>]");
    }
  }

  return parsed;
}

try {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    case "add":
      if (args.length > 2) fail("Usage: node rotator.mjs add [label] [group]");
      cmdAdd(args[0], args[1]);
      break;
    case "status":
      if (args.length > 0) fail("Usage: node rotator.mjs status");
      cmdStatus();
      break;
    case "switch":
      if (args.length > 1) fail("Usage: node rotator.mjs switch [index]");
      cmdSwitch(args[0]);
      break;
    case "enable":
      if (args.length !== 1) fail("Usage: node rotator.mjs enable <index>");
      cmdEnable(args[0]);
      break;
    case "disable":
      if (args.length < 1 || args.length > 2) fail("Usage: node rotator.mjs disable <index> [reason]");
      cmdDisable(args[0], args[1]);
      break;
    case "rename":
    case "title":
      if (args.length !== 2) fail(`Usage: node rotator.mjs ${command} <index> <label>`);
      cmdRename(args[0], args[1]);
      break;
    case "group":
    case "set-group":
      if (args.length < 1 || args.length > 2) fail(`Usage: node rotator.mjs ${command} <index> [group]`);
      cmdGroup(args[0], args[1]);
      break;
    case "rename-group":
      if (args.length !== 2) fail("Usage: node rotator.mjs rename-group <old> <new>");
      cmdRenameGroup(args[0], args[1]);
      break;
    case "delete-group":
      if (args.length !== 1) fail("Usage: node rotator.mjs delete-group <group>");
      cmdDeleteGroup(args[0]);
      break;
    case "delete":
    case "remove":
      if (args.length !== 1) fail(`Usage: node rotator.mjs ${command} <index>`);
      cmdDelete(args[0]);
      break;
    case "probe":
      if (args.length !== 1) fail("Usage: node rotator.mjs probe <index>");
      await cmdProbe(args[0]);
      break;
    case "usage":
      await cmdUsage(args);
      break;
    case "watch":
      {
        const watchOptions = parseWatchArgs(args);
        await cmdWatch(watchOptions.intervalMs, watchOptions.group);
      }
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
} catch (error) {
  fail(error.message);
}
