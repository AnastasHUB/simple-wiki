import { Router } from "express";
import cookie from "cookie";
import {
  COOKIE_ACCEPTED_VALUE,
  cookieConsentMiddleware,
  setConsentCookie,
} from "../middleware/cookieConsent.js";

const router = Router();

router.use(cookieConsentMiddleware);

router.post("/cookies/consent", (req, res) => {
  const consentRaw =
    typeof req.body?.consent === "string" && req.body.consent.trim()
      ? req.body.consent.trim()
      : COOKIE_ACCEPTED_VALUE;
  const consent =
    consentRaw.toLowerCase() === COOKIE_ACCEPTED_VALUE
      ? COOKIE_ACCEPTED_VALUE
      : consentRaw;

  setConsentCookie(res, consent, req);
  if (consent === COOKIE_ACCEPTED_VALUE) {
    res.locals.showCookieBanner = false;
  }

  res.status(204).end();
});

function setLangCookie(res, value, req) {
  const serialized = cookie.serialize("lang", value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "Lax",
    secure: req.secure === true || (req.headers?.["x-forwarded-proto"] || "").includes("https"),
    httpOnly: false,
  });
  if (typeof res.append === "function") {
    res.append("Set-Cookie", serialized);
  } else {
    res.setHeader("Set-Cookie", serialized);
  }
}

router.get("/lang/:code", (req, res) => {
  const code = String(req.params.code || "").toLowerCase();
  const lang = code === "en" ? "en" : code === "fr" ? "fr" : null;
  if (lang) {
    setLangCookie(res, lang, req);
  }
  const back = req.get("referer") || "/";
  res.redirect(back);
});

function renderCookiePolicy(req, res) {
  res.render("cookie-policy", {
    title: req.t("cookiePolicy.title"),
    meta: {
      title: req.t("cookiePolicy.title"),
      description: req.t("cookiePolicy.metaDescription"),
    },
  });
}

router.get("/cookies/politique", (req, res) => renderCookiePolicy(req, res));
router.get("/cookies/policy", (req, res) => renderCookiePolicy(req, res));

export default router;
