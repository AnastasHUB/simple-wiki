import { get, run } from "../db.js";

const SETTINGS_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_SETTINGS = {
  wikiName: "Wiki",
  logoUrl: "",
  adminWebhook: "",
  feedWebhook: "",
  footerText: "",
};

const CACHE_STATE = {
  value: null,
  expiresAt: 0,
};

function normalizeSettings(row = {}) {
  return {
    wikiName: row.wiki_name ?? row.wikiName ?? DEFAULT_SETTINGS.wikiName,
    logoUrl: row.logo_url ?? row.logoUrl ?? DEFAULT_SETTINGS.logoUrl,
    adminWebhook:
      row.admin_webhook_url ??
      row.adminWebhook ??
      DEFAULT_SETTINGS.adminWebhook,
    feedWebhook:
      row.feed_webhook_url ?? row.feedWebhook ?? DEFAULT_SETTINGS.feedWebhook,
    footerText:
      row.footer_text ?? row.footerText ?? DEFAULT_SETTINGS.footerText,
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
    `SELECT wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text
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
  const normalized = normalizeSettings({
    wiki_name:
      typeof input.wiki_name === "string" ? input.wiki_name.trim() : null,
    logo_url: typeof input.logo_url === "string" ? input.logo_url.trim() : null,
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
  });

  await run(
    `UPDATE settings
        SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?
      WHERE id=1`,
    [
      normalized.wikiName,
      normalized.logoUrl,
      normalized.adminWebhook,
      normalized.feedWebhook,
      normalized.footerText,
    ],
  );

  invalidateSiteSettingsCache();
  return normalized;
}

export { normalizeSettings as mapSiteSettingsToCamelCase };
export { denormalizeSettings as mapSiteSettingsToForm };
