const PROVIDERS = {
  hcaptcha: {
    id: "hcaptcha",
    label: "hCaptcha",
    siteKey:
      process.env.HCAPTCHA_SITE_KEY || process.env.HCAPTCHA_SITEKEY || null,
    secret:
      process.env.HCAPTCHA_SECRET ||
      process.env.HCAPTCHA_SECRET_KEY ||
      null,
    scriptUrl: "https://js.hcaptcha.com/1/api.js?render=explicit",
    global: "hcaptcha",
    verifyUrl: "https://hcaptcha.com/siteverify",
    buildPayload({ secret, token, remoteIp }) {
      const body = new URLSearchParams();
      body.set("secret", secret);
      body.set("response", token);
      if (remoteIp) {
        body.set("remoteip", remoteIp);
      }
      return { body };
    },
  },
  recaptcha: {
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
    buildPayload({ secret, token, remoteIp }) {
      const body = new URLSearchParams();
      body.set("secret", secret);
      body.set("response", token);
      if (remoteIp) {
        body.set("remoteip", remoteIp);
      }
      return { body };
    },
  },
  turnstile: {
    id: "turnstile",
    label: "Cloudflare Turnstile",
    siteKey:
      process.env.CLOUDFLARE_TURNSTILE_SITE_KEY ||
      process.env.TURNSTILE_SITE_KEY ||
      null,
    secret:
      process.env.CLOUDFLARE_TURNSTILE_SECRET ||
      process.env.TURNSTILE_SECRET_KEY ||
      process.env.TURNSTILE_SECRET ||
      null,
    scriptUrl:
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    global: "turnstile",
    verifyUrl:
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    buildPayload({ secret, token, remoteIp }) {
      const payload = { secret, response: token };
      if (remoteIp) {
        payload.remoteip = remoteIp;
      }
      return {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      };
    },
  },
};

export function getEnabledCaptchaProviders() {
  return Object.values(PROVIDERS)
    .filter((provider) => provider.siteKey && provider.secret)
    .map(({ id, label, siteKey, scriptUrl, global }) => ({
      id,
      label,
      siteKey,
      scriptUrl,
      global,
    }));
}

export function isCaptchaAvailable() {
  return getEnabledCaptchaProviders().length > 0;
}

export async function verifyCaptchaResponse(providerId, token, options = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return {
      success: false,
      errorCodes: ["unknown-provider"],
    };
  }
  const { secret, verifyUrl, buildPayload } = provider;
  if (!secret) {
    return {
      success: false,
      errorCodes: ["missing-secret"],
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
    const payload = buildPayload({
      secret,
      token: trimmedToken,
      remoteIp: options.remoteIp || null,
    });
    const response = await fetch(verifyUrl, {
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

export function describeCaptchaProvider(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return null;
  }
  return {
    id: provider.id,
    label: provider.label,
  };
}
