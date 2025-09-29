import { createHash } from "crypto";
import fetch from "node-fetch";
import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const configuredRefreshInterval =
  process.env.IP_REPUTATION_REFRESH_MS !== undefined
    ? Number(process.env.IP_REPUTATION_REFRESH_MS)
    : DEFAULT_REFRESH_INTERVAL_MS;
export const IP_REPUTATION_REFRESH_INTERVAL_MS = Number.isFinite(
  configuredRefreshInterval,
)
  ? Math.max(60 * 60 * 1000, configuredRefreshInterval)
  : DEFAULT_REFRESH_INTERVAL_MS;

// ipapi.is fournit une API gratuite et sans quota pour détecter VPN/Proxy/Tor.
const IP_REPUTATION_ENDPOINT =
  process.env.IP_REPUTATION_ENDPOINT || "https://api.ipapi.is";
const DEFAULT_TIMEOUT_MS = 8000;
const configuredTimeout =
  process.env.IP_REPUTATION_TIMEOUT_MS !== undefined
    ? Number(process.env.IP_REPUTATION_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
const IP_REPUTATION_TIMEOUT_MS = Number.isFinite(configuredTimeout)
  ? Math.max(2000, configuredTimeout)
  : DEFAULT_TIMEOUT_MS;

const SALT = process.env.IP_PROFILE_SALT || "simple-wiki-ip-profile::v1";

function normalizeOverride(value) {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["safe", "banned"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeIp(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim();
}

function computeReputationFlags(data = {}) {
  return {
    isVpn: Boolean(data?.is_vpn),
    isProxy: Boolean(data?.is_proxy),
    isTor: Boolean(data?.is_tor),
    isDatacenter: Boolean(data?.is_datacenter),
    isAbuser: Boolean(data?.is_abuser),
  };
}

function computeAutoStatus(flags) {
  if (!flags) {
    return "unknown";
  }
  const suspicious =
    flags.isVpn || flags.isProxy || flags.isTor || flags.isDatacenter || flags.isAbuser;
  return suspicious ? "suspicious" : "clean";
}

function buildReputationSummary(data, flags) {
  const reasons = [];
  if (flags.isVpn) reasons.push("VPN");
  if (flags.isProxy) reasons.push("Proxy");
  if (flags.isTor) reasons.push("Tor");
  if (flags.isDatacenter) reasons.push("Hébergement");
  if (flags.isAbuser) reasons.push("Risque d'abus");

  const baseSummary = reasons.length
    ? `Signaux détectés : ${reasons.join(", ")}.`
    : "Aucun signal VPN/Proxy connu pour cette IP.";

  const details = [];
  if (data?.company?.name) {
    details.push(`Fournisseur : ${data.company.name}`);
  } else if (data?.datacenter?.datacenter) {
    details.push(`Fournisseur : ${data.datacenter.datacenter}`);
  }
  if (data?.location?.country) {
    details.push(`Localisation estimée : ${data.location.country}`);
  }

  if (!details.length) {
    return baseSummary;
  }
  return `${baseSummary} ${details.join(" · ")}.`;
}

async function queryIpReputation(ip) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IP_REPUTATION_TIMEOUT_MS);
  try {
    const endpoint = `${IP_REPUTATION_ENDPOINT}?q=${encodeURIComponent(ip)}`;
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Requête IPAPI échouée (${response.status})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}


export function hashIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }
  return createHash("sha256")
    .update(`${SALT}:${normalized}`)
    .digest("hex");
}

export function formatIpProfileLabel(hash, length = 10) {
  if (!hash) {
    return null;
  }
  const safeLength = Number.isInteger(length) && length > 3 ? length : 10;
  return hash.slice(0, safeLength).toUpperCase();
}

