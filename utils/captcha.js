const RECAPTCHA_CONFIG = {
  id: "recaptcha",
  label: "reCAPTCHA",
  siteKey:
    process.env.RECAPTCHA_SITE_KEY ||
    process.env.RECAPTCHA_SITEKEY ||
    null,
  secret:
    process.env.RECAPTCHA_SECRET ||
    process.env.RECAPTCHA_SECRET_KEY ||
    null,
  scriptUrl: "https://www.google.com/recaptcha/api.js?render=explicit",
  global: "grecaptcha",
  verifyUrl: "https://www.google.com/recaptcha/api/siteverify",
};

function buildVerificationPayload({ secret, token, remoteIp }) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }
  return { body };
}

function getProvider() {
  const siteKey = RECAPTCHA_CONFIG.siteKey;
  const secret = RECAPTCHA_CONFIG.secret;
  if (!siteKey || !secret) {
    return null;
  }
  return {
    ...RECAPTCHA_CONFIG,
    siteKey,
    secret,
  };
}

export function getRecaptchaConfig() {
  const provider = getProvider();
  if (!provider) {
    return null;
  }
  const { id, label, siteKey, scriptUrl, global } = provider;
  return { id, label, siteKey, scriptUrl, global };
}

export function isCaptchaAvailable() {
  return Boolean(getProvider());
}

export async function verifyRecaptchaResponse(token, options = {}) {
  const provider = getProvider();
  if (!provider) {
    return {
      success: false,
      errorCodes: ["missing-configuration"],
    };
  }

  const trimmedToken = typeof token === "string" ? token.trim() : "";
  if (!trimmedToken) {
    return {
      success: false,
      errorCodes: ["missing-token"],
    };
  }

  try {
    const payload = buildVerificationPayload({
      secret: provider.secret,
      token: trimmedToken,
      remoteIp: options.remoteIp || null,
    });
    const response = await fetch(provider.verifyUrl, {
      method: "POST",
      ...payload,
    });
    if (!response.ok) {
      return {
        success: false,
        errorCodes: ["verification-error"],
      };
    }
    const data = await response.json();
    const success = Boolean(data?.success);
    const errorCodes = Array.isArray(data?.["error-codes"])
      ? data["error-codes"].map((code) => String(code))
      : Array.isArray(data?.errorCodes)
        ? data.errorCodes.map((code) => String(code))
        : [];
    return {
      success,
      errorCodes: success ? [] : errorCodes,
    };
  } catch (err) {
    console.error("Captcha verification failed", err);
    return {
      success: false,
      errorCodes: ["verification-error"],
    };
  }
}

export function describeRecaptcha() {
  const provider = getRecaptchaConfig();
  if (!provider) {
    return null;
  }
  const { id, label } = provider;
  return { id, label };
}
