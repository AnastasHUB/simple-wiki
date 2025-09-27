import { getSessionSecrets } from "./sessionSecrets.js";

function booleanFromEnv(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const cookieConfig = {};
const cookieSecure = booleanFromEnv(process.env.SESSION_COOKIE_SECURE);
const cookieHttpOnly = booleanFromEnv(process.env.SESSION_COOKIE_HTTP_ONLY);
const cookieSameSite = process.env.SESSION_COOKIE_SAMESITE;
const cookieMaxAge = process.env.SESSION_COOKIE_MAX_AGE
  ? Number(process.env.SESSION_COOKIE_MAX_AGE)
  : undefined;

if (cookieSecure !== undefined) {
  cookieConfig.secure = cookieSecure;
}
if (cookieHttpOnly !== undefined) {
  cookieConfig.httpOnly = cookieHttpOnly;
}
if (cookieSameSite) {
  cookieConfig.sameSite = cookieSameSite;
}
if (!Number.isNaN(cookieMaxAge) && cookieMaxAge !== undefined) {
  cookieConfig.maxAge = cookieMaxAge;
}

export const sessionConfig = {
  secret: getSessionSecrets(),
  resave: false,
  saveUninitialized: false,
};

if (Object.keys(cookieConfig).length > 0) {
  sessionConfig.cookie = cookieConfig;
}

if (process.env.SESSION_COOKIE_NAME) {
  sessionConfig.name = process.env.SESSION_COOKIE_NAME;
}

if (booleanFromEnv(process.env.SESSION_COOKIE_ROLLING)) {
  sessionConfig.rolling = true;
}
