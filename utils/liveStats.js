import { detectBotUserAgent, normalizeUserAgent } from "./ip.js";

const activeVisitors = new Map();
export const ACTIVE_VISITOR_TTL_MS = 2 * 60 * 1000;

function normalizePath(path) {
  if (typeof path !== "string" || !path) {
    return "/";
  }
  try {
    return decodeURIComponent(path);
  } catch (_) {
    return path;
  }
}

function pruneExpired(now = Date.now()) {
  for (const [ip, info] of activeVisitors.entries()) {
    if (!info || now - info.lastSeen > ACTIVE_VISITOR_TTL_MS) {
      activeVisitors.delete(ip);
    }
  }
}

export function trackLiveVisitor(
  ip,
  path,
  { now = Date.now(), userAgent = null } = {},
) {
  if (!ip) {
    return;
  }
  const normalizedUserAgent = normalizeUserAgent(userAgent);
  const detection = detectBotUserAgent(normalizedUserAgent);
  const entry = {
    ip,
    path: normalizePath(path),
    lastSeen: now,
    userAgent: detection.userAgent,
    isBot: detection.isBot,
    botReason: detection.reason,
  };
  activeVisitors.set(ip, entry);
  pruneExpired(now);
}

export function getActiveVisitors({ now = Date.now() } = {}) {
  pruneExpired(now);
  return Array.from(activeVisitors.values()).sort(
    (a, b) => b.lastSeen - a.lastSeen,
  );
}
