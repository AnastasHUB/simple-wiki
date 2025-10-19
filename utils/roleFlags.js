import { buildRoleColorPresentation, parseStoredRoleColor } from "./roleColors.js";
import {
  PERMISSION_DEPENDENCIES,
  getAllPermissionFields,
} from "./permissionDefinitions.js";

export const ROLE_FLAG_FIELDS = getAllPermissionFields();

export const ADMIN_ACTION_FLAGS = ROLE_FLAG_FIELDS.filter(
  (field) =>
    ![
      "is_admin",
      "is_moderator",
      "is_helper",
      "is_contributor",
      "can_comment",
      "can_submit_pages",
    ].includes(field),
);

export const DEFAULT_ROLE_FLAGS = ROLE_FLAG_FIELDS.reduce((acc, field) => {
  acc[field] = false;
  return acc;
}, {});

function normalizeFlagSet(raw = {}) {
  const normalized = { ...DEFAULT_ROLE_FLAGS };
  for (const field of ROLE_FLAG_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) {
      normalized[field] = Boolean(raw[field]);
    }
  }
  return normalized;
}

function applyRoleDerivations(flags) {
  const derived = { ...flags };

  if (derived.is_admin) {
    for (const field of ROLE_FLAG_FIELDS) {
      derived[field] = true;
    }
    return derived;
  }

  const queue = ROLE_FLAG_FIELDS.filter((field) => derived[field]);
  const visited = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const dependents = PERMISSION_DEPENDENCIES[current];
    if (!Array.isArray(dependents) || !dependents.length) {
      continue;
    }
    for (const dependent of dependents) {
      if (!dependent) {
        continue;
      }
      if (!derived[dependent]) {
        derived[dependent] = true;
        queue.push(dependent);
      }
    }
  }

  return derived;
}

export function mergeRoleFlags(base = DEFAULT_ROLE_FLAGS, overrides = {}) {
  const normalizedBase = normalizeFlagSet(base);
  const normalizedOverrides = normalizeFlagSet(overrides);
  const merged = { ...normalizedBase };
  for (const field of ROLE_FLAG_FIELDS) {
    if (normalizedOverrides[field]) {
      merged[field] = true;
    }
  }
  return applyRoleDerivations(merged);
}

export function deriveRoleFlags(rawUser = {}) {
  const baseFlags = normalizeFlagSet(rawUser);
  const roleOverrides = ROLE_FLAG_FIELDS.reduce((acc, key) => {
    const roleKey = `role_${key}`;
    if (rawUser[roleKey] !== undefined && rawUser[roleKey] !== null) {
      acc[key] = Boolean(rawUser[roleKey]);
    }
    return acc;
  }, {});
  return applyRoleDerivations(mergeRoleFlags(baseFlags, roleOverrides));
}

function normalizeAssignedRoles(rawUser = {}) {
  const roleList = Array.isArray(rawUser.roles)
    ? rawUser.roles
    : Array.isArray(rawUser.role_assignments)
      ? rawUser.role_assignments
      : [];
  return roleList
    .map((role) => (role && typeof role === "object" ? role : null))
    .filter(Boolean)
    .sort((a, b) => {
      const posA = Number.isFinite(a?.position) ? a.position : 0;
      const posB = Number.isFinite(b?.position) ? b.position : 0;
      if (posA !== posB) {
        return posA - posB;
      }
      const nameA = a?.name || "";
      const nameB = b?.name || "";
      return nameA.localeCompare(nameB, "fr", { sensitivity: "base" });
    });
}

