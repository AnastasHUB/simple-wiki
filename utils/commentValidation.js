export function validateCommentSubmission(
  {
    authorInput = "",
    bodyInput = "",
    captchaInput = "",
    honeypotInput = "",
  } = {},
) {
  const author = authorInput.trim().slice(0, 80);
  const { body, errors } = validateCommentBody(bodyInput);
  const captcha = typeof captchaInput === "string" ? captchaInput.trim() : "";
  const honeypot = typeof honeypotInput === "string"
    ? honeypotInput.trim()
    : "";

  if (honeypot) {
    errors.push("Soumission invalide.");
  }

  if (!captcha) {
    errors.push("Merci de répondre à la question anti-spam.");
  }

  return { author, body, errors, captcha };
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
