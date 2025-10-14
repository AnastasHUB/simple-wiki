import { detectBotUserAgent, normalizeUserAgent } from "./ip.js";
import { formatSecondsAgo } from "./time.js";

const activeVisitors = new Map();
export const ACTIVE_VISITOR_TTL_MS = 2 * 60 * 1000;
export const LIVE_VISITOR_PAGE_SIZES = [5, 10, 25, 50];
export const LIVE_VISITOR_DEFAULT_PAGE_SIZE = 10;
export const LIVE_VISITOR_PAGINATION_OPTIONS = {
  pageParam: "livePage",
  perPageParam: "livePerPage",
  defaultPageSize: LIVE_VISITOR_DEFAULT_PAGE_SIZE,
  pageSizeOptions: LIVE_VISITOR_PAGE_SIZES,
};

const subscribers = new Set();

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
  let removed = false;
  for (const [ip, info] of activeVisitors.entries()) {
    if (!info || now - info.lastSeen > ACTIVE_VISITOR_TTL_MS) {
      activeVisitors.delete(ip);
      removed = true;
    }
  }
  return removed;
}

function buildSnapshot(now = Date.now()) {
  const visitors = Array.from(activeVisitors.values()).sort(
    (a, b) => b.lastSeen - a.lastSeen,
  );
  return {
    generatedAt: now,
    visitors: visitors.map((visitor) => {
      const secondsAgo = Math.max(0, Math.round((now - visitor.lastSeen) / 1000));
      return {
        ...visitor,
        lastSeenIso: new Date(visitor.lastSeen).toISOString(),
        lastSeenSecondsAgo: secondsAgo,
        lastSeenRelative: formatSecondsAgo(secondsAgo),
      };
    }),
  };
}

function notifySubscribers(snapshot = null) {
  if (subscribers.size === 0) {
    return;
  }
  const payload = snapshot ?? buildSnapshot(Date.now());
  for (const listener of subscribers) {
    try {
      listener(payload);
    } catch (error) {
      console.error("Erreur lors de la notification des statistiques en direct", error);
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
  if (subscribers.size > 0) {
    notifySubscribers(buildSnapshot(now));
  }
}

export function getActiveVisitors({ now = Date.now() } = {}) {
  pruneExpired(now);
  return Array.from(activeVisitors.values()).sort(
    (a, b) => b.lastSeen - a.lastSeen,
  );
}

export function getLiveVisitorsSnapshot(now = Date.now()) {
  pruneExpired(now);
  return buildSnapshot(now);
}

export function subscribeLiveVisitorUpdates(listener, { immediate = true } = {}) {
  if (typeof listener !== "function") {
    return () => {};
  }
  subscribers.add(listener);
  if (immediate) {
    listener(buildSnapshot(Date.now()));
  }
  return () => {
    subscribers.delete(listener);
  };
}

const SWEEP_INTERVAL_MS = 5000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  const removed = pruneExpired(now);
  if (removed && subscribers.size > 0) {
    notifySubscribers(buildSnapshot(now));
  }
}, SWEEP_INTERVAL_MS);

if (typeof sweepTimer.unref === "function") {
  sweepTimer.unref();
}