export function buildSessionUser(rawUser, overrides = null) {
  const normalizedRoles = normalizeAssignedRoles(rawUser);
  const primaryRole = normalizedRoles[0] || null;
  const baseFlags = deriveRoleFlags(rawUser);
  const mergedFlags = overrides
    ? mergeRoleFlags(baseFlags, overrides)
    : baseFlags;
  const rawPremiumExpiry =
    rawUser.premium_expires_at ?? rawUser.premiumExpiresAt ?? rawUser.premium_expires_at_iso ?? null;
  const premiumExpiryDate =
    rawPremiumExpiry instanceof Date
      ? rawPremiumExpiry
      : rawPremiumExpiry
        ? new Date(rawPremiumExpiry)
        : null;
  const premiumExpiresAtIso =
    premiumExpiryDate && !Number.isNaN(premiumExpiryDate.getTime())
      ? premiumExpiryDate.toISOString()
      : null;
  const premiumViaCodeRaw =
    rawUser.premium_via_code ?? rawUser.premiumViaCode ?? rawUser.premium_via_code_flag ?? null;
  const premiumViaCode = premiumViaCodeRaw != null ? Boolean(premiumViaCodeRaw) : false;
  const premiumIsActive = premiumExpiresAtIso
    ? new Date(premiumExpiresAtIso).getTime() > Date.now()
    : false;
  const numericRoleId =
    primaryRole?.numeric_id ??
    (typeof rawUser.role_numeric_id === "number"
      ? rawUser.role_numeric_id
      : typeof rawUser.role_id === "number"
        ? rawUser.role_id
        : null);
  const snowflakeRoleId =
    primaryRole?.id ||
    rawUser.role_snowflake_id ||
    (typeof rawUser.role_id === "string" ? rawUser.role_id : null) ||
    (numericRoleId !== null ? String(numericRoleId) : null);
  const rawColorValue =
    primaryRole?.colorSerialized ||
    rawUser.role_color_serialized ||
    rawUser.colorSerialized ||
    rawUser.role_color ||
    rawUser.color ||
    null;
  const colorScheme = parseStoredRoleColor(rawColorValue);
  const colorPresentation = buildRoleColorPresentation(colorScheme);
  return {
    id: rawUser.id,
    username: rawUser.username,
    display_name: rawUser.display_name || null,
    avatar_url: rawUser.avatar_url || null,
    banner_url: rawUser.banner_url || null,
    bio: rawUser.bio || null,
    profile_show_badges:
      rawUser.profile_show_badges === undefined
        ? true
        : rawUser.profile_show_badges !== 0,
    profile_show_recent_pages:
      rawUser.profile_show_recent_pages === undefined
        ? true
        : rawUser.profile_show_recent_pages !== 0,
    profile_show_ip_profiles:
      rawUser.profile_show_ip_profiles !== undefined
        ? rawUser.profile_show_ip_profiles !== 0
        : false,
    profile_show_bio:
      rawUser.profile_show_bio === undefined ? true : rawUser.profile_show_bio !== 0,
    profile_show_stats:
      rawUser.profile_show_stats === undefined ? true : rawUser.profile_show_stats !== 0,
    is_banned: Boolean(rawUser.is_banned),
    banned_at: rawUser.banned_at || null,
    banned_by: rawUser.banned_by || null,
    ban_reason: rawUser.ban_reason || null,
    role_id: snowflakeRoleId,
    role_numeric_id: numericRoleId,
    role_name: primaryRole?.name || rawUser.role_name || null,
    role_color: colorPresentation,
    role_color_scheme: colorScheme,
    role_color_serialized:
      typeof rawColorValue === "string" ? rawColorValue : colorScheme ? JSON.stringify(colorScheme) : null,
    roles: normalizedRoles,
    premium_expires_at: premiumExpiresAtIso,
    premium_via_code: premiumViaCode,
    premium_is_active: premiumIsActive,
    ...mergedFlags,
  };
}

export function needsRoleFlagSync(rawUser) {
  if (!rawUser) return false;
  const flags = deriveRoleFlags(rawUser);
  return ROLE_FLAG_FIELDS.some((field) => {
    const currentValue = Boolean(rawUser[field]);
    return currentValue !== flags[field];
  });
}

export function getRoleFlagValues(flags = DEFAULT_ROLE_FLAGS) {
  const normalized = normalizeFlagSet(flags);
  return ROLE_FLAG_FIELDS.map((field) => (normalized[field] ? 1 : 0));
}

export function getRoleFlagPairs(flags = DEFAULT_ROLE_FLAGS) {
  const normalized = normalizeFlagSet(flags);
  return ROLE_FLAG_FIELDS.map((field) => [field, normalized[field] ? 1 : 0]);
}
