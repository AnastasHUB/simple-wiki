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
  propellerAdsEnabled: false,
  propellerAdsTag: "",
  propellerVerificationFilename: "",
};

const CACHE_STATE = {
  value: null,
  expiresAt: 0,
};

function normalizeSettings(row = {}) {
  const rawPropellerEnabled =
    row.propeller_ads_enabled ??
    row.propellerAdsEnabled ??
    DEFAULT_SETTINGS.propellerAdsEnabled;
  const normalizedPropellerEnabled =
    typeof rawPropellerEnabled === "string"
      ? ["1", "true", "on"].includes(rawPropellerEnabled.trim().toLowerCase())
      : Boolean(rawPropellerEnabled);
  const rawPropellerTag =
    row.propeller_ads_tag ??
    row.propellerAdsTag ??
    DEFAULT_SETTINGS.propellerAdsTag;
  const rawVerificationFilename =
    row.propeller_verification_filename ??
    row.propellerVerificationFilename ??
    DEFAULT_SETTINGS.propellerVerificationFilename;
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
    propellerAdsEnabled: normalizedPropellerEnabled,
    propellerAdsTag:
      typeof rawPropellerTag === "string"
        ? rawPropellerTag.trim()
        : DEFAULT_SETTINGS.propellerAdsTag,
    propellerVerificationFilename:
      typeof rawVerificationFilename === "string"
        ? rawVerificationFilename.trim()
        : DEFAULT_SETTINGS.propellerVerificationFilename,
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
    propeller_ads_enabled: normalized.propellerAdsEnabled ? 1 : 0,
    propeller_ads_tag: normalized.propellerAdsTag,
    propeller_verification_filename: normalized.propellerVerificationFilename,
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
    `SELECT wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text, github_repo, github_changelog_mode, propeller_ads_enabled, propeller_ads_tag, propeller_verification_filename
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

  const propellerAdsEnabled =
    typeof input.propeller_ads_enabled === "string"
      ? ["1", "true", "on"].includes(input.propeller_ads_enabled.trim().toLowerCase())
      : Boolean(input.propeller_ads_enabled);
  const propellerAdsTag =
    typeof input.propeller_ads_tag === "string"
      ? input.propeller_ads_tag.trim()
      : "";
  const propellerVerificationFilename =
    typeof input.propeller_verification_filename === "string"
      ? input.propeller_verification_filename.trim()
      : "";

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
    propeller_ads_enabled: propellerAdsEnabled ? 1 : 0,
    propeller_ads_tag: propellerAdsTag,
    propeller_verification_filename: propellerVerificationFilename,
  });

  await run(
    `UPDATE settings
        SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?, github_repo=?, github_changelog_mode=?, propeller_ads_enabled=?, propeller_ads_tag=?, propeller_verification_filename=?
      WHERE id=1`,
    [
      normalized.wikiName,
      normalized.logoUrl,
      normalized.adminWebhook,
      normalized.feedWebhook,
      normalized.footerText,
      normalized.githubRepo,
      normalized.changelogMode,
      normalized.propellerAdsEnabled ? 1 : 0,
      normalized.propellerAdsTag,
      normalized.propellerVerificationFilename,
    ],
  );

  invalidateSiteSettingsCache();
  return normalized;
}

export { normalizeSettings as mapSiteSettingsToCamelCase };
export { denormalizeSettings as mapSiteSettingsToForm };
