export const COMMENT_COOLDOWN_MS = 60 * 1000;

export function validateCommentSubmission({
  authorInput = "",
  bodyInput = "",
  captchaInput = "",
  honeypotInput = "",
  lastCommentAt = null,
  now = Date.now(),
}) {
  const author = authorInput.trim().slice(0, 80);
  const { body, errors } = validateCommentBody(bodyInput);
  const captcha = captchaInput.trim();
  const honeypot = honeypotInput.trim();

  if (honeypot) {
    errors.push("Soumission invalide.");
  }

  if (captcha !== "7") {
    errors.push(
      "Merci de répondre correctement à la question anti-spam (3 + 4).",
    );
  }

  if (lastCommentAt && now - lastCommentAt < COMMENT_COOLDOWN_MS) {
    const waitSeconds = Math.ceil(
      (COMMENT_COOLDOWN_MS - (now - lastCommentAt)) / 1000,
    );
    errors.push(
      `Merci de patienter ${waitSeconds} seconde(s) avant de publier un nouveau commentaire.`,
    );
  }

  return { author, body, errors, now };
}

export function validateCommentBody(bodyInput = "") {
  const body = bodyInput.trim();
  const errors = [];

  if (!body) {
    errors.push("Le message est requis.");
  } else if (body.length < 10) {
    errors.push("Le message doit contenir au moins 10 caractères.");
  } else if (body.length > 2000) {
    errors.push("Le message est trop long (2000 caractères max).");
  }

  return { body, errors };
}
