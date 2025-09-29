import fetch from "node-fetch";
import { get, run } from "../db.js";

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 heures
const MANUAL_OVERRIDE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const PROVIDER_NAME = "ip-api.com";
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /^::ffff:127\./,
];

function normalizeIp(ip) {
  if (typeof ip !== "string") {
    return "";
  }
  return ip.trim();
}

function parseDate(value) {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}

function isPrivateIp(ip) {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

async function loadProfile(ip) {
  return get(
    `SELECT id, reputation_status, reputation_checked_at, reputation_flagged_at,
            reputation_reviewed_at, reputation_reviewed_by
       FROM ip_profiles
      WHERE ip = ?`,
    [ip],
  );
}

async function performLookup(ip) {
  const url = `http://ip-api.com/json/${encodeURIComponent(
    ip,
  )}?fields=status,message,query,isp,org,as,proxy,hosting,mobile`;
  const response = await fetch(url, {
    headers: { "user-agent": "simple-wiki-ip-reputation" },
  });
  if (!response.ok) {
    throw new Error(`Réponse ${response.status}`);
  }
  return response.json();
}

function evaluateLookupResult(result) {
  if (!result || result.status !== "success") {
    return {
      status: "unknown",
      reason: result?.message || "Impossible d'obtenir des informations.",
      payload: result || null,
    };
  }

  const reasons = [];
  if (result.proxy) {
    reasons.push("Signalement proxy/VPN");
  }
  if (result.hosting) {
    reasons.push("Adresse appartenant à un hébergeur");
  }
  if (result.mobile) {
    reasons.push("Connexion mobile");
  }

  if (reasons.length) {
    return {
      status: "flagged",
      reason: reasons.join(" · "),
      payload: result,
    };
  }

  return {
    status: "safe",
    reason: "Aucune activité suspecte détectée par la vérification automatique.",
    payload: result,
  };
}

async function refreshIpReputation(ip, { force = false } = {}) {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return null;
  }

  const profile = await loadProfile(normalized);
  if (!profile?.id) {
    return null;
  }

  if (isPrivateIp(normalized)) {
    const checkedAt = new Date().toISOString();
    await run(
      `UPDATE ip_profiles
          SET reputation_status='safe',
              reputation_provider='local',
              reputation_reason='Adresse privée ou locale : vérification ignorée.',
              reputation_payload=NULL,
              reputation_checked_at=?,
              reputation_flagged_at=NULL
        WHERE id=?`,
      [checkedAt, profile.id],
    );
    return {
      id: profile.id,
      ip: normalized,
      status: "safe",
      reason: "Adresse privée ou locale : vérification ignorée.",
      provider: "local",
      checkedAt,
      flaggedAt: null,
    };
  }

  if (!force) {
    const lastChecked = parseDate(profile.reputation_checked_at);
    if (lastChecked && Date.now() - lastChecked < REFRESH_INTERVAL_MS) {
      return null;
    }

    if (profile.reputation_status === "safe" && profile.reputation_reviewed_at) {
      const lastReview = parseDate(profile.reputation_reviewed_at);
      if (lastReview && Date.now() - lastReview < MANUAL_OVERRIDE_TTL_MS) {
        return null;
      }
    }
  }

  let lookupResult = null;
  let evaluation = {
    status: profile.reputation_status || "unknown",
    reason: profile.reputation_status ? profile.reputation_status : "",
    payload: null,
  };

  try {
    lookupResult = await performLookup(normalized);
    evaluation = evaluateLookupResult(lookupResult);
  } catch (err) {
    evaluation = {
      status: profile.reputation_status === "flagged" ? "flagged" : "unknown",
      reason: `Échec de l'analyse automatique : ${err.message}`,
      payload: {
        error: err.message,
      },
    };
  }

  const checkedAt = new Date().toISOString();
  const flaggedAt =
    evaluation.status === "flagged"
      ? profile.reputation_flagged_at || checkedAt
      : null;
  const reviewedAt = evaluation.status === "safe" ? profile.reputation_reviewed_at : null;
  const reviewedBy = evaluation.status === "safe" ? profile.reputation_reviewed_by : null;

  await run(
    `UPDATE ip_profiles
        SET reputation_status=?,
            reputation_provider=?,
            reputation_reason=?,
            reputation_payload=?,
            reputation_checked_at=?,
            reputation_flagged_at=?,
            reputation_reviewed_at=?,
            reputation_reviewed_by=?
      WHERE id=?`,
    [
      evaluation.status,
      PROVIDER_NAME,
      evaluation.reason || null,
      JSON.stringify(evaluation.payload ?? lookupResult ?? null),
      checkedAt,
      flaggedAt,
      reviewedAt,
      reviewedBy,
      profile.id,
    ],
  );

  return {
    id: profile.id,
    ip: normalized,
    status: evaluation.status,
    reason: evaluation.reason,
    provider: PROVIDER_NAME,
    checkedAt,
    flaggedAt,
  };
}

export async function autoRefreshIpReputation(ip) {
  return refreshIpReputation(ip, { force: false });
}

export async function forceRefreshIpReputation(ip) {
  return refreshIpReputation(ip, { force: true });
}

