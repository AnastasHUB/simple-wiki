import { get } from "../db.js";
import {
  getRecaptchaConfig,
  verifyRecaptchaResponse,
} from "./captcha.js";

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export async function validateRegistrationSubmission({
  username,
  password,
  captchaToken,
  remoteIp = null,
} = {}) {
  const captcha = getRecaptchaConfig();
  const sanitizedUsername = typeof username === "string" ? username.trim() : "";
  const passwordValue = typeof password === "string" ? password : "";
  const errors = [];
  const result = {
    captcha,
    captchaMissing: !captcha,
    sanitizedUsername,
    passwordValue,
    captchaResult: { success: false, errorCodes: [] },
    errors,
  };

  if (!captcha) {
    return result;
  }

  if (!sanitizedUsername) {
    errors.push("Veuillez indiquer un nom d'utilisateur.");
  } else if (sanitizedUsername.length < 3 || sanitizedUsername.length > 32) {
    errors.push("Le nom d'utilisateur doit contenir entre 3 et 32 caractères.");
  } else if (!USERNAME_PATTERN.test(sanitizedUsername)) {
    errors.push(
      "Le nom d'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores.",
    );
  }

  if (!passwordValue) {
    errors.push("Veuillez indiquer un mot de passe.");
  } else if (passwordValue.length < 8) {
    errors.push("Le mot de passe doit contenir au moins 8 caractères.");
  }

  const verification = await verifyRecaptchaResponse(captchaToken, {
    remoteIp,
  });
  result.captchaResult = verification;
  if (!verification.success) {
    const codes = verification.errorCodes.length
      ? ` (${verification.errorCodes.join(", ")})`
      : "";
    errors.push(`La vérification du captcha a échoué${codes}.`);
  }

  if (!errors.length && sanitizedUsername) {
    const existing = await get(
      "SELECT 1 FROM users WHERE username=? COLLATE NOCASE",
      [sanitizedUsername],
    );
    if (existing) {
      errors.push("Ce nom d'utilisateur est déjà utilisé.");
    }
  }

  return result;
}

export const usernamePattern = USERNAME_PATTERN;
