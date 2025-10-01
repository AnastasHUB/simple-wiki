import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import {
  DEFAULT_ROLE_FLAGS,
  ROLE_FLAG_FIELDS,
  getRoleFlagValues,
  mergeRoleFlags,
} from "./roleFlags.js";

const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_SELECT_FIELDS = `id, snowflake_id, name, description, is_system, position, ${ROLE_FLAG_COLUMN_LIST}, created_at, updated_at`;
const ROLE_UPDATE_ASSIGNMENTS = ROLE_FLAG_FIELDS.map((field) => `${field}=?`).join(", ");
const EVERYONE_ROLE_NAME = "Everyone";

let cachedEveryoneRole = null;
let cachedEveryoneFetchedAt = 0;
const EVERYONE_CACHE_TTL_MS = 60 * 1000;

export function invalidateRoleCache() {
  cachedEveryoneRole = null;
  cachedEveryoneFetchedAt = 0;
}

function normalizeBoolean(value) {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "1" || lower === "true" || lower === "on";
  }
  return Boolean(value);
}

function normalizePermissions(raw = {}) {
  const normalized = { ...DEFAULT_ROLE_FLAGS };
  for (const field of ROLE_FLAG_FIELDS) {
    normalized[field] = normalizeBoolean(raw[field]);
  }
  return normalized;
}

function mapRoleRow(row) {
  if (!row) {
    return null;
  }
  const normalizedFlags = {};
  for (const field of ROLE_FLAG_FIELDS) {
    normalizedFlags[field] = Boolean(row[field]);
  }
  return {
    ...row,
    is_system: Boolean(row.is_system),
    position: Number.parseInt(row.position, 10) || 0,
    ...normalizedFlags,
  };
}

export async function listRoles() {
  const rows = await all(
    `SELECT ${ROLE_SELECT_FIELDS}
     FROM roles
     ORDER BY position ASC, name COLLATE NOCASE`,
  );
  return rows.map(mapRoleRow);
}

export async function listRolesWithUsage() {
  const roles = await listRoles();
  const usage = await all(
    "SELECT role_id, COUNT(*) AS total FROM users WHERE role_id IS NOT NULL GROUP BY role_id",
  );
  const usageMap = new Map(
    usage.map((row) => [row.role_id, Number(row.total) || 0]),
  );
  return roles.map((role) => ({
    ...role,
    userCount: usageMap.get(role.id) || 0,
  }));
}

export async function countUsersWithRole(roleId) {
  if (!roleId) {
    return 0;
  }
  const row = await get("SELECT COUNT(*) AS total FROM users WHERE role_id=?", [
    roleId,
  ]);
  return Number(row?.total ?? 0);
}

export async function getRoleById(roleId) {
  if (!roleId) return null;
  const row = await get(
    `SELECT ${ROLE_SELECT_FIELDS}
     FROM roles
     WHERE id=?`,
    [roleId],
  );
  return mapRoleRow(row);
}

export async function getRoleByName(name) {
  if (!name) return null;
  const row = await get(
    `SELECT ${ROLE_SELECT_FIELDS}
     FROM roles
     WHERE name=? COLLATE NOCASE`,
    [name],
  );
  return mapRoleRow(row);
}

export async function createRole({ name, description = "", permissions = {} }) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) {
    throw new Error("Nom de rôle requis");
  }
  const trimmedDescription = description ? description.trim() : null;
  const perms = normalizePermissions(permissions);
  const row = await get("SELECT MAX(position) AS maxPosition FROM roles");
  const nextPosition = Number.parseInt(row?.maxPosition, 10) || 0;
  const result = await run(
    `INSERT INTO roles(snowflake_id, name, description, is_system, position, ${ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?,?,?${",?".repeat(
      ROLE_FLAG_FIELDS.length,
    )})`,
    [
      generateSnowflake(),
      trimmedName,
      trimmedDescription,
      0,
      nextPosition + 1,
      ...getRoleFlagValues(perms),
    ],
  );
  invalidateRoleCache();
  return getRoleById(result.lastID);
}

