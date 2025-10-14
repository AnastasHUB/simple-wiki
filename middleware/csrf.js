import crypto from "crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const CSRF_SESSION_KEY = "csrfToken";
const TOKEN_LENGTH = 32;

function ensureToken(session) {
  if (!session[CSRF_SESSION_KEY]) {
    session[CSRF_SESSION_KEY] = crypto.randomBytes(TOKEN_LENGTH).toString("hex");
  }
  return session[CSRF_SESSION_KEY];
}

function extractToken(req) {
  if (req.body && typeof req.body._csrf === "string") {
    return req.body._csrf;
  }
  if (req.query && typeof req.query._csrf === "string") {
    return req.query._csrf;
  }
  const headerNames = ["x-csrf-token", "x-xsrf-token", "csrf-token"];
  for (const name of headerNames) {
    const value = req.get(name);
    if (value) {
      return value;
    }
  }
  return null;
}

export function csrfProtection() {
  return function csrfMiddleware(req, res, next) {
    if (!req.session) {
      return next(new Error("CSRF protection requires session middleware"));
    }

    const token = ensureToken(req.session);
    res.locals.csrfToken = token;

    const method = (req.method || "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return next();
    }

    const providedToken = extractToken(req);
    if (!providedToken || providedToken !== token) {
      const message =
        "Action bloquée : impossible de vérifier votre jeton de sécurité. Veuillez réessayer.";
      if (req.accepts("json") && !req.accepts("html")) {
        return res.status(403).json({ ok: false, message });
      }
      return res.status(403).render("error", { message });
    }

    return next();
  };
}