export async function touchIpProfile(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }
  const hashed = hashIp(normalized);
  if (!hashed) {
    return null;
  }

  const existing = await get(
    "SELECT id, hash FROM ip_profiles WHERE ip = ?",
    [normalized],
  );
  if (existing?.id) {
    await run("UPDATE ip_profiles SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?", [
      existing.id,
    ]);
    try {
      await refreshIpReputation(normalized);
    } catch (err) {
      console.error("Unable to refresh IP reputation", err);
    }
    return {
      hash: existing.hash,
      shortHash: formatIpProfileLabel(existing.hash),
    };
  }

  const snowflake = generateSnowflake();
  try {
    await run(
      "INSERT INTO ip_profiles(snowflake_id, ip, hash) VALUES(?,?,?)",
      [snowflake, normalized, hashed],
    );
  } catch (err) {
    if (err?.code !== "SQLITE_CONSTRAINT_UNIQUE") {
      throw err;
    }
  }

  const created = await get(
    "SELECT hash FROM ip_profiles WHERE ip = ?",
    [normalized],
  );
  const finalHash = created?.hash || hashed;
  if (created?.hash) {
    await run(
      "UPDATE ip_profiles SET last_seen_at=CURRENT_TIMESTAMP WHERE ip=?",
      [normalized],
    );
  }
  try {
    await refreshIpReputation(normalized);
  } catch (err) {
    console.error("Unable to refresh IP reputation", err);
  }
  return {
    hash: finalHash,
    shortHash: formatIpProfileLabel(finalHash),
  };
}

export async function refreshIpReputation(ip, { force = false } = {}) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }

  const profile = await get(
    `SELECT id, reputation_checked_at, reputation_override, reputation_status, reputation_auto_status, reputation_summary
       FROM ip_profiles
      WHERE ip = ?`,
    [normalized],
  );

  if (!profile?.id) {
    return null;
  }

  const override = normalizeOverride(profile.reputation_override);
  const lastCheckedAt = profile.reputation_checked_at
    ? new Date(profile.reputation_checked_at)
    : null;
  if (
    !force &&
    lastCheckedAt instanceof Date &&
    !Number.isNaN(lastCheckedAt.valueOf()) &&
    Date.now() - lastCheckedAt.valueOf() < IP_REPUTATION_REFRESH_INTERVAL_MS
  ) {
    return {
      status: profile.reputation_status || "unknown",
      autoStatus: profile.reputation_auto_status || "unknown",
      summary: profile.reputation_summary || null,
      override,
      lastCheckedAt: profile.reputation_checked_at || null,
      flags: null,
    };
  }

  let data;
  try {
    data = await queryIpReputation(normalized);
  } catch (err) {
    console.error(`Unable to fetch IP reputation for ${normalized}`, err);
    const message = `Échec de la vérification automatique (${err?.message || err}).`;
    await run(
      `UPDATE ip_profiles
          SET reputation_checked_at=CURRENT_TIMESTAMP,
              reputation_summary=?
        WHERE id=?`,
      [message, profile.id],
    );
    return {
      status: profile.reputation_status || "unknown",
      autoStatus: profile.reputation_auto_status || "unknown",
      summary: message,
      override,
      lastCheckedAt: new Date().toISOString(),
      error: true,
    };
  }

  const flags = computeReputationFlags(data);
  const autoStatus = computeAutoStatus(flags);
  let finalStatus = autoStatus;
  if (override === "safe") {
    finalStatus = "safe";
  } else if (override === "banned") {
    finalStatus = "banned";
  }

  const summary = buildReputationSummary(data, flags);
  await run(
    `UPDATE ip_profiles
        SET reputation_checked_at=CURRENT_TIMESTAMP,
            reputation_auto_status=?,
            reputation_status=?,
            reputation_summary=?,
            reputation_details=?,
            is_vpn=?,
            is_proxy=?,
            is_tor=?,
            is_datacenter=?,
            is_abuser=?
      WHERE id=?`,
    [
      autoStatus,
      finalStatus,
      summary,
      JSON.stringify(data),
      flags.isVpn ? 1 : 0,
      flags.isProxy ? 1 : 0,
      flags.isTor ? 1 : 0,
      flags.isDatacenter ? 1 : 0,
      flags.isAbuser ? 1 : 0,
      profile.id,
    ],
  );

  return {
    status: finalStatus,
    autoStatus,
    summary,
    override,
    flags,
    lastCheckedAt: new Date().toISOString(),
    raw: data,
  };
}

