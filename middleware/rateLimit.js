import { getClientIp } from "../utils/ip.js";

const SAFE_HEADERS = {
  "Cache-Control": "private, max-age=0, must-revalidate",
};

function resolveClientKey(req, keyGenerator) {
  try {
    if (typeof keyGenerator === "function") {
      const key = keyGenerator(req);
      if (key) {
        return String(key);
      }
    }
  } catch (err) {
    // Ignore custom key errors and fallback to IP based detection.
  }
  const ip = getClientIp(req) || req.ip;
  return ip ? String(ip) : "global";
}

function sendRateLimitResponse(req, res, message, statusCode) {
  const body = message || "Too many requests";
  if (res.headersSent) {
    return;
  }
  Object.entries(SAFE_HEADERS).forEach(([header, value]) => {
    if (!res.get(header)) {
      res.set(header, value);
    }
  });
  if (req?.accepts?.("json") && !req.accepts("html")) {
    res.status(statusCode).json({ ok: false, message: body });
  } else {
    res.status(statusCode).send(body);
  }
}

export function createRateLimiter({
  windowMs = 60_000,
  limit = 100,
  message = "Trop de requêtes. Merci de réessayer plus tard.",
  statusCode = 429,
  keyGenerator,
} = {}) {
  if (typeof windowMs !== "number" || windowMs <= 0) {
    throw new Error("windowMs must be a positive number");
  }
  if (typeof limit !== "number" || limit <= 0) {
    throw new Error("limit must be a positive number");
  }

  const hits = new Map();

  function deleteEntry(key, entry) {
    const current = hits.get(key);
    if (current && (!entry || current === entry)) {
      if (current.timeout) {
        clearTimeout(current.timeout);
        current.timeout = null;
      }
      hits.delete(key);
    }
  }

  function scheduleCleanup(key, entry) {
    const delay = entry.expiresAt - Date.now();
    if (delay <= 0) {
      deleteEntry(key, entry);
      return;
    }

    const timeout = setTimeout(() => {
      const current = hits.get(key);
      if (current === entry) {
        hits.delete(key);
      }
    }, delay);

    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    entry.timeout = timeout;
  }

  function registerHit(key, now, windowMs) {
    let entry = hits.get(key);
    if (entry && entry.expiresAt <= now) {
      deleteEntry(key, entry);
      entry = undefined;
    }

    if (!entry) {
      entry = { count: 0, expiresAt: now + windowMs, timeout: null };
      hits.set(key, entry);
      scheduleCleanup(key, entry);
    }

    return entry;
  }

  function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = resolveClientKey(req, keyGenerator);
    const entry = registerHit(key, now, windowMs);
    entry.count += 1;

    if (entry.count > limit) {
      const retryAfterMs = entry.expiresAt - now;
      if (retryAfterMs > 0) {
        res.set("Retry-After", Math.ceil(retryAfterMs / 1000));
      }
      const bodyMessage =
        typeof message === "function" ? message(req) : message;
      return sendRateLimitResponse(req, res, bodyMessage, statusCode);
    }

    next();

    if (entry.expiresAt <= Date.now()) {
      deleteEntry(key, entry);
    }
  };

  Object.defineProperty(rateLimiter, "_getHitsForTesting", {
    value: () => hits,
    enumerable: false,
  });

  return rateLimiter;
}
