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

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = resolveClientKey(req, keyGenerator);
    let entry = hits.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + windowMs };
    }
    entry.count += 1;
    hits.set(key, entry);

    if (entry.count > limit) {
      const retryAfterMs = entry.expiresAt - now;
      if (retryAfterMs > 0) {
        res.set("Retry-After", Math.ceil(retryAfterMs / 1000));
      }
      return sendRateLimitResponse(req, res, message, statusCode);
    }

    next();

    if (entry.expiresAt <= Date.now()) {
      hits.delete(key);
    }
  };
}
