import fetch from "node-fetch";

export const GITHUB_CHANGELOG_MODES = {
  COMMITS: "commits",
  PULLS: "pulls",
};

export const CHANGELOG_PAGE_SIZES = [5, 10, 20];
export const DEFAULT_CHANGELOG_PAGE_SIZE = 10;

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function buildHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "simple-wiki",
  };
}

export function normalizeGitHubRepo(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  let candidate = trimmed;
  try {
    const maybeUrl = new URL(trimmed);
    if (maybeUrl.hostname.toLowerCase() === "github.com") {
      const pathname = maybeUrl.pathname.replace(/\.git$/i, "");
      candidate = pathname.replace(/^\/+|\/+$/g, "");
    }
  } catch {
    // Ignore invalid URL errors and treat the value as a direct repo string.
    candidate = candidate.replace(/^https?:\/\/github\.com\//i, "");
    candidate = candidate.replace(/\.git$/i, "");
  }

  candidate = candidate.replace(/\/+$/g, "");
  candidate = candidate.replace(/\.git$/i, "");

  if (!GITHUB_REPO_PATTERN.test(candidate)) {
    throw new Error(
      "Le dépôt GitHub doit être au format owner/repo ou une URL valide.",
    );
  }

  return candidate;
}

export function normalizeChangelogMode(rawValue) {
  const value =
    typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
  if (value === GITHUB_CHANGELOG_MODES.PULLS || value === "pull_requests") {
    return GITHUB_CHANGELOG_MODES.PULLS;
  }
  return GITHUB_CHANGELOG_MODES.COMMITS;
}

export async function verifyGitHubRepoExists(repo) {
  if (!repo) {
    return true;
  }

  const response = await fetch(`${GITHUB_API_BASE}/repos/${repo}`, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(
      `Impossible de vérifier le dépôt GitHub (erreur ${response.status}). Veuillez réessayer plus tard.`,
    );
  }

  return true;
}

function parseLinkHeader(headerValue) {
  const links = {};
  if (!headerValue) {
    return links;
  }

  const parts = headerValue.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
  }
  return links;
}

function mapCommit(entry) {
  const message = entry?.commit?.message || "";
  const firstLine = message.split("\n")[0] || "Commit";
  return {
    id: entry?.sha || entry?.node_id || firstLine,
    type: "commit",
    title: firstLine,
    description: message,
    author: entry?.author?.login || entry?.commit?.author?.name || "Inconnu",
    avatarUrl: entry?.author?.avatar_url || null,
    url: entry?.html_url || null,
    timestamp:
      entry?.commit?.author?.date || entry?.commit?.committer?.date || null,
    sha: entry?.sha || null,
  };
}

function mapPullRequest(entry) {
  return {
    id: entry?.id ? String(entry.id) : entry?.node_id || entry?.html_url,
    type: "pull",
    number: entry?.number || null,
    title:
      entry?.title ||
      (entry?.number ? `Pull request #${entry.number}` : "Pull request"),
    description: entry?.body || "",
    author: entry?.user?.login || "Inconnu",
    avatarUrl: entry?.user?.avatar_url || null,
    url: entry?.html_url || null,
    createdAt: entry?.created_at || null,
    updatedAt: entry?.updated_at || null,
    closedAt: entry?.closed_at || null,
    mergedAt: entry?.merged_at || null,
    state: entry?.state || "open",
    draft: Boolean(entry?.draft),
  };
}

function buildCommitsUrl(repo, { perPage, page }) {
  const url = new URL(`${GITHUB_API_BASE}/repos/${repo}/commits`);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  return url.toString();
}

function buildPullsUrl(repo, { perPage, page }) {
  const url = new URL(`${GITHUB_API_BASE}/repos/${repo}/pulls`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  return url.toString();
}

export async function fetchGitHubChangelog({ repo, mode, perPage, page }) {
  if (!repo) {
    return { entries: [], hasNext: false, rateLimit: null };
  }

  const normalizedMode = normalizeChangelogMode(mode);
  const pagination = { perPage, page };
  const endpoint =
    normalizedMode === GITHUB_CHANGELOG_MODES.PULLS
      ? buildPullsUrl(repo, pagination)
      : buildCommitsUrl(repo, pagination);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: buildHeaders(),
  });

  if (response.status === 404) {
    throw new Error("Le dépôt GitHub configuré est introuvable.");
  }

  if (!response.ok) {
    const bodyText = await response.text();
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.message) {
        detail = parsed.message;
      }
    } catch {
      // Ignore JSON parsing issues and keep the raw text.
    }
    throw new Error(
      `Impossible de récupérer le changelog GitHub (erreur ${response.status}). ${detail}`,
    );
  }

  const raw = await response.json();
  const linkHeader = response.headers.get("link");
  const links = parseLinkHeader(linkHeader);
  const hasNext = Boolean(links.next);
  const rateLimit = {
    limit:
      Number.parseInt(response.headers.get("x-ratelimit-limit") || "0", 10) ||
      null,
    remaining:
      Number.parseInt(
        response.headers.get("x-ratelimit-remaining") || "0",
        10,
      ) || null,
    reset:
      Number.parseInt(response.headers.get("x-ratelimit-reset") || "0", 10) ||
      null,
  };

  const entries = Array.isArray(raw)
    ? raw.map((item) =>
        normalizedMode === GITHUB_CHANGELOG_MODES.PULLS
          ? mapPullRequest(item)
          : mapCommit(item),
      )
    : [];

  return { entries, hasNext, rateLimit };
}
