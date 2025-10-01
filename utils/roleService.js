import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import {
  DEFAULT_ROLE_FLAGS,
  ROLE_FLAG_FIELDS,
  getRoleFlagValues,
  mergeRoleFlags,
} from "./roleFlags.js";
import {
  buildRoleColorPresentation,
  parseStoredRoleColor,
  serializeRoleColorScheme,
} from "./roleColors.js";

const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_SELECT_FIELDS = `id, snowflake_id, name, description, color, is_system, position, ${ROLE_FLAG_COLUMN_LIST}, created_at, updated_at`;
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

function resolveSnowflake(row) {
  if (row?.snowflake_id) {
    return row.snowflake_id;
  }
  if (row?.id) {
    return String(row.id);
  }
  return null;
}

function mapRoleRow(row) {
  if (!row) {
    return null;
  }
  const numericId = Number.parseInt(row.id, 10) || null;
  const snowflakeId = resolveSnowflake(row);
  const colorSerialized = typeof row.color === "string" ? row.color : null;
  const colorScheme = parseStoredRoleColor(colorSerialized);
  const colorPresentation = buildRoleColorPresentation(colorScheme);
  const normalizedFlags = {};
  for (const field of ROLE_FLAG_FIELDS) {
    normalizedFlags[field] = Boolean(row[field]);
  }
  return {
    id: snowflakeId,
    numeric_id: numericId,
    snowflake_id: snowflakeId,
    name: row.name,
    description: row.description,
    color: colorScheme,
    colorPresentation,
    colorSerialized,
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
    usage.map((row) => [Number.parseInt(row.role_id, 10) || null, Number(row.total) || 0]),
  );
  return roles.map((role) => ({
    ...role,
    userCount: usageMap.get(role.numeric_id || null) || 0,
  }));
}

export async function countUsersWithRole(roleId) {
  const role = await getRoleById(roleId);
  if (!role?.numeric_id) {
    return 0;
  }
  const row = await get("SELECT COUNT(*) AS total FROM users WHERE role_id=?", [
    role.numeric_id,
  ]);
  return Number(row?.total ?? 0);
}

export async function getRoleById(roleId) {
  if (!roleId) return null;
  if (typeof roleId === "string") {
    const trimmed = roleId.trim();
    if (!trimmed) {
      return null;
    }
    let row = await get(
      `SELECT ${ROLE_SELECT_FIELDS}
       FROM roles
       WHERE snowflake_id=?`,
      [trimmed],
    );
    if (row) {
      return mapRoleRow(row);
    }
    const numericId = Number.parseInt(trimmed, 10);
    if (Number.isInteger(numericId)) {
      row = await get(
        `SELECT ${ROLE_SELECT_FIELDS}
         FROM roles
         WHERE id=?`,
        [numericId],
      );
      return mapRoleRow(row);
    }
    return null;
  }
  if (typeof roleId === "number") {
    const row = await get(
      `SELECT ${ROLE_SELECT_FIELDS}
       FROM roles
       WHERE id=?`,
      [roleId],
    );
    return mapRoleRow(row);
  }
  return null;
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

export async function createRole({
  name,
  description = "",
  color = null,
  permissions = {},
}) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) {
    throw new Error("Nom de rôle requis");
  }
  const trimmedDescription = description ? description.trim() : null;
  const serializedColor = serializeRoleColorScheme(color);
  const perms = normalizePermissions(permissions);
  const row = await get("SELECT MAX(position) AS maxPosition FROM roles");
  const nextPosition = Number.parseInt(row?.maxPosition, 10) || 0;
  const result = await run(
    `INSERT INTO roles(snowflake_id, name, description, color, is_system, position, ${ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?,?,?,?${",?".repeat(
      ROLE_FLAG_FIELDS.length,
    )})`,
    [
      generateSnowflake(),
      trimmedName,
      trimmedDescription,
      serializedColor,
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
    "SELECT id, snowflake_id FROM roles ORDER BY position ASC, name COLLATE NOCASE",
  );
  if (!allRoles.length) {
    return { changed: false, order: [] };
  }
  const idBySnowflake = new Map(
    allRoles.map((role) => [resolveSnowflake(role), role.id]),
  );
  const snowflakeById = new Map(
    allRoles.map((role) => [role.id, resolveSnowflake(role)]),
  );
  const currentOrder = allRoles.map((role) => role.id);
  const currentSet = new Set(currentOrder);
  const seen = new Set();
  const finalOrder = [];
  for (const rawId of Array.isArray(roleIds) ? roleIds : []) {
    const snowflakeId = typeof rawId === "string" ? rawId.trim() : String(rawId);
    if (!snowflakeId) {
      continue;
    }
    const numericId = idBySnowflake.get(snowflakeId);
    if (!numericId) {
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
  const orderSnowflakes = finalOrder.map((id) => snowflakeById.get(id));
  return { changed: true, order: orderSnowflakes };
}

export async function updateRolePermissions(roleId, { permissions = {}, color }) {
  const role = await getRoleById(roleId);
  if (!role) {
    return null;
  }
  const serializedColor =
    color === undefined ? role.colorSerialized : serializeRoleColorScheme(color);
  const perms = normalizePermissions(permissions);
  const flagValues = getRoleFlagValues(perms);
  await run(
    `UPDATE roles SET ${ROLE_UPDATE_ASSIGNMENTS}, color=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [...flagValues, serializedColor, role.numeric_id],
  );
  await run(
    `UPDATE users SET ${ROLE_UPDATE_ASSIGNMENTS} WHERE role_id=?`,
    [...flagValues, role.numeric_id],
  );
  invalidateRoleCache();
  return getRoleById(role.id || role.numeric_id);
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
    [targetRole.numeric_id, ...getRoleFlagValues(mergedFlags), userId],
  );
  return targetRole;
}

export async function reassignUsersToRole(sourceRoleId, targetRole) {
  const sourceRole = await getRoleById(sourceRoleId);
  if (!sourceRole?.numeric_id) {
    return { targetRole: null, moved: 0 };
  }
  const destination =
    typeof targetRole === "object" && targetRole !== null
      ? targetRole
      : await getRoleById(targetRole);
  if (!destination) {
    throw new Error("Rôle de destination introuvable.");
  }
  if (destination.numeric_id === sourceRole.numeric_id) {
    return { targetRole: destination, moved: 0 };
  }
  const usersToMove = await countUsersWithRole(sourceRole.numeric_id);
  if (usersToMove === 0) {
    return { targetRole: destination, moved: 0 };
  }
  const mergedFlags = mergeRoleFlags(DEFAULT_ROLE_FLAGS, destination);
  await run(
    `UPDATE users SET role_id=?, ${ROLE_UPDATE_ASSIGNMENTS} WHERE role_id=?`,
    [
      destination.numeric_id,
      ...getRoleFlagValues(mergedFlags),
      sourceRole.numeric_id,
    ],
  );
  return { targetRole: destination, moved: usersToMove };
}

export async function deleteRole(roleId) {
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
  const usage = await countUsersWithRole(role.numeric_id);
  if (usage > 0) {
    throw new Error(
      "Impossible de supprimer un rôle attribué à des utilisateurs. Réassignez d'abord ces utilisateurs.",
    );
  }
  await run("DELETE FROM roles WHERE id=?", [role.numeric_id]);
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
