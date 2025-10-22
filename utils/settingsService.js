import { get, run } from "../db.js";
import {
  normalizeGitHubRepo,
  normalizeChangelogMode,
  verifyGitHubRepoExists,
} from "./githubService.js";
import { normalizeHttpUrl, normalizeStoredHttpUrl } from "./urlValidation.js";

const SETTINGS_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_SETTINGS = {
  wikiName: "Wiki",
  logoUrl: "",
  adminWebhook: "",
  feedWebhook: "",
  footerText: "",
  githubRepo: "",
  changelogMode: "commits",
  stripePublishableKey: "",
  premiumCheckoutPriceId: "",
  premiumCheckoutDurationDays: 30,
};

const CACHE_STATE = {
  value: null,
  expiresAt: 0,
};

function normalizeSettings(row = {}) {
  return {
    wikiName: row.wiki_name ?? row.wikiName ?? DEFAULT_SETTINGS.wikiName,
    logoUrl: normalizeStoredHttpUrl(
      row.logo_url ?? row.logoUrl ?? DEFAULT_SETTINGS.logoUrl,
    ),
    adminWebhook:
      row.admin_webhook_url ??
      row.adminWebhook ??
      DEFAULT_SETTINGS.adminWebhook,
    feedWebhook:
      row.feed_webhook_url ?? row.feedWebhook ?? DEFAULT_SETTINGS.feedWebhook,
    footerText:
      row.footer_text ?? row.footerText ?? DEFAULT_SETTINGS.footerText,
    githubRepo:
      row.github_repo ?? row.githubRepo ?? DEFAULT_SETTINGS.githubRepo,
    changelogMode: normalizeChangelogMode(
      row.github_changelog_mode ??
        row.changelogMode ??
        row.githubChangelogMode ??
        DEFAULT_SETTINGS.changelogMode,
    ),
    stripePublishableKey:
      row.stripe_publishable_key ??
      row.stripePublishableKey ??
      DEFAULT_SETTINGS.stripePublishableKey,
    premiumCheckoutPriceId:
      row.premium_checkout_price_id ??
      row.premiumCheckoutPriceId ??
      DEFAULT_SETTINGS.premiumCheckoutPriceId,
    premiumCheckoutDurationDays: (() => {
      const rawDuration =
        row.premium_checkout_duration_days ??
        row.premiumCheckoutDurationDays ??
        DEFAULT_SETTINGS.premiumCheckoutDurationDays;
      const parsed = Number.parseInt(rawDuration, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
      }
      return parsed;
    })(),
  };
}

function denormalizeSettings(settings) {
  const normalized = normalizeSettings(settings);
  return {
    wiki_name: normalized.wikiName,
    logo_url: normalized.logoUrl,
    admin_webhook_url: normalized.adminWebhook,
    feed_webhook_url: normalized.feedWebhook,
    footer_text: normalized.footerText,
    github_repo: normalized.githubRepo,
    github_changelog_mode: normalized.changelogMode,
    stripe_publishable_key: normalized.stripePublishableKey,
    premium_checkout_price_id: normalized.premiumCheckoutPriceId,
    premium_checkout_duration_days: normalized.premiumCheckoutDurationDays,
  };
}

export function invalidateSiteSettingsCache() {
  CACHE_STATE.value = null;
  CACHE_STATE.expiresAt = 0;
}

export async function getSiteSettings({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && CACHE_STATE.value && CACHE_STATE.expiresAt > now) {
    return CACHE_STATE.value;
  }

  const row = await get(
    `SELECT wiki_name,
            logo_url,
            admin_webhook_url,
            feed_webhook_url,
            footer_text,
            github_repo,
            github_changelog_mode,
            stripe_publishable_key,
            premium_checkout_price_id,
            premium_checkout_duration_days
       FROM settings
      WHERE id=1`,
  );
  const settings = normalizeSettings(row);
  CACHE_STATE.value = settings;
  CACHE_STATE.expiresAt = now + SETTINGS_CACHE_TTL_MS;
  return settings;
}

export async function getSiteSettingsForForm() {
  const settings = await getSiteSettings();
  return denormalizeSettings(settings);
}

