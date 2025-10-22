import Stripe from "stripe";

let cachedStripe = null;
let cachedKey = null;

export function isStripeConfigured() {
  return typeof process.env.STRIPE_SECRET_KEY === "string" && process.env.STRIPE_SECRET_KEY.trim().length > 0;
}

export function getStripeClient() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (typeof secretKey !== "string" || !secretKey.trim()) {
    throw new Error(
      "Stripe n'est pas configuré. Définissez la variable d'environnement STRIPE_SECRET_KEY.",
    );
  }
  if (cachedStripe && cachedKey === secretKey) {
    return cachedStripe;
  }
  cachedKey = secretKey;
  cachedStripe = new Stripe(secretKey, {
    apiVersion: "2024-06-20",
  });
  return cachedStripe;
}
