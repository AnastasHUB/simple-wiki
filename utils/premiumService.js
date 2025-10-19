import { randomBytes } from "crypto";
import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { PREMIUM_ROLE_SNOWFLAKE } from "./defaultRoles.js";
import { addRoleToUser, getRoleById, removeRoleFromUser } from "./roleService.js";

const CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DURATION_MS = 1000 * 60 * 60 * 24 * 365 * 5; // 5 ans

let cachedPremiumRole = null;

export class PremiumCodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PremiumCodeError";
    this.code = code;
  }
}

function normalizeCode(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 64);
}

export function generatePremiumCodeValue(length = 12) {
  const safeLength = Number.isInteger(length) && length > 0 && length <= 64 ? length : 12;
  const bytes = randomBytes(safeLength);
  let result = "";
  for (let i = 0; i < safeLength; i += 1) {
    const index = bytes[i] % CODE_CHARSET.length;
    result += CODE_CHARSET.charAt(index);
  }
  return result;
}

function mapPremiumCodeRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.snowflake_id || String(row.id),
    numericId: Number.parseInt(row.id, 10) || null,
    code: row.code,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    createdBy: Number.parseInt(row.created_by, 10) || null,
    premiumDurationSeconds: Number.parseInt(row.premium_duration_seconds, 10) || 0,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at) : null,
    redeemedBy: Number.parseInt(row.redeemed_by, 10) || null,
  };
}

async function getPremiumRole() {
  if (cachedPremiumRole) {
    return cachedPremiumRole;
  }
  const role = await getRoleById(PREMIUM_ROLE_SNOWFLAKE);
  if (!role?.numeric_id) {
    throw new PremiumCodeError(
      "missing_role",
      "Le rôle premium par défaut est introuvable. Vérifiez la configuration des rôles.",
    );
  }
  cachedPremiumRole = role;
  return role;
}

export async function listPremiumCodes() {
  const rows = await all(
    `SELECT pc.*, creator.username AS creator_username, redeemer.username AS redeemer_username
       FROM premium_codes pc
       LEFT JOIN users creator ON creator.id = pc.created_by
       LEFT JOIN users redeemer ON redeemer.id = pc.redeemed_by
      ORDER BY pc.created_at DESC, pc.id DESC`,
  );
  return rows
    .map((row) => {
      const mapped = mapPremiumCodeRow(row);
      if (!mapped) {
        return null;
      }
      return {
        ...mapped,
        creatorUsername: row.creator_username || null,
        redeemerUsername: row.redeemer_username || null,
      };
    })
    .filter(Boolean);
}

export async function getPremiumCodeByValue(codeValue) {
  const normalized = normalizeCode(codeValue);
  if (!normalized) {
    return null;
  }
  const row = await get(
    `SELECT pc.*,
            creator.username AS creator_username,
            redeemer.username AS redeemer_username
       FROM premium_codes pc
       LEFT JOIN users creator ON creator.id = pc.created_by
       LEFT JOIN users redeemer ON redeemer.id = pc.redeemed_by
      WHERE pc.code=?`,
    [normalized],
  );
  if (!row) {
    return null;
  }
  const mapped = mapPremiumCodeRow(row);
  if (!mapped) {
    return null;
  }
  return {
    ...mapped,
    creatorUsername: row.creator_username || null,
    redeemerUsername: row.redeemer_username || null,
  };
}

export async function createPremiumCode({
  code: requestedCode,
  expiresAt,
  premiumDurationMs,
  createdBy,
}) {
  const trimmed = normalizeCode(requestedCode);
  const code = trimmed || generatePremiumCodeValue();
  if (!premiumDurationMs || premiumDurationMs <= 0) {
    throw new PremiumCodeError("invalid_duration", "La durée premium doit être positive.");
  }
  if (premiumDurationMs > MAX_DURATION_MS) {
    throw new PremiumCodeError(
      "duration_too_long",
      "La durée premium est trop longue (maximum 5 ans).",
    );
  }
  const durationSeconds = Math.max(1, Math.round(premiumDurationMs / 1000));
  const existing = await get("SELECT 1 FROM premium_codes WHERE code=?", [code]);
  if (existing) {
    throw new PremiumCodeError(
      "duplicate_code",
      "Ce code est déjà utilisé. Choisissez-en un autre ou laissez la génération automatique.",
    );
  }
  const expiresValue = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())
    ? expiresAt.toISOString()
    : null;
  await run(
    `INSERT INTO premium_codes(snowflake_id, code, created_by, premium_duration_seconds, expires_at)
     VALUES(?,?,?,?,?)`,
    [
      generateSnowflake(),
      code,
      Number.isInteger(createdBy) ? createdBy : null,
      durationSeconds,
      expiresValue,
    ],
  );
  return getPremiumCodeByValue(code);
}

