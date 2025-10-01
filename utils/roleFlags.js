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

export function buildSessionUser(rawUser, overrides = null) {
  const baseFlags = deriveRoleFlags(rawUser);
  const mergedFlags = overrides
    ? mergeRoleFlags(baseFlags, overrides)
    : baseFlags;
  const numericRoleId =
    typeof rawUser.role_numeric_id === "number"
      ? rawUser.role_numeric_id
      : typeof rawUser.role_id === "number"
        ? rawUser.role_id
        : null;
  const snowflakeRoleId =
    rawUser.role_snowflake_id ||
    (typeof rawUser.role_id === "string" ? rawUser.role_id : null) ||
    (numericRoleId !== null ? String(numericRoleId) : null);
  const rawColorValue =
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
    role_id: snowflakeRoleId,
    role_numeric_id: numericRoleId,
    role_name: rawUser.role_name || null,
    role_color: colorPresentation,
    role_color_scheme: colorScheme,
    role_color_serialized:
      typeof rawColorValue === "string" ? rawColorValue : colorScheme ? JSON.stringify(colorScheme) : null,
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