export async function getIpProfileByHash(hash) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return null;
  }

  const profile = await get(
    `SELECT id, ip, hash, created_at, last_seen_at,
            reputation_status, reputation_auto_status, reputation_override,
            reputation_summary, reputation_checked_at,
            is_vpn, is_proxy, is_datacenter, is_abuser, is_tor
       FROM ip_profiles
      WHERE hash = ?`,
    [normalized],
  );

  if (!profile?.ip) {
    return null;
  }

  const [viewStats, likeStats, commentStats, submissionStats, submissionBreakdown, recentComments, recentLikes, recentViews, recentSubmissions] =
    await Promise.all([
      get(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT page_id) AS unique_pages, MAX(viewed_at) AS last_at
           FROM page_views
          WHERE ip = ?`,
        [profile.ip],
      ),
      get(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT page_id) AS unique_pages, MAX(created_at) AS last_at
           FROM likes
          WHERE ip = ?`,
        [profile.ip],
      ),
      get(
        `SELECT COUNT(*) AS total, MAX(created_at) AS last_at
           FROM comments
          WHERE ip = ? AND status='approved'`,
        [profile.ip],
      ),
      get(
        `SELECT COUNT(*) AS total, MAX(created_at) AS last_at
           FROM page_submissions
          WHERE ip = ?`,
        [profile.ip],
      ),
      all(
        `SELECT status, COUNT(*) AS total
           FROM page_submissions
          WHERE ip = ?
          GROUP BY status`,
        [profile.ip],
      ),
      all(
        `SELECT c.snowflake_id, c.body, c.created_at, p.title, p.slug_id
           FROM comments c
           JOIN pages p ON p.id = c.page_id
          WHERE c.ip = ? AND c.status='approved'
          ORDER BY c.created_at DESC
          LIMIT 5`,
        [profile.ip],
      ),
      all(
        `SELECT l.snowflake_id, l.created_at, p.title, p.slug_id
           FROM likes l
           JOIN pages p ON p.id = l.page_id
          WHERE l.ip = ?
          ORDER BY l.created_at DESC
          LIMIT 5`,
        [profile.ip],
      ),
      all(
        `SELECT v.snowflake_id, v.viewed_at, p.title, p.slug_id
           FROM page_views v
           JOIN pages p ON p.id = v.page_id
          WHERE v.ip = ?
          ORDER BY v.viewed_at DESC
          LIMIT 5`,
        [profile.ip],
      ),
      all(
        `SELECT ps.snowflake_id, ps.title, ps.status, ps.type, ps.created_at, ps.result_slug_id,
                ps.target_slug_id, p.slug_id AS current_slug, p.title AS current_title
           FROM page_submissions ps
           LEFT JOIN pages p ON p.id = ps.page_id
          WHERE ps.ip = ?
          ORDER BY ps.created_at DESC
          LIMIT 5`,
        [profile.ip],
      ),
    ]);

  const submissionsByStatus = submissionBreakdown.reduce(
    (acc, row) => ({
      ...acc,
      [row.status]: Number(row.total || 0),
    }),
    {},
  );

  return {
    hash: profile.hash,
    shortHash: formatIpProfileLabel(profile.hash),
    createdAt: profile.created_at || null,
    lastSeenAt: profile.last_seen_at || null,
    reputation: {
      status: profile.reputation_status || "unknown",
      autoStatus: profile.reputation_auto_status || "unknown",
      override: normalizeOverride(profile.reputation_override),
      summary: profile.reputation_summary || null,
      lastCheckedAt: profile.reputation_checked_at || null,
      flags: {
        isVpn: Boolean(profile.is_vpn),
        isProxy: Boolean(profile.is_proxy),
        isTor: Boolean(profile.is_tor),
        isDatacenter: Boolean(profile.is_datacenter),
        isAbuser: Boolean(profile.is_abuser),
      },
    },
    stats: {
      views: {
        total: Number(viewStats?.total || 0),
        uniquePages: Number(viewStats?.unique_pages || 0),
        lastAt: viewStats?.last_at || null,
      },
      likes: {
        total: Number(likeStats?.total || 0),
        uniquePages: Number(likeStats?.unique_pages || 0),
        lastAt: likeStats?.last_at || null,
      },
      comments: {
        total: Number(commentStats?.total || 0),
        lastAt: commentStats?.last_at || null,
      },
      submissions: {
        total: Number(submissionStats?.total || 0),
        lastAt: submissionStats?.last_at || null,
        byStatus: submissionsByStatus,
      },
    },
    recent: {
      comments: recentComments.map((row) => ({
        id: row.snowflake_id,
        slug: row.slug_id,
        pageTitle: row.title,
        createdAt: row.created_at,
        excerpt: buildExcerpt(row.body),
      })),
      likes: recentLikes.map((row) => ({
        id: row.snowflake_id,
        slug: row.slug_id,
        pageTitle: row.title,
        createdAt: row.created_at,
      })),
      views: recentViews.map((row) => ({
        id: row.snowflake_id,
        slug: row.slug_id,
        pageTitle: row.title,
        createdAt: row.viewed_at,
      })),
      submissions: recentSubmissions.map((row) => ({
        id: row.snowflake_id,
        status: row.status,
        type: row.type,
        createdAt: row.created_at,
        pageTitle: row.current_title || row.title,
        slug:
          row.result_slug_id || row.current_slug || row.target_slug_id || null,
      })),
    },
  };
}

