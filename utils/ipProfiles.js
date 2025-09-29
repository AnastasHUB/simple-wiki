import { createHash } from "crypto";
import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { autoRefreshIpReputation } from "./ipReputation.js";

const SALT = process.env.IP_PROFILE_SALT || "simple-wiki-ip-profile::v1";

function normalizeIp(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim();
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
    `SELECT id, hash FROM ip_profiles WHERE ip = ?`,
    [normalized],
  );
  if (existing?.id) {
    await run("UPDATE ip_profiles SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?", [
      existing.id,
    ]);
    try {
      await autoRefreshIpReputation(normalized);
    } catch (err) {
      console.error("Impossible de rafraîchir la réputation IP", err);
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
    await autoRefreshIpReputation(normalized);
  } catch (err) {
    console.error("Impossible de rafraîchir la réputation IP", err);
  }
  return {
    hash: finalHash,
    shortHash: formatIpProfileLabel(finalHash),
  };
}

export async function getIpProfileByHash(hash) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return null;
  }

  const profile = await get(
    `SELECT id, ip, hash, created_at, last_seen_at,
            reputation_status, reputation_provider, reputation_reason,
            reputation_checked_at, reputation_flagged_at,
            reputation_reviewed_at, reputation_reviewed_by
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
    ip: profile.ip,
    createdAt: profile.created_at || null,
    lastSeenAt: profile.last_seen_at || null,
    reputation: {
      status: profile.reputation_status || "unknown",
      provider: profile.reputation_provider || null,
      reason: profile.reputation_reason || null,
      checkedAt: profile.reputation_checked_at || null,
      flaggedAt: profile.reputation_flagged_at || null,
      reviewedAt: profile.reputation_reviewed_at || null,
      reviewedBy: profile.reputation_reviewed_by || null,
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
        ipr.reputation_reason,
        ipr.reputation_checked_at,
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
      reason: row.reputation_reason || null,
      checkedAt: row.reputation_checked_at || null,
    },
    stats: {
      approvedComments: Number(row.approved_comments || 0),
      submissions: Number(row.submissions || 0),
      likes: Number(row.likes || 0),
      views: Number(row.views || 0),
    },
  }));
}

export async function countFlaggedIpProfiles() {
  const row = await get(
    "SELECT COUNT(*) AS total FROM ip_profiles WHERE reputation_status='flagged'",
  );
  return Number(row?.total ?? 0);
}

export async function fetchFlaggedIpProfiles() {
  const rows = await all(
    `SELECT id, hash, ip, reputation_reason, reputation_checked_at,
            reputation_flagged_at, reputation_provider
       FROM ip_profiles
      WHERE reputation_status='flagged'
      ORDER BY COALESCE(reputation_flagged_at, reputation_checked_at) DESC, last_seen_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    reason: row.reputation_reason || "Signalement sans précision",
    provider: row.reputation_provider || null,
    flaggedAt: row.reputation_flagged_at || row.reputation_checked_at || null,
    checkedAt: row.reputation_checked_at || null,
  }));
}

export async function markIpProfileSafe(hash, reviewer = null) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return false;
  }
  const profile = await get(
    `SELECT id FROM ip_profiles WHERE hash = ?`,
    [normalized],
  );
  if (!profile?.id) {
    return false;
  }
  const now = new Date().toISOString();
  await run(
    `UPDATE ip_profiles
        SET reputation_status='safe',
            reputation_reason='Validé manuellement par un administrateur.',
            reputation_flagged_at=NULL,
            reputation_provider='manuel',
            reputation_reviewed_at=?,
            reputation_reviewed_by=?,
            reputation_checked_at=?
      WHERE id=?`,
    [now, reviewer || null, now, profile.id],
  );
  return true;
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
