import { get, run } from "../db.js";
import { getSiteSettings } from "./settingsService.js";
import { createPremiumCode, PremiumCodeError } from "./premiumService.js";
import { getStripeClient, isStripeConfigured } from "./stripeClient.js";

const PENDING_TOKEN = "__PENDING__";

export class PremiumCheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PremiumCheckoutError";
    this.code = code;
  }
}

function normalizeDurationDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function buildAbsoluteUrl(origin, path) {
  if (!origin) {
    throw new PremiumCheckoutError(
      "invalid_request",
      "Impossible de déterminer l'URL de redirection.",
    );
  }
  try {
    const url = new URL(path, origin);
    return url.toString();
  } catch (_err) {
    throw new PremiumCheckoutError(
      "invalid_request",
      "URL de redirection invalide.",
    );
  }
}

export function buildPremiumCheckoutConfig(settings = {}) {
  const priceId =
    typeof settings?.premiumCheckoutPriceId === "string"
      ? settings.premiumCheckoutPriceId.trim()
      : "";
  const stripePublishableKey =
    typeof settings?.stripePublishableKey === "string"
      ? settings.stripePublishableKey.trim()
      : "";
  const durationDays = normalizeDurationDays(
    settings?.premiumCheckoutDurationDays,
  );
  const stripeReady = isStripeConfigured();
  return {
    enabled: stripeReady && Boolean(priceId) && durationDays > 0,
    stripeConfigured: stripeReady,
    priceId,
    stripePublishableKey,
    durationDays,
    durationLabel: durationDays
      ? `${durationDays} jour${durationDays > 1 ? "s" : ""}`
      : "",
  };
}

async function fetchCheckoutSessionRecord(sessionId) {
  if (!sessionId) {
    return null;
  }
  return get(
    `SELECT stripe_session_id AS id,
            user_id AS user_id,
            premium_code_id AS premium_code_id,
            premium_code_value AS premium_code_value,
            completed_at AS completed_at
       FROM premium_checkout_sessions
      WHERE stripe_session_id=?`,
    [sessionId],
  );
}