export async function countIpProfiles({ search = null } = {}) {
  const clauses = [];
  const params = [];
  const normalizedSearch = typeof search === "string" ? search.trim() : "";
  if (normalizedSearch) {
    const like = `%${normalizedSearch}%`;
    clauses.push("(hash LIKE ? OR ip LIKE ?)");
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = await get(
    `SELECT COUNT(*) AS total FROM ip_profiles ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function fetchIpProfiles({
  search = null,
  limit = 50,
  offset = 0,
} = {}) {
  const clauses = [];
  const params = [];
  const normalizedSearch = typeof search === "string" ? search.trim() : "";
  if (normalizedSearch) {
    const like = `%${normalizedSearch}%`;
    clauses.push("(ipr.hash LIKE ? OR ipr.ip LIKE ?)");
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const rows = await all(
    `SELECT
        ipr.id,
        ipr.hash,
        ipr.ip,
        ipr.created_at,
        ipr.last_seen_at,
        ipr.reputation_status,
        ipr.reputation_auto_status,
        ipr.reputation_override,
        ipr.reputation_summary,
        ipr.reputation_checked_at,
        ipr.is_vpn,
        ipr.is_proxy,
        ipr.is_tor,
        ipr.is_datacenter,
        ipr.is_abuser,
        (SELECT COUNT(*) FROM comments WHERE ip = ipr.ip AND status='approved') AS approved_comments,
        (SELECT COUNT(*) FROM page_submissions WHERE ip = ipr.ip) AS submissions,
        (SELECT COUNT(*) FROM likes WHERE ip = ipr.ip) AS likes,
        (SELECT COUNT(*) FROM page_views WHERE ip = ipr.ip) AS views
      FROM ip_profiles ipr
      ${where}
      ORDER BY ipr.last_seen_at DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset],
  );

  return rows.map((row) => ({
    id: row.id,
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    reputation: {
      status: row.reputation_status || "unknown",
      autoStatus: row.reputation_auto_status || "unknown",
      override: normalizeOverride(row.reputation_override),
      summary: row.reputation_summary || null,
      lastCheckedAt: row.reputation_checked_at || null,
      flags: {
        isVpn: Boolean(row.is_vpn),
        isProxy: Boolean(row.is_proxy),
        isTor: Boolean(row.is_tor),
        isDatacenter: Boolean(row.is_datacenter),
        isAbuser: Boolean(row.is_abuser),
      },
    },
    stats: {
      approvedComments: Number(row.approved_comments || 0),
      submissions: Number(row.submissions || 0),
      likes: Number(row.likes || 0),
      views: Number(row.views || 0),
    },
  }));
}

