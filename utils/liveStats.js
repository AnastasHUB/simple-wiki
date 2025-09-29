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

export function trackLiveVisitor(ip, path, { now = Date.now() } = {}) {
  if (!ip) {
    return;
  }
  const entry = {
    ip,
    path: normalizePath(path),
    lastSeen: now,
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
