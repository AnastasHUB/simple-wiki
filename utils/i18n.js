// Simple i18n utility with EN/FR support and interpolation
import fr from "../i18n/fr.js";
import en from "../i18n/en.js";
import { parse as parseCookie } from "cookie";

const TRANSLATIONS = { fr, en };
const ENV_DEFAULT_LANG = (process.env.DEFAULT_LANG || "fr").toLowerCase();
const DEFAULT_LANG = ENV_DEFAULT_LANG === "en" ? "en" : "fr";

function pickLangFromHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const lowered = headerValue.toLowerCase();
  if (/(^|[,;])\s*fr(\b|-|_)/.test(lowered)) return "fr";
  if (/(^|[,;])\s*en(\b|-|_)/.test(lowered)) return "en";
  return null;
}

function get(obj, path) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
      cur = cur[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function interpolate(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (_, k) => {
    if (!Object.prototype.hasOwnProperty.call(params, k)) return `{${k}}`;
    // Escape inserted values to prevent XSS when templates are rendered unescaped
    return escapeHtml(params[k]);
  });
}

export function t(lang, key, params) {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANG];
  const raw = get(dict, key);
  if (typeof raw === "string") return interpolate(raw, params);
  // Fallback to default language then key
  const fallbackRaw = get(TRANSLATIONS[DEFAULT_LANG], key);
  if (typeof fallbackRaw === "string") return interpolate(fallbackRaw, params);
  return key;
}

export function i18nMiddleware(req, res, next) {
  try {
    let lang = DEFAULT_LANG;
    const qLang = (req.query?.lang || "").toString().toLowerCase();
    if (qLang === "en" || qLang === "fr") {
      lang = qLang;
      // Persist preference
      res.cookie?.("lang", lang, { httpOnly: false, sameSite: "lax", maxAge: 31536000000 });
    } else {
      const cookieHeader = req.headers?.["cookie"]; 
      const cookies = cookieHeader ? parseCookie(String(cookieHeader)) : {};
      if (cookies.lang === "en" || cookies.lang === "fr") {
        lang = cookies.lang;
      } else {
        lang = pickLangFromHeader(req.headers?.["accept-language"]) || DEFAULT_LANG;
      }
    }

    req.lang = lang;
    res.locals.lang = lang;
    req.t = (key, params) => t(lang, key, params);
    res.locals.t = (key, params) => t(lang, key, params);
    next();
  } catch (err) {
    // Fail-safe: ensure template helpers exist
    req.lang = DEFAULT_LANG;
    res.locals.lang = DEFAULT_LANG;
    req.t = (key) => key;
    res.locals.t = (key) => key;
    next();
  }
}