export async function getRawIpProfileByHash(hash) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return null;
  }
  return get(
    `SELECT * FROM ip_profiles WHERE hash = ?`,
    [normalized],
  );
}

export async function refreshIpReputationByHash(hash, { force = false } = {}) {
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.ip) {
    return null;
  }
  return refreshIpReputation(profile.ip, { force });
}

export async function listIpProfilesForReview({ limit = 50 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const rows = await all(
    `SELECT hash, ip, created_at, last_seen_at, reputation_summary, reputation_checked_at,
            reputation_status, reputation_auto_status, reputation_override,
            is_vpn, is_proxy, is_tor, is_datacenter, is_abuser
       FROM ip_profiles
      WHERE reputation_auto_status='suspicious'
        AND (reputation_override IS NULL OR reputation_override NOT IN ('safe','banned'))
      ORDER BY COALESCE(reputation_checked_at, last_seen_at, created_at) DESC
      LIMIT ?`,
    [safeLimit],
  );
  return rows.map((row) => ({
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    checkedAt: row.reputation_checked_at,
    summary: row.reputation_summary || null,
    status: row.reputation_status || "suspicious",
    autoStatus: row.reputation_auto_status || "suspicious",
    override: normalizeOverride(row.reputation_override),
    flags: {
      isVpn: Boolean(row.is_vpn),
      isProxy: Boolean(row.is_proxy),
      isTor: Boolean(row.is_tor),
      isDatacenter: Boolean(row.is_datacenter),
      isAbuser: Boolean(row.is_abuser),
    },
  }));
}

export async function fetchRecentlyClearedProfiles({ limit = 10 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const rows = await all(
    `SELECT hash, ip, created_at, last_seen_at, reputation_summary, reputation_checked_at,
            reputation_status, reputation_auto_status
       FROM ip_profiles
      WHERE reputation_override='safe'
      ORDER BY COALESCE(reputation_checked_at, last_seen_at, created_at) DESC
      LIMIT ?`,
    [safeLimit],
  );
  return rows.map((row) => ({
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    checkedAt: row.reputation_checked_at,
    summary: row.reputation_summary || null,
    status: row.reputation_status || "safe",
    autoStatus: row.reputation_auto_status || "clean",
  }));
}

async function setIpProfileOverride(hash, override) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return false;
  }
  const normalizedOverride = normalizeOverride(override);
  let statusClause = ", reputation_status=reputation_auto_status";
  if (normalizedOverride === "safe") {
    statusClause = ", reputation_status='safe'";
  } else if (normalizedOverride === "banned") {
    statusClause = ", reputation_status='banned'";
  }
  const result = await run(
    `UPDATE ip_profiles
        SET reputation_override=?${statusClause}
      WHERE hash=?`,
    [normalizedOverride, normalized],
  );
  return Boolean(result?.changes);
}

export async function markIpProfileSafe(hash) {
  return setIpProfileOverride(hash, "safe");
}

export async function markIpProfileBanned(hash) {
  return setIpProfileOverride(hash, "banned");
}

export async function clearIpProfileOverride(hash) {
  return setIpProfileOverride(hash, null);
}

export async function countSuspiciousIpProfiles() {
  const row = await get(
    `SELECT COUNT(*) AS total
       FROM ip_profiles
      WHERE reputation_auto_status='suspicious'
        AND (reputation_override IS NULL OR reputation_override NOT IN ('safe','banned'))`,
  );
  return Number(row?.total ?? 0);
}

function buildExcerpt(text, limit = 160) {
  if (!text) {
    return "";
  }
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}
