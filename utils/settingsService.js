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
    `SELECT wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text, github_repo, github_changelog_mode
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
  });

  await run(
    `UPDATE settings
        SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?, github_repo=?, github_changelog_mode=?
      WHERE id=1`,
    [
      normalized.wikiName,
      normalized.logoUrl,
      normalized.adminWebhook,
      normalized.feedWebhook,
      normalized.footerText,
      normalized.githubRepo,
      normalized.changelogMode,
    ],
  );

  invalidateSiteSettingsCache();
  return normalized;
}

export { normalizeSettings as mapSiteSettingsToCamelCase };
export { denormalizeSettings as mapSiteSettingsToForm };
