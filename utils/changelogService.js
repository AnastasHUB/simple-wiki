import fetch from "node-fetch";
import { getSiteSettings } from "./settingsService.js";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = Object.freeze([5, 10, 20, 30]);

function parseRepoSlug(slug) {
  if (typeof slug !== "string") {
    return { owner: null, name: null };
  }
  const trimmed = slug.trim();
  if (!trimmed) {
    return { owner: null, name: null };
  }
  const [owner, name] = trimmed.split("/");
  if (!owner || !name) {
    return { owner: null, name: null };
  }
  return { owner, name };
}

function sanitizePage(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_PAGE;
}

function sanitizePerPage(value) {
  const parsed = Number.parseInt(value, 10);
  if (PAGE_SIZE_OPTIONS.includes(parsed)) {
    return parsed;
  }
  return DEFAULT_PAGE_SIZE;
}

function buildHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "simple-wiki-changelog",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function parseLinkHeader(header) {
  if (!header) {
    return {};
  }
  return header.split(",").reduce((acc, part) => {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      acc[match[2]] = match[1];
    }
    return acc;
  }, {});
}

function mapCommitItem(item) {
  const message = item?.commit?.message || "";
  const [firstLine] = message.split(/\r?\n/, 1);
  const authorName = item?.commit?.author?.name || item?.author?.login || null;
  const authorUrl = item?.author?.html_url || null;
  return {
    id: item?.sha || null,
    type: "commit",
    title: firstLine || "Commit sans titre",
    description: message,
    url: item?.html_url || null,
    sha: item?.sha || null,
    shortSha: item?.sha ? item.sha.slice(0, 7) : null,
    author: authorName,
    authorUrl,
    avatarUrl: item?.author?.avatar_url || null,
    committedAt: item?.commit?.author?.date || null,
  };
}

function mapPullRequestItem(item) {
  const authorLogin = item?.user?.login || null;
  return {
    id: item?.id ? String(item.id) : null,
    type: "pull_request",
    title: item?.title || `Pull request #${item?.number ?? "?"}`,
    url: item?.html_url || null,
    number: item?.number || null,
    state: item?.state || null,
    isMerged: Boolean(item?.merged_at),
    author: authorLogin,
    authorUrl: item?.user?.html_url || null,
    avatarUrl: item?.user?.avatar_url || null,
    createdAt: item?.created_at || null,
    mergedAt: item?.merged_at || null,
    updatedAt: item?.updated_at || null,
  };
}

export function getChangelogPageSizeOptions() {
  return PAGE_SIZE_OPTIONS;
}

export function sanitizeChangelogPage(value) {
  return sanitizePage(value);
}

export function sanitizeChangelogPerPage(value) {
  return sanitizePerPage(value);
}

export async function fetchChangelogEntries({
  page = DEFAULT_PAGE,
  perPage = DEFAULT_PAGE_SIZE,
  settings = null,
} = {}) {
  const safePage = sanitizePage(page);
  const safePerPage = sanitizePerPage(perPage);
  const siteSettings = settings || (await getSiteSettings());
  const repo = siteSettings.githubRepo || "";
  const source = siteSettings.changelogSource === "pulls" ? "pulls" : "commits";

  const { owner, name } = parseRepoSlug(repo);
  if (!owner || !name) {
    return {
      entries: [],
      repo,
      owner: null,
      name: null,
      repoUrl: null,
      source,
      page: safePage,
      perPage: safePerPage,
      hasNext: false,
      hasPrev: safePage > 1,
      rawLinkHeader: null,
      perPageOptions: PAGE_SIZE_OPTIONS,
    };
  }

  const params = new URLSearchParams({
    per_page: String(safePerPage),
    page: String(safePage),
  });

  let endpoint = `/repos/${owner}/${name}/commits`;
  if (source === "pulls") {
    endpoint = `/repos/${owner}/${name}/pulls`;
    params.set("state", "all");
    params.set("sort", "updated");
    params.set("direction", "desc");
  }

  const response = await fetch(`${GITHUB_API_BASE}${endpoint}?${params}`, {
    headers: buildHeaders(),
  });

  if (!response.ok) {
    const error = new Error(`GitHub API error: ${response.status}`);
    error.status = response.status;
    try {
      error.body = await response.text();
    } catch (err) {
      error.body = null;
    }
    throw error;
  }

  const payload = await response.json();
  const linkHeader = response.headers.get("link");
  const links = parseLinkHeader(linkHeader);
  const hasNext = Boolean(links.next);
  const hasPrev = safePage > 1;

  const entries = Array.isArray(payload)
    ? payload.map((item) => (source === "pulls" ? mapPullRequestItem(item) : mapCommitItem(item)))
    : [];

  return {
    entries,
    repo,
    owner,
    name,
    repoUrl: `https://github.com/${owner}/${name}`,
    source,
    page: safePage,
    perPage: safePerPage,
    hasNext,
    hasPrev,
    rawLinkHeader: linkHeader,
    perPageOptions: PAGE_SIZE_OPTIONS,
  };
}
