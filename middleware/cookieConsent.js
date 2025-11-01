import cookie from "cookie";

export const COOKIE_CONSENT_NAME = "cookie_consent";
export const COOKIE_ACCEPTED_VALUE = "accepted";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 an

function parseRequestCookies(req) {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== "string") {
    return {};
  }

  try {
    return cookie.parse(header);
  } catch (err) {
    console.warn("Impossible d'analyser l'en-tête Cookie", err);
    return {};
  }
}

function isSecureRequest(req) {
  if (!req) {
    return false;
  }
  if (req.secure === true) {
    return true;
  }
  if (typeof req.protocol === "string" && req.protocol.toLowerCase() === "https") {
    return true;
  }
  const forwardedProto = req.headers?.["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    const firstProto = forwardedProto.split(",")[0]?.trim().toLowerCase();
    return firstProto === "https";
  }
  return false;
}

function appendSetCookie(res, serializedCookie) {
  if (!serializedCookie) {
    return;
  }

  if (typeof res.append === "function") {
    res.append("Set-Cookie", serializedCookie);
    return;
  }

  if (typeof res.getHeader === "function" && typeof res.setHeader === "function") {
    const existing = res.getHeader("Set-Cookie");
    if (!existing) {
      res.setHeader("Set-Cookie", serializedCookie);
    } else if (Array.isArray(existing)) {
      res.setHeader("Set-Cookie", [...existing, serializedCookie]);
    } else {
      res.setHeader("Set-Cookie", [existing, serializedCookie]);
    }
    return;
  }

  if (!res.headers) {
    res.headers = {};
  }
  const current = res.headers["Set-Cookie"];
  if (!current) {
    res.headers["Set-Cookie"] = serializedCookie;
  } else if (Array.isArray(current)) {
    current.push(serializedCookie);
  } else {
    res.headers["Set-Cookie"] = [current, serializedCookie];
  }
}

export function setConsentCookie(res, value, req, options = {}) {
  const secure = options.secure ?? isSecureRequest(req);
  const serialized = cookie.serialize(COOKIE_CONSENT_NAME, value, {
    path: "/",
    maxAge: options.maxAge ?? COOKIE_MAX_AGE_SECONDS,
    sameSite: options.sameSite ?? "Lax",
    secure,
  });
  appendSetCookie(res, serialized);
  return serialized;
}

export function cookieConsentMiddleware(req, res, next) {
  const parsedCookies = parseRequestCookies(req);
  req.cookies = { ...(req.cookies || {}), ...parsedCookies };

  const consentValue = parsedCookies[COOKIE_CONSENT_NAME];
  const hasAccepted = consentValue === COOKIE_ACCEPTED_VALUE;
  res.locals.showCookieBanner = !hasAccepted;
  res.locals.cookieConsent = consentValue || null;
  if (typeof res.locals.cookiePolicyUrl === "undefined") {
    const lang = res.locals.lang === "en" ? "en" : "fr";
    res.locals.cookiePolicyUrl = lang === "en" ? "/cookies/policy" : "/cookies/politique";
  }

  next();
}
