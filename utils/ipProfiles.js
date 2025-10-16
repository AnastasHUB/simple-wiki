import { createHash } from "crypto";
import nodeFetch from "node-fetch";
import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { getActiveBans } from "./ipBans.js";
import { detectBotUserAgentWithApi } from "./ip.js";

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
const STOP_FORUM_SPAM_ENDPOINT =
  process.env.STOP_FORUM_SPAM_ENDPOINT ||
  "https://api.stopforumspam.com/api";
const IP_GEOLOCATION_ENDPOINT =
  process.env.IP_GEOLOCATION_ENDPOINT || "https://ipwho.is";
const DEFAULT_TIMEOUT_MS = 8000;
const configuredTimeout =
  process.env.IP_REPUTATION_TIMEOUT_MS !== undefined
    ? Number(process.env.IP_REPUTATION_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
const IP_REPUTATION_TIMEOUT_MS = Number.isFinite(configuredTimeout)
  ? Math.max(2000, configuredTimeout)
  : DEFAULT_TIMEOUT_MS;

const SALT = process.env.IP_PROFILE_SALT || "simple-wiki-ip-profile::v1";
export const IP_PROFILE_COMMENT_PAGE_SIZES = Object.freeze([5, 10, 50, 100]);

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

function normalizeReputationSources(data = {}) {
  if (
    data &&
    typeof data === "object" &&
    ("ipapi" in data || "stopForumSpam" in data || "ipwhois" in data)
  ) {
    return {
      ipapi: data.ipapi || null,
      stopForumSpam: data.stopForumSpam || null,
      ipwhois: data.ipwhois || null,
      errors: Array.isArray(data.errors) ? data.errors : [],
    };
  }
  return { ipapi: data || null, stopForumSpam: null, ipwhois: null, errors: [] };
}

function computeReputationFlags(data = {}) {
  const sources = normalizeReputationSources(data);
  const ipapi = sources.ipapi || {};
  const stopForumSpam = sources.stopForumSpam || {};

  const isAbuserFromStopForumSpam = Boolean(stopForumSpam.appears);
  const isAbuserFromIpapi = Boolean(ipapi?.is_abuser);

  return {
    isVpn: Boolean(ipapi?.is_vpn),
    isProxy: Boolean(ipapi?.is_proxy),
    isTor: Boolean(ipapi?.is_tor),
    isDatacenter: Boolean(ipapi?.is_datacenter),
    isAbuser: isAbuserFromIpapi || isAbuserFromStopForumSpam,
  };
}

function computeAutoStatus(flags) {
  if (!flags) {
    return "unknown";
  }
  const suspicious =
    flags.isVpn ||
    flags.isProxy ||
    flags.isTor ||
    flags.isDatacenter ||
    flags.isAbuser;
  return suspicious ? "suspicious" : "clean";
}

function formatLocation(ipapi, ipwhois) {
  const city = ipapi?.location?.city || ipwhois?.city || null;
  const region = ipapi?.location?.region || ipwhois?.region || null;
  const country = ipapi?.location?.country || ipwhois?.country || null;
  const parts = [];
  if (city) {
    parts.push(city);
  }
  if (region && region !== city) {
    parts.push(region);
  }
  if (country && country !== region) {
    parts.push(country);
  }
  if (!parts.length && country) {
    parts.push(country);
  }
  return parts.length ? parts.join(", ") : null;
}

function buildReputationSummary(data, flags) {
  const sources = normalizeReputationSources(data);
  const ipapi = sources.ipapi || null;
  const stopForumSpam = sources.stopForumSpam || null;
  const ipwhois = sources.ipwhois || null;
  const hasSourceData = Boolean(ipapi || stopForumSpam || ipwhois);

  if (!hasSourceData) {
    if (sources.errors?.length) {
      const errorSummary = sources.errors.join(" | ");
      return `Échec de la récupération des données de réputation (${errorSummary}).`;
    }
    return "Aucune donnée de réputation disponible.";
  }

  const ipapiDetails = ipapi || {};
  const ipwhoisDetails = ipwhois || {};
  const reasons = [];
  if (flags.isVpn) reasons.push("VPN");
  if (flags.isProxy) reasons.push("Proxy");
  if (flags.isTor) reasons.push("Tor");
  if (flags.isDatacenter) reasons.push("Hébergement");
  if (flags.isAbuser) reasons.push("Risque d'abus");
  if (stopForumSpam?.appears) {
    const confidence = Number.isFinite(stopForumSpam.confidence)
      ? Math.round(stopForumSpam.confidence)
      : null;
    if (confidence !== null) {
      reasons.push(`StopForumSpam (${confidence}% confiance)`);
    } else {
      reasons.push("Signalement StopForumSpam");
    }
  }

  const baseSummary = reasons.length
    ? `Signaux détectés : ${reasons.join(", ")}.`
    : "Aucun signal VPN/Proxy connu pour cette IP.";

  const details = [];
  if (ipapiDetails?.company?.name) {
    details.push(`Fournisseur : ${ipapiDetails.company.name}`);
  } else if (ipapiDetails?.datacenter?.datacenter) {
    details.push(`Fournisseur : ${ipapiDetails.datacenter.datacenter}`);
  } else if (ipwhoisDetails?.connection?.isp) {
    details.push(`Fournisseur : ${ipwhoisDetails.connection.isp}`);
  } else if (ipwhoisDetails?.connection?.org) {
    details.push(`Fournisseur : ${ipwhoisDetails.connection.org}`);
  }

  const ipType = ipapiDetails?.connection_type || ipapiDetails?.type || null;
  if (ipType) {
    details.push(`Type de connexion : ${ipType}`);
  }

  const location = formatLocation(ipapiDetails, ipwhoisDetails);
  if (location) {
    details.push(`Localisation estimée : ${location}`);
  }

  const timezone =
    ipapiDetails?.location?.time_zone ||
    ipapiDetails?.timezone?.id ||
    ipwhoisDetails?.timezone ||
    null;
  if (timezone) {
    details.push(`Fuseau horaire : ${timezone}`);
  }

  const asnNumber =
    ipapiDetails?.asn?.asn ||
    (typeof ipapiDetails?.asn === "string" ? ipapiDetails.asn : null) ||
    ipwhoisDetails?.connection?.asn ||
    null;
  const asnName = ipapiDetails?.asn?.name || null;
  if (asnNumber || asnName) {
    const parts = [asnNumber, asnName].filter(Boolean);
    details.push(`ASN : ${parts.join(" - ")}`);
  }

  if (stopForumSpam?.appears) {
    const frequency = Number.isFinite(stopForumSpam.frequency)
      ? `${stopForumSpam.frequency} signalements`
      : "Signalements";
    const confidence = Number.isFinite(stopForumSpam.confidence)
      ? ` (confiance ${Math.round(stopForumSpam.confidence)}%)`
      : "";
    const lastSeen = stopForumSpam.lastSeenAt
      ? ` · Dernier signalement : ${stopForumSpam.lastSeenAt}`
      : "";
    details.push(`StopForumSpam : ${frequency}${confidence}${lastSeen}`);
  }

  if (!details.length && !sources.errors?.length) {
    return baseSummary;
  }

  const detailSummary = details.length
    ? `${baseSummary} ${details.join(" · ")}.`
    : `${baseSummary}`;

  if (sources.errors?.length) {
    const suffix = `Sources incomplètes : ${sources.errors.join(" | ")}.`;
    return `${detailSummary} ${suffix}`;
  }

  return detailSummary;
}

const pendingReputationRefreshes = new Map();

function scheduleIpReputationRefresh(ip, options = {}) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }

  const key = `${normalized}:${options?.force ? "force" : "auto"}`;
  if (pendingReputationRefreshes.has(key)) {
    return pendingReputationRefreshes.get(key);
  }

  const refreshPromise = refreshIpReputation(normalized, options)
    .catch((err) => {
      console.error("Unable to refresh IP reputation", err);
    })
    .finally(() => {
      pendingReputationRefreshes.delete(key);
    });

  pendingReputationRefreshes.set(key, refreshPromise);
  return refreshPromise;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveFetch() {
  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch.bind(globalThis);
  }
  return nodeFetch;
}

