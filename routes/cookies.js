import { Router } from "express";
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
  res.status(204).end();
});

router.get("/cookies/politique", (req, res) => {
  res.render("cookie-policy", {
    title: "Politique de cookies",
    meta: {
      title: "Politique de cookies",
      description:
        "Découvrez comment nous utilisons les cookies essentiels et comment gérer vos préférences sur la plateforme.",
    },
  });
});

export default router;
