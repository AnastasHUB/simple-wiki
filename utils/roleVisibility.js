import { EVERYONE_ROLE_SNOWFLAKE } from "./defaultRoles.js";

export function normalizeRoleSnowflake(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const text = String(value);
    return text.trim().length ? text.trim() : null;
  }
  if (typeof value === "object") {
    const candidate =
      value.snowflake_id ??
      value.snowflakeId ??
      value.id ??
      value.role_id ??
      value.roleId ??
      null;
    return normalizeRoleSnowflake(candidate);
  }
  return null;
}

export function normalizeRoleSelectionInput(input) {
  const values = Array.isArray(input)
    ? input
    : input === undefined || input === null
      ? []
      : [input];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeRoleSnowflake(value);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }
  return Array.from(seen);
}

export function collectAccessibleRoleSnowflakes(user, { includeEveryone = true } = {}) {
  const seen = new Set();
  if (includeEveryone && EVERYONE_ROLE_SNOWFLAKE) {
    seen.add(EVERYONE_ROLE_SNOWFLAKE);
  }
  if (!user || typeof user !== "object") {
    return Array.from(seen);
  }
  const add = (value) => {
    const normalized = normalizeRoleSnowflake(value);
    if (!normalized) {
      return;
    }
    seen.add(normalized);
  };
  add(user.role_id ?? user.roleId ?? null);
  add(user.role_snowflake_id ?? user.roleSnowflakeId ?? null);
  add(user.primary_role_snowflake ?? null);
  if (Array.isArray(user.roles)) {
    for (const role of user.roles) {
      add(role);
    }
  }
  if (Array.isArray(user.role_assignments)) {
    for (const assignment of user.role_assignments) {
      add(assignment);
    }
  }
  if (Array.isArray(user.assignedRoles)) {
    for (const assignment of user.assignedRoles) {
      add(assignment);
    }
  }
  return Array.from(seen);
}