async function fetchJsonWithTimeout(url, {
  timeoutMs = IP_REPUTATION_TIMEOUT_MS,
  headers = {},
  signal,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchFn = resolveFetch();
  try {
    let finalSignal = controller.signal;
    if (signal) {
      if (
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.any === "function"
      ) {
        try {
          finalSignal = AbortSignal.any([signal, controller.signal]);
        } catch {
          finalSignal = signal;
        }
      } else {
        finalSignal = signal;
      }
    }
    const response = await fetchFn(url, {
      signal: finalSignal,
      headers: { Accept: "application/json", ...headers },
    });
    if (!response.ok) {
      throw new Error(`Requête échouée (${response.status})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function queryIpapi(ip) {
  const endpoint = `${IP_REPUTATION_ENDPOINT}?q=${encodeURIComponent(ip)}`;
  return fetchJsonWithTimeout(endpoint);
}

async function queryStopForumSpam(ip) {
  const url = new URL(STOP_FORUM_SPAM_ENDPOINT);
  url.searchParams.set("ip", ip);
  url.searchParams.set("json", "1");
  const json = await fetchJsonWithTimeout(url.toString(), {
    headers: { "User-Agent": "simple-wiki-ip-check" },
  });
  if (!json || json.success !== 1 || !json.ip) {
    throw new Error("Réponse StopForumSpam invalide");
  }
  const appears = Boolean(json.ip.appears);
  return {
    appears,
    confidence: toNumber(json.ip.confidence),
    frequency: toNumber(json.ip.frequency),
    lastSeenAt: json.ip.lastseen || null,
    raw: json.ip,
  };
}

async function queryIpWhois(ip) {
  const endpoint = `${IP_GEOLOCATION_ENDPOINT}/${encodeURIComponent(ip)}`;
  const json = await fetchJsonWithTimeout(endpoint);
  if (!json || json.success === false) {
    throw new Error(json?.message || "Réponse ipwho.is invalide");
  }
  return {
    country: json.country || null,
    region: json.region || null,
    city: json.city || null,
    connection: {
      isp: json.connection?.isp || null,
      org: json.connection?.org || null,
      asn: json.connection?.asn || null,
    },
    timezone: json.timezone?.id || null,
    raw: json,
  };
}

async function queryIpReputation(ip) {
  const [ipapiResult, stopForumSpamResult, ipwhoisResult] =
    await Promise.allSettled([
      queryIpapi(ip),
      queryStopForumSpam(ip),
      queryIpWhois(ip),
    ]);

  const errors = [];
  const result = { ipapi: null, stopForumSpam: null, ipwhois: null, errors };

  if (ipapiResult.status === "fulfilled") {
    result.ipapi = ipapiResult.value;
  } else {
    errors.push(`IPAPI: ${ipapiResult.reason?.message || ipapiResult.reason}`);
  }

  if (stopForumSpamResult.status === "fulfilled") {
    result.stopForumSpam = stopForumSpamResult.value;
  } else {
    errors.push(
      `StopForumSpam: ${
        stopForumSpamResult.reason?.message || stopForumSpamResult.reason
      }`,
    );
  }

  if (ipwhoisResult.status === "fulfilled") {
    result.ipwhois = ipwhoisResult.value;
  } else {
    errors.push(
      `ipwho.is: ${ipwhoisResult.reason?.message || ipwhoisResult.reason}`,
    );
  }

  return result;
}

export function hashIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }
  return createHash("sha256").update(`${SALT}:${normalized}`).digest("hex");
}

export function formatIpProfileLabel(hash, length = 10) {
  if (!hash) {
    return null;
  }
  const safeLength = Number.isInteger(length) && length > 3 ? length : 10;
  return hash.slice(0, safeLength).toUpperCase();
}

export async function touchIpProfile(
  ip,
  { skipRefresh = false, userAgent = null } = {},
) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }
  const hashed = hashIp(normalized);
  if (!hashed) {
    return null;
  }
  const botDetection = await detectBotUserAgentWithApi(userAgent, {
    suppressLog: true,
  });
  const normalizedUserAgent = botDetection.userAgent;

  const existing = await get(
    "SELECT id, snowflake_id, hash FROM ip_profiles WHERE ip = ?",
    [normalized],
  );
  if (existing?.id) {
    const updates = ["last_seen_at=CURRENT_TIMESTAMP"];
    const params = [];
    if (normalizedUserAgent !== null) {
      updates.push("last_user_agent=?", "is_bot=?", "bot_reason=?");
      params.push(
        normalizedUserAgent,
        botDetection.isBot ? 1 : 0,
        botDetection.reason || null,
      );
    }
    await run(`UPDATE ip_profiles SET ${updates.join(", ")} WHERE id=?`, [
      ...params,
      existing.id,
    ]);
    if (!skipRefresh) {
      scheduleIpReputationRefresh(normalized);
    }
    return {
      id: existing.snowflake_id || null,
      legacyId: existing.id || null,
      hash: existing.hash,
      shortHash: formatIpProfileLabel(existing.hash),
    };
  }

  const snowflake = generateSnowflake();
  const columns = ["snowflake_id", "ip", "hash"];
  const placeholders = ["?", "?", "?"];
  const values = [snowflake, normalized, hashed];
  if (normalizedUserAgent !== null) {
    columns.push("last_user_agent", "is_bot", "bot_reason");
    placeholders.push("?", "?", "?");
    values.push(
      normalizedUserAgent,
      botDetection.isBot ? 1 : 0,
      botDetection.reason || null,
    );
  }

  try {
    await run(
      `INSERT INTO ip_profiles(${columns.join(",")}) VALUES(${placeholders.join(",")})`,
      values,
    );
  } catch (err) {
    if (err?.code !== "SQLITE_CONSTRAINT_UNIQUE") {
      throw err;
    }
  }

  const created = await get(
    "SELECT id, snowflake_id, hash FROM ip_profiles WHERE ip = ?",
    [normalized],
  );
  const finalHash = created?.hash || hashed;
  if (created?.hash) {
    await run(
      "UPDATE ip_profiles SET last_seen_at=CURRENT_TIMESTAMP WHERE ip=?",
      [normalized],
    );
  }
  if (!skipRefresh) {
    scheduleIpReputationRefresh(normalized);
  }
  return {
    id: created?.snowflake_id || snowflake,
    legacyId: created?.id || null,
    hash: finalHash,
    shortHash: formatIpProfileLabel(finalHash),
  };
}

export function triggerIpReputationRefresh(ip, options = {}) {
  return scheduleIpReputationRefresh(ip, options);
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
  const sources = normalizeReputationSources(data);
  const hasSourceData = Boolean(
    sources.ipapi || sources.stopForumSpam || sources.ipwhois,
  );
  let autoStatus = computeAutoStatus(flags);
  if (!hasSourceData) {
    autoStatus = "unknown";
  }
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
    `SELECT id, snowflake_id, ip, hash, created_at, last_seen_at,
            reputation_status, reputation_auto_status, reputation_override,
            reputation_summary, reputation_checked_at,
            is_vpn, is_proxy, is_datacenter, is_abuser, is_tor,
            last_user_agent, is_bot, bot_reason,
            claimed_user_id, claimed_at
       FROM ip_profiles
      WHERE hash = ?`,
    [normalized],
  );

  if (!profile?.ip) {
    return null;
  }

  const [
    viewStats,
    likeStats,
    commentStats,
    submissionStats,
    submissionBreakdown,
    recentComments,
    recentLikes,
    recentViews,
    recentSubmissions,
    activeBans,
  ] = await Promise.all([
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
    getActiveBans(profile.ip),
  ]);

  const submissionsByStatus = submissionBreakdown.reduce(
    (acc, row) => ({
      ...acc,
      [row.status]: Number(row.total || 0),
    }),
    {},
  );

  const numericClaimedUserId = Number.parseInt(profile.claimed_user_id, 10);
  const claimInfo = {
    claimed: Number.isInteger(numericClaimedUserId),
    userId: Number.isInteger(numericClaimedUserId) ? numericClaimedUserId : null,
    claimedAt: profile.claimed_at || null,
  };

  return {
    id: profile.snowflake_id || null,
    legacyId: profile.id || null,
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
    bot: {
      isBot: Boolean(profile.is_bot),
      reason: profile.bot_reason || null,
      userAgent: profile.last_user_agent || null,
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
    bans: Array.isArray(activeBans)
      ? activeBans.map((ban) => ({
          id: ban.snowflake_id,
          scope: ban.scope,
          value: ban.value,
          reason: ban.reason || null,
          createdAt: ban.created_at,
        }))
      : [],
    claim: claimInfo,
    isClaimed: claimInfo.claimed,
  };
}

export async function getIpProfileClaim(hash) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return null;
  }
  const row = await get(
    `SELECT claimed_user_id, claimed_at FROM ip_profiles WHERE hash = ?`,
    [normalized],
  );
  if (!row) {
    return null;
  }
  const numericUserId = Number.parseInt(row.claimed_user_id, 10);
  return {
    claimed: Number.isInteger(numericUserId),
    userId: Number.isInteger(numericUserId) ? numericUserId : null,
    claimedAt: row.claimed_at || null,
  };
}

export async function claimIpProfile(hash, userId) {
  const normalizedHash = normalizeIp(hash);
  if (!normalizedHash) {
    return { updated: false };
  }
  const numericUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericUserId)) {
    throw new Error("Identifiant utilisateur invalide pour l'association du profil IP.");
  }
  const result = await run(
    `UPDATE ip_profiles
        SET claimed_user_id=?, claimed_at=CURRENT_TIMESTAMP
      WHERE hash=? AND claimed_user_id IS NULL`,
    [numericUserId, normalizedHash],
  );
  return { updated: Boolean(result?.changes) };
}

export async function linkIpProfileToUser(hash, userId, { force = false } = {}) {
  const normalizedHash = normalizeIp(hash);
  if (!normalizedHash) {
    return { updated: false, reason: "invalid" };
  }
  const numericUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericUserId)) {
    throw new Error("Identifiant utilisateur invalide pour l'association du profil IP.");
  }
  const existing = await get(
    `SELECT claimed_user_id FROM ip_profiles WHERE hash = ?`,
    [normalizedHash],
  );
  if (!existing) {
    return { updated: false, reason: "not_found" };
  }
  const currentClaimedId = Number.parseInt(existing.claimed_user_id, 10);
  if (Number.isInteger(currentClaimedId)) {
    if (currentClaimedId === numericUserId && !force) {
      return { updated: false, reason: "already_linked", previousUserId: currentClaimedId };
    }
    if (currentClaimedId !== numericUserId && !force) {
      return {
        updated: false,
        reason: "already_claimed",
        claimedUserId: currentClaimedId,
      };
    }
  }
  const result = await run(
    `UPDATE ip_profiles
        SET claimed_user_id=?, claimed_at=CURRENT_TIMESTAMP
      WHERE hash=?`,
    [numericUserId, normalizedHash],
  );
  return {
    updated: Boolean(result?.changes),
    previousUserId: Number.isInteger(currentClaimedId) ? currentClaimedId : null,
  };
}

export async function unlinkIpProfile(hash, { expectedUserId = null } = {}) {
  const normalizedHash = normalizeIp(hash);
  if (!normalizedHash) {
    return { updated: false, reason: "invalid" };
  }
  const existing = await get(
    `SELECT claimed_user_id FROM ip_profiles WHERE hash = ?`,
    [normalizedHash],
  );
  if (!existing) {
    return { updated: false, reason: "not_found" };
  }
  const currentClaimedId = Number.parseInt(existing.claimed_user_id, 10);
  const expectedId = Number.parseInt(expectedUserId, 10);
  if (
    Number.isInteger(expectedId) &&
    (!Number.isInteger(currentClaimedId) || currentClaimedId !== expectedId)
  ) {
    return {
      updated: false,
      reason: "mismatch",
      currentUserId: Number.isInteger(currentClaimedId) ? currentClaimedId : null,
    };
  }
  const params = Number.isInteger(expectedId)
    ? [normalizedHash, expectedId]
    : [normalizedHash];
  const result = await run(
    `UPDATE ip_profiles
        SET claimed_user_id=NULL,
            claimed_at=NULL
      WHERE hash=?${Number.isInteger(expectedId) ? " AND claimed_user_id=?" : ""}`,
    params,
  );
  return {
    updated: Boolean(result?.changes),
    previousUserId: Number.isInteger(currentClaimedId) ? currentClaimedId : null,
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
        ipr.snowflake_id,
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
        ipr.last_user_agent,
        ipr.is_bot,
        ipr.bot_reason,
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
    id: row.snowflake_id || null,
    legacyId: row.id || null,
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
    bot: {
      isBot: Boolean(row.is_bot),
      reason: row.bot_reason || null,
      userAgent: row.last_user_agent || null,
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
  return get(`SELECT * FROM ip_profiles WHERE hash = ?`, [normalized]);
}

export async function deleteIpProfileByHash(hash) {
  const normalized = normalizeIp(hash);
  if (!normalized) {
    return null;
  }

  const profile = await get(
    `SELECT id, hash, ip FROM ip_profiles WHERE hash = ?`,
    [normalized],
  );
  if (!profile?.id) {
    return null;
  }

  await run(`DELETE FROM ip_profiles WHERE id = ?`, [profile.id]);

  return { hash: profile.hash, ip: profile.ip };
}

export async function refreshIpReputationByHash(hash, { force = false } = {}) {
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.ip) {
    return null;
  }
  return refreshIpReputation(profile.ip, { force });
}

export async function countIpProfilesForReview() {
  const row = await get(
    `SELECT COUNT(*) AS total
       FROM ip_profiles
      WHERE reputation_auto_status='suspicious'
        AND (reputation_override IS NULL OR reputation_override NOT IN ('safe','banned'))`,
  );
  return Number(row?.total ?? 0);
}

export async function listIpProfilesForReview({ limit = 50, offset = 0 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const rows = await all(
    `SELECT snowflake_id, hash, ip, created_at, last_seen_at, reputation_summary, reputation_checked_at,
            reputation_status, reputation_auto_status, reputation_override,
            is_vpn, is_proxy, is_tor, is_datacenter, is_abuser,
            last_user_agent, is_bot, bot_reason
       FROM ip_profiles
      WHERE reputation_auto_status='suspicious'
        AND (reputation_override IS NULL OR reputation_override NOT IN ('safe','banned'))
      ORDER BY COALESCE(reputation_checked_at, last_seen_at, created_at) DESC
      LIMIT ? OFFSET ?`,
    [safeLimit, safeOffset],
  );
  return rows.map((row) => ({
    id: row.snowflake_id || null,
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
    bot: {
      isBot: Boolean(row.is_bot),
      reason: row.bot_reason || null,
      userAgent: row.last_user_agent || null,
    },
  }));
}

export async function countIpReputationHistoryEntries() {
  const row = await get(
    `SELECT COUNT(*) AS total
       FROM ip_profiles
      WHERE reputation_checked_at IS NOT NULL`,
  );
  return Number(row?.total ?? 0);
}

export async function fetchRecentIpReputationChecks({
  limit = 20,
  offset = 0,
} = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const rows = await all(
    `SELECT snowflake_id, hash, ip, reputation_status, reputation_auto_status, reputation_override,
            reputation_summary, reputation_checked_at, last_seen_at,
            last_user_agent, is_bot, bot_reason
       FROM ip_profiles
      WHERE reputation_checked_at IS NOT NULL
      ORDER BY reputation_checked_at DESC
      LIMIT ? OFFSET ?`,
    [safeLimit, safeOffset],
  );

  return rows.map((row) => ({
    id: row.snowflake_id || null,
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    status: row.reputation_status || "unknown",
    autoStatus: row.reputation_auto_status || "unknown",
    override: normalizeOverride(row.reputation_override),
    summary: row.reputation_summary || null,
    checkedAt: row.reputation_checked_at || null,
    lastSeenAt: row.last_seen_at || null,
    bot: {
      isBot: Boolean(row.is_bot),
      reason: row.bot_reason || null,
      userAgent: row.last_user_agent || null,
    },
  }));
}

export async function countClearedIpProfiles() {
  const row = await get(
    `SELECT COUNT(*) AS total
       FROM ip_profiles
      WHERE reputation_override='safe'`,
  );
  return Number(row?.total ?? 0);
}

export async function fetchRecentlyClearedProfiles({
  limit = 10,
  offset = 0,
} = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const rows = await all(
    `SELECT snowflake_id, hash, ip, created_at, last_seen_at, reputation_summary, reputation_checked_at,
            reputation_status, reputation_auto_status, last_user_agent, is_bot, bot_reason
       FROM ip_profiles
      WHERE reputation_override='safe'
      ORDER BY COALESCE(reputation_checked_at, last_seen_at, created_at) DESC
      LIMIT ? OFFSET ?`,
    [safeLimit, safeOffset],
  );
  return rows.map((row) => ({
    id: row.snowflake_id || null,
    hash: row.hash,
    shortHash: formatIpProfileLabel(row.hash),
    ip: row.ip,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    checkedAt: row.reputation_checked_at,
    summary: row.reputation_summary || null,
    status: row.reputation_status || "safe",
    autoStatus: row.reputation_auto_status || "clean",
    bot: {
      isBot: Boolean(row.is_bot),
      reason: row.bot_reason || null,
      userAgent: row.last_user_agent || null,
    },
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
