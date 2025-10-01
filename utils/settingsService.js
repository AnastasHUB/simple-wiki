import { get, run } from "../db.js";

const SETTINGS_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_SETTINGS = {
  wikiName: "Wiki",
  logoUrl: "",
  adminWebhook: "",
  feedWebhook: "",
  footerText: "",
  githubRepo: "",
  changelogSource: "commits",
};

const VALID_CHANGELOG_SOURCES = new Set(["commits", "pulls"]);

function normalizeGithubRepo(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.githubRepo;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const isValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed);
  return isValid ? trimmed : "";
}

function normalizeChangelogSource(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (VALID_CHANGELOG_SOURCES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_SETTINGS.changelogSource;
}

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
    githubRepo: normalizeGithubRepo(
      row.github_repo ?? row.githubRepo ?? DEFAULT_SETTINGS.githubRepo,
    ),
    changelogSource: normalizeChangelogSource(
      row.changelog_source ??
        row.changelogSource ??
        DEFAULT_SETTINGS.changelogSource,
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
    changelog_source: normalized.changelogSource,
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
            changelog_source
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
    github_repo:
      typeof input.github_repo === "string" ? input.github_repo.trim() : null,
    changelog_source:
      typeof input.changelog_source === "string"
        ? input.changelog_source.trim()
        : null,
  });

  await run(
    `UPDATE settings
        SET wiki_name=?,
            logo_url=?,
            admin_webhook_url=?,
            feed_webhook_url=?,
            footer_text=?,
            github_repo=?,
            changelog_source=?
      WHERE id=1`,
    [
      normalized.wikiName,
      normalized.logoUrl,
      normalized.adminWebhook,
      normalized.feedWebhook,
      normalized.footerText,
      normalized.githubRepo,
      normalized.changelogSource,
    ],
  );

  invalidateSiteSettingsCache();
  return normalized;
}

export { normalizeSettings as mapSiteSettingsToCamelCase };
export { denormalizeSettings as mapSiteSettingsToForm };
export const CHANGELOG_SOURCE_OPTIONS = Object.freeze(
  Array.from(VALID_CHANGELOG_SOURCES),
);