export async function updateRoleOrdering(roleIds = []) {
  const allRoles = await all(
    "SELECT id FROM roles ORDER BY position ASC, name COLLATE NOCASE",
  );
  if (!allRoles.length) {
    return { changed: false, order: [] };
  }
  const currentOrder = allRoles.map((role) => role.id);
  const currentSet = new Set(currentOrder);
  const seen = new Set();
  const finalOrder = [];
  for (const rawId of Array.isArray(roleIds) ? roleIds : []) {
    const numericId = Number.parseInt(rawId, 10);
    if (!Number.isInteger(numericId) || numericId < 1) {
      continue;
    }
    if (seen.has(numericId)) {
      continue;
    }
    if (!currentSet.has(numericId)) {
      continue;
    }
    finalOrder.push(numericId);
    seen.add(numericId);
  }
  for (const id of currentOrder) {
    if (!seen.has(id)) {
      finalOrder.push(id);
    }
  }
  const changed =
    finalOrder.length !== currentOrder.length ||
    finalOrder.some((id, index) => id !== currentOrder[index]);
  if (!changed) {
    return { changed: false, order: currentOrder };
  }
  for (let index = 0; index < finalOrder.length; index += 1) {
    const roleId = finalOrder[index];
    await run(
      `UPDATE roles SET position=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [index + 1, roleId],
    );
  }
  invalidateRoleCache();
  return { changed: true, order: finalOrder };
}

export async function updateRolePermissions(roleId, { permissions = {} }) {
  const role = await getRoleById(roleId);
  if (!role) {
    return null;
  }
  const perms = normalizePermissions(permissions);
  const flagValues = getRoleFlagValues(perms);
  await run(
    `UPDATE roles SET ${ROLE_UPDATE_ASSIGNMENTS}, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [...flagValues, roleId],
  );
  await run(
    `UPDATE users SET ${ROLE_UPDATE_ASSIGNMENTS} WHERE role_id=?`,
    [...flagValues, roleId],
  );
  invalidateRoleCache();
  return getRoleById(roleId);
}

export async function assignRoleToUser(userId, role) {
  if (!userId) return null;
  const targetRole =
    typeof role === "object" && role !== null ? role : await getRoleById(role);
  if (!targetRole) {
    return null;
  }
  const mergedFlags = mergeRoleFlags(DEFAULT_ROLE_FLAGS, targetRole);
  await run(
    `UPDATE users SET role_id=?, ${ROLE_UPDATE_ASSIGNMENTS} WHERE id=?`,
    [targetRole.id, ...getRoleFlagValues(mergedFlags), userId],
  );
  return targetRole;
}

export async function reassignUsersToRole(sourceRoleId, targetRole) {
  if (!sourceRoleId) {
    return { targetRole: null, moved: 0 };
  }
  const destination =
    typeof targetRole === "object" && targetRole !== null
      ? targetRole
      : await getRoleById(targetRole);
  if (!destination) {
    throw new Error("Rôle de destination introuvable.");
  }
  if (destination.id === sourceRoleId) {
    return { targetRole: destination, moved: 0 };
  }
  const usersToMove = await countUsersWithRole(sourceRoleId);
  if (usersToMove === 0) {
    return { targetRole: destination, moved: 0 };
  }
  const mergedFlags = mergeRoleFlags(DEFAULT_ROLE_FLAGS, destination);
  await run(
    `UPDATE users SET role_id=?, ${ROLE_UPDATE_ASSIGNMENTS} WHERE role_id=?`,
    [destination.id, ...getRoleFlagValues(mergedFlags), sourceRoleId],
  );
  return { targetRole: destination, moved: usersToMove };
}

export async function deleteRole(roleId) {
  if (!roleId) return false;
  const role = await getRoleById(roleId);
  if (!role) {
    return false;
  }
  if (
    role.is_system ||
    role.name?.toLowerCase() === EVERYONE_ROLE_NAME.toLowerCase()
  ) {
    throw new Error("Impossible de supprimer ce rôle système.");
  }
  const usage = await countUsersWithRole(roleId);
  if (usage > 0) {
    throw new Error(
      "Impossible de supprimer un rôle attribué à des utilisateurs. Réassignez d'abord ces utilisateurs.",
    );
  }
  await run("DELETE FROM roles WHERE id=?", [roleId]);
  invalidateRoleCache();
  return true;
}

export async function getEveryoneRole({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedEveryoneRole &&
    now - cachedEveryoneFetchedAt < EVERYONE_CACHE_TTL_MS
  ) {
    return cachedEveryoneRole;
  }
  const row = await get(
    `SELECT ${ROLE_SELECT_FIELDS} FROM roles WHERE name=? COLLATE NOCASE LIMIT 1`,
    [EVERYONE_ROLE_NAME],
  );
  cachedEveryoneRole = mapRoleRow(row);
  cachedEveryoneFetchedAt = now;
  return cachedEveryoneRole;
}