export async function createPremiumCheckoutSession({ userId, origin }) {
  const numericUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericUserId)) {
    throw new PremiumCheckoutError(
      "unauthorized",
      "Vous devez être connecté pour acheter un accès premium.",
    );
  }

  const settings = await getSiteSettings({ forceRefresh: false });
  const config = buildPremiumCheckoutConfig(settings);
  if (!config.enabled) {
    throw new PremiumCheckoutError(
      "not_configured",
      "La boutique premium est actuellement indisponible.",
    );
  }

  const successBase = buildAbsoluteUrl(
    origin,
    "/account/premium/checkout/success",
  );
  const successUrl = `${successBase}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = buildAbsoluteUrl(origin, "/account/profile");

  let session;
  try {
    const stripe = getStripeClient();
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: config.priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(numericUserId),
      metadata: {
        userId: String(numericUserId),
      },
    });
  } catch (err) {
    throw new PremiumCheckoutError(
      "stripe_error",
      err?.message || "Impossible de créer la session de paiement.",
    );
  }

  await run(
    `INSERT INTO premium_checkout_sessions(stripe_session_id, user_id)
     VALUES(?, ?)
     ON CONFLICT(stripe_session_id) DO UPDATE SET user_id=excluded.user_id`,
    [session.id, numericUserId],
  );

  return { session, config };
}

export async function finalizePremiumCheckoutSession({ userId, sessionId }) {
  const numericUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericUserId)) {
    throw new PremiumCheckoutError(
      "unauthorized",
      "Vous devez être connecté pour récupérer votre code premium.",
    );
  }
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    throw new PremiumCheckoutError(
      "invalid_request",
      "Identifiant de session Stripe manquant.",
    );
  }

  let record = await fetchCheckoutSessionRecord(normalizedSessionId);
  const numericRecordUser = Number.parseInt(record?.user_id, 10);
  if (
    record &&
    Number.isInteger(numericRecordUser) &&
    numericRecordUser !== numericUserId
  ) {
    throw new PremiumCheckoutError(
      "forbidden",
      "Cette session de paiement est associée à un autre compte.",
    );
  }

  let stripeSession;
  try {
    const stripe = getStripeClient();
    stripeSession = await stripe.checkout.sessions.retrieve(
      normalizedSessionId,
    );
  } catch (err) {
    throw new PremiumCheckoutError(
      "stripe_error",
      err?.message || "Impossible de vérifier le paiement auprès de Stripe.",
    );
  }

  if (!record) {
    await run(
      `INSERT OR IGNORE INTO premium_checkout_sessions(stripe_session_id, user_id)
       VALUES(?, ?)`,
      [normalizedSessionId, numericUserId],
    );
    record = await fetchCheckoutSessionRecord(normalizedSessionId);
  } else if (record && record.user_id == null) {
    await run(
      `UPDATE premium_checkout_sessions
          SET user_id=?
        WHERE stripe_session_id=?`,
      [numericUserId, normalizedSessionId],
    );
    record = await fetchCheckoutSessionRecord(normalizedSessionId);
  }

  const settings = await getSiteSettings({ forceRefresh: false });
  const config = buildPremiumCheckoutConfig(settings);

  if (stripeSession.payment_status !== "paid") {
    return {
      status: "pending",
      config,
      session: stripeSession,
    };
  }

  if (
    record?.premium_code_value &&
    record.premium_code_value !== PENDING_TOKEN
  ) {
    return {
      status: "completed",
      config,
      code: {
        code: record.premium_code_value,
      },
      createdNow: false,
      session: stripeSession,
    };
  }

  if (record?.premium_code_value === PENDING_TOKEN) {
    return {
      status: "processing",
      config,
      session: stripeSession,
    };
  }

  const locked = await run(
    `UPDATE premium_checkout_sessions
        SET premium_code_value=?
      WHERE stripe_session_id=?
        AND (premium_code_value IS NULL OR premium_code_value='')`,
    [PENDING_TOKEN, normalizedSessionId],
  );

  if (!locked?.changes) {
    const fresh = await fetchCheckoutSessionRecord(normalizedSessionId);
    if (fresh?.premium_code_value && fresh.premium_code_value !== PENDING_TOKEN) {
      return {
        status: "completed",
        config,
        code: {
          code: fresh.premium_code_value,
        },
        createdNow: false,
        session: stripeSession,
      };
    }
    if (fresh?.premium_code_value === PENDING_TOKEN) {
      return {
        status: "processing",
        config,
        session: stripeSession,
      };
    }
  }

  if (config.durationDays <= 0) {
    await run(
      `UPDATE premium_checkout_sessions
          SET premium_code_value=NULL
        WHERE stripe_session_id=? AND premium_code_value=?`,
      [normalizedSessionId, PENDING_TOKEN],
    );
    throw new PremiumCheckoutError(
      "invalid_configuration",
      "La durée des codes premium n'est pas configurée. Contactez un administrateur.",
    );
  }

  let premiumCode;
  try {
    premiumCode = await createPremiumCode({
      premiumDurationMs: config.durationDays * 24 * 60 * 60 * 1000,
      createdBy: numericUserId,
    });
  } catch (err) {
    await run(
      `UPDATE premium_checkout_sessions
          SET premium_code_value=NULL
        WHERE stripe_session_id=? AND premium_code_value=?`,
      [normalizedSessionId, PENDING_TOKEN],
    );
    if (err instanceof PremiumCodeError) {
      throw new PremiumCheckoutError("code_creation_failed", err.message);
    }
    throw err;
  }

  await run(
    `UPDATE premium_checkout_sessions
        SET premium_code_id=?,
            premium_code_value=?,
            completed_at=CURRENT_TIMESTAMP
      WHERE stripe_session_id=?`,
    [premiumCode.numericId, premiumCode.code, normalizedSessionId],
  );

  return {
    status: "completed",
    config,
    code: premiumCode,
    createdNow: true,
    session: stripeSession,
  };
}