export async function updateSiteSettingsFromForm(input = {}) {
  let githubRepo = "";
  try {
    githubRepo = normalizeGitHubRepo(
      input.github_repo ?? input.githubRepo ?? "",
    );
  } catch (err) {
    throw new Error(err.message || "Le dépôt GitHub fourni est invalide.");
  }

  const changelogMode = normalizeChangelogMode(
    input.github_changelog_mode ??
      input.changelogMode ??
      input.githubChangelogMode,
  );

  const rawLogoInput =
    typeof input.logo_url === "string"
      ? input.logo_url
      : typeof input.logoUrl === "string"
      ? input.logoUrl
      : "";
  let logoUrl = "";
  if (rawLogoInput) {
    try {
      logoUrl =
        normalizeHttpUrl(rawLogoInput, {
          fieldName: "L'URL du logo",
        }) || "";
    } catch (err) {
      throw new Error(err?.message || "L'URL du logo est invalide.");
    }
  }

  if (githubRepo) {
    const exists = await verifyGitHubRepoExists(githubRepo);
    if (!exists) {
      throw new Error(
        "Le dépôt GitHub spécifié est introuvable ou privé. Vérifiez le nom owner/repo.",
      );
    }
  }

  const stripePublishableKey = (() => {
    if (typeof input.stripe_publishable_key === "string") {
      return input.stripe_publishable_key.trim();
    }
    if (typeof input.stripePublishableKey === "string") {
      return input.stripePublishableKey.trim();
    }
    return "";
  })();

  const premiumCheckoutPriceId = (() => {
    if (typeof input.premium_checkout_price_id === "string") {
      return input.premium_checkout_price_id.trim();
    }
    if (typeof input.premiumCheckoutPriceId === "string") {
      return input.premiumCheckoutPriceId.trim();
    }
    return "";
  })();

  const rawPremiumDuration =
    input.premium_checkout_duration_days ?? input.premiumCheckoutDurationDays ?? "";
  const normalizedPremiumDuration =
    typeof rawPremiumDuration === "string"
      ? rawPremiumDuration.trim()
      : rawPremiumDuration;
  let premiumCheckoutDurationDays = 0;
  if (normalizedPremiumDuration !== "" && normalizedPremiumDuration != null) {
    const parsedDuration = Number.parseInt(normalizedPremiumDuration, 10);
    if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
      throw new Error(
        "La durée premium doit être un entier positif (en jours).",
      );
    }
    premiumCheckoutDurationDays = parsedDuration;
  } else if (premiumCheckoutPriceId) {
    premiumCheckoutDurationDays = DEFAULT_SETTINGS.premiumCheckoutDurationDays;
  }

  const normalized = normalizeSettings({
    wiki_name:
      typeof input.wiki_name === "string" ? input.wiki_name.trim() : null,
    logo_url: logoUrl,
    admin_webhook_url:
      typeof input.admin_webhook_url === "string"
        ? input.admin_webhook_url.trim()
        : null,
    feed_webhook_url:
      typeof input.feed_webhook_url === "string"
        ? input.feed_webhook_url.trim()
        : null,
    footer_text:
      typeof input.footer_text === "string" ? input.footer_text.trim() : null,
    github_repo: githubRepo,
    github_changelog_mode: changelogMode,
    stripe_publishable_key: stripePublishableKey,
    premium_checkout_price_id: premiumCheckoutPriceId,
    premium_checkout_duration_days: premiumCheckoutDurationDays,
  });

  await run(
    `UPDATE settings
        SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?, github_repo=?, github_changelog_mode=?, stripe_publishable_key=?, premium_checkout_price_id=?, premium_checkout_duration_days=?
      WHERE id=1`,
    [
      normalized.wikiName,
      normalized.logoUrl,
      normalized.adminWebhook,
      normalized.feedWebhook,
      normalized.footerText,
      normalized.githubRepo,
      normalized.changelogMode,
      normalized.stripePublishableKey,
      normalized.premiumCheckoutPriceId,
      normalized.premiumCheckoutDurationDays,
    ],
  );

  invalidateSiteSettingsCache();
  return normalized;
}

export { normalizeSettings as mapSiteSettingsToCamelCase };
export { denormalizeSettings as mapSiteSettingsToForm };
