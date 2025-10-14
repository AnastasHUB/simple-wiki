export function validateCommentSubmission(
  {
    authorInput = "",
    bodyInput = "",
    captchaInput = "",
    honeypotInput = "",
  },
  { skipCaptchaQuestion = false } = {},
) {
  const author = authorInput.trim().slice(0, 80);
  const { body, errors } = validateCommentBody(bodyInput);
  const captcha = captchaInput.trim();
  const honeypot = honeypotInput.trim();

  if (honeypot) {
    errors.push("Soumission invalide.");
  }

  if (!skipCaptchaQuestion && captcha !== "7") {
    errors.push(
      "Merci de répondre correctement à la question anti-spam (3 + 4).",
    );
  }

  return { author, body, errors };
}

export function validateCommentBody(bodyInput = "") {
  const body = bodyInput.trim();
  const errors = [];

  if (!body) {
    errors.push("Le message est requis.");
  } else if (body.length > 2000) {
    errors.push("Le message est trop long (2000 caractères max).");
  }

  return { body, errors };
}