export async function deletePremiumCode(codeIdentifier) {
  if (!codeIdentifier) {
    return null;
  }
  const row = await get(
    `SELECT * FROM premium_codes WHERE snowflake_id=? OR code=?`,
    [codeIdentifier, normalizeCode(codeIdentifier)],
  );
  if (!row) {
    return null;
  }
  if (row.redeemed_at) {
    throw new PremiumCodeError(
      "already_redeemed",
      "Ce code a déjà été utilisé et ne peut plus être supprimé.",
    );
  }
  await run("DELETE FROM premium_codes WHERE id=?", [row.id]);
  return mapPremiumCodeRow(row);
}

async function fetchUserPremiumState(userId) {
  const row = await get(
    `SELECT id, premium_expires_at, premium_via_code
       FROM users
      WHERE id=?`,
    [userId],
  );
  if (!row) {
    return null;
  }
  const expiresAt = row.premium_expires_at ? new Date(row.premium_expires_at) : null;
  return {
    id: row.id,
    expiresAt,
    premiumViaCode: row.premium_via_code === 1,
  };
}

async function userHasPremiumRole(userId, roleId) {
  if (!userId || !roleId) {
    return false;
  }
  const row = await get(
    `SELECT 1 FROM user_role_assignments WHERE user_id=? AND role_id=?`,
    [userId, roleId],
  );
  return Boolean(row);
}

export async function redeemPremiumCodeForUser({ code: rawCode, userId }) {
  const normalized = normalizeCode(rawCode);
  if (!normalized) {
    throw new PremiumCodeError("invalid_code", "Le code indiqué est invalide.");
  }
  const code = await getPremiumCodeByValue(normalized);
  if (!code) {
    throw new PremiumCodeError("unknown_code", "Ce code n'existe pas ou a été supprimé.");
  }
  if (code.redeemedAt) {
    throw new PremiumCodeError("already_used", "Ce code a déjà été utilisé.");
  }
  if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) {
    throw new PremiumCodeError("expired_code", "Ce code a expiré.");
  }
  const role = await getPremiumRole();
  const state = await fetchUserPremiumState(userId);
  if (!state) {
    throw new PremiumCodeError("unknown_user", "Utilisateur introuvable.");
  }
  const now = Date.now();
  const currentExpiry = state.expiresAt?.getTime() || 0;
  const base = currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(base + code.premiumDurationSeconds * 1000);
  await run(
    `UPDATE premium_codes
        SET redeemed_by=?, redeemed_at=CURRENT_TIMESTAMP
      WHERE id=?`,
    [userId, code.numericId],
  );
  await run(
    `UPDATE users
        SET premium_expires_at=?, premium_via_code=1
      WHERE id=?`,
    [newExpiry.toISOString(), userId],
  );
  const hasRole = await userHasPremiumRole(userId, role.numeric_id);
  if (!hasRole) {
    await addRoleToUser(userId, role);
  }
  return {
    code,
    expiresAt: newExpiry,
  };
}

export async function getPremiumStatusForUser(userId) {
  const state = await fetchUserPremiumState(userId);
  if (!state) {
    return { expiresAt: null, isActive: false, premiumViaCode: false };
  }
  const expiresAt = state.expiresAt;
  const now = Date.now();
  const isActive = Boolean(expiresAt && expiresAt.getTime() > now);
  return {
    expiresAt,
    isActive,
    premiumViaCode: state.premiumViaCode,
  };
}

export async function reconcileUserPremiumStatus(userId) {
  const role = await getPremiumRole();
  const state = await fetchUserPremiumState(userId);
  if (!state) {
    return { shouldRefreshSession: false, premiumExpiresAt: null, premiumViaCode: false };
  }
  const hasRole = await userHasPremiumRole(userId, role.numeric_id);
  const expiresAtMs = state.expiresAt?.getTime() || 0;
  const now = Date.now();
  const isActive = expiresAtMs > now;
  let shouldRefresh = false;
  if (state.premiumViaCode) {
    if (isActive) {
      if (!hasRole) {
        await addRoleToUser(userId, role);
        shouldRefresh = true;
      }
    } else {
      if (hasRole) {
        await removeRoleFromUser(userId, role.numeric_id);
        shouldRefresh = true;
      }
      await run(
        `UPDATE users
            SET premium_via_code=0
          WHERE id=?`,
        [userId],
      );
      return {
        shouldRefreshSession: shouldRefresh,
        premiumExpiresAt: state.expiresAt,
        premiumViaCode: false,
      };
    }
  } else if (isActive && !hasRole) {
    // Premium actif sans rôle associé : synchroniser sans marquer le flag via code.
    await addRoleToUser(userId, role);
    shouldRefresh = true;
  }
  return {
    shouldRefreshSession: shouldRefresh,
    premiumExpiresAt: state.expiresAt,
    premiumViaCode: state.premiumViaCode,
  };
}
