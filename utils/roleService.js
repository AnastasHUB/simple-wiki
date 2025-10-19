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
import {
  EVERYONE_ROLE_SNOWFLAKE,
  USER_ROLE_SNOWFLAKE,
  PREMIUM_ROLE_SNOWFLAKE,
  applyDefaultRoleMetadata,
} from "./defaultRoles.js";

const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_SELECT_FIELDS = `id, snowflake_id, name, description, color, is_system, position, ${ROLE_FLAG_COLUMN_LIST}, created_at, updated_at`;
const ROLE_UPDATE_ASSIGNMENTS = ROLE_FLAG_FIELDS.map((field) => `${field}=?`).join(", ");
const EVERYONE_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_ROLE_CACHE = new Map();

export function invalidateRoleCache() {
  DEFAULT_ROLE_CACHE.clear();
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
  const role = {
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
  return applyDefaultRoleMetadata(role);
}

async function getUserRoleRows(userId) {
  if (!userId) return [];
  return all(
    `SELECT ura.user_id, r.*
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
      WHERE ura.user_id=?
      ORDER BY r.position ASC, r.name COLLATE NOCASE`,
    [userId],
  );
}

function sortRolesByPriority(roles = []) {
  return [...roles].sort((a, b) => {
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

async function resolveRoleInputs(roleInput) {
  const inputs = Array.isArray(roleInput) ? roleInput : [roleInput];
  const seen = new Set();
  const resolved = [];
  for (const input of inputs) {
    if (!input) continue;
    let role = null;
    if (typeof input === "object" && input !== null) {
      role = input;
    } else {
      role = await getRoleById(input);
    }
    if (!role?.numeric_id || seen.has(role.numeric_id)) {
      continue;
    }
    seen.add(role.numeric_id);
    resolved.push(role);
  }
  return sortRolesByPriority(resolved);
}

async function refreshUserRoleState(userId, { ensureDefault = true } = {}) {
  if (!userId) {
    return [];
  }
  let roleRows = await getUserRoleRows(userId);
  if ((!roleRows || roleRows.length === 0) && ensureDefault) {
    const everyoneRole = await getEveryoneRole();
    if (everyoneRole?.numeric_id) {
      await run(
        "INSERT OR IGNORE INTO user_role_assignments(user_id, role_id) VALUES(?, ?)",
        [userId, everyoneRole.numeric_id],
      );
      roleRows = await getUserRoleRows(userId);
    }
  }
  const mappedRoles = sortRolesByPriority(roleRows.map(mapRoleRow).filter(Boolean));
  let mergedFlags = { ...DEFAULT_ROLE_FLAGS };
  for (const role of mappedRoles) {
    mergedFlags = mergeRoleFlags(mergedFlags, role);
  }
  const primaryRole = mappedRoles[0] || null;
  await run(
    `UPDATE users SET role_id=?, ${ROLE_UPDATE_ASSIGNMENTS} WHERE id=?`,
    [
      primaryRole?.numeric_id ?? null,
      ...getRoleFlagValues(mergedFlags),
      userId,
    ],
  );
  return mappedRoles;
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
    "SELECT role_id, COUNT(DISTINCT user_id) AS total FROM user_role_assignments GROUP BY role_id",
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
  const row = await get(
    "SELECT COUNT(DISTINCT user_id) AS total FROM user_role_assignments WHERE role_id=?",
    [role.numeric_id],
  );
  return Number(row?.total ?? 0);
}

export async function listRolesForUsers(userIds = []) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
  if (!ids.length) {
    return new Map();
  }
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await all(
    `SELECT ura.user_id, r.*
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
      WHERE ura.user_id IN (${placeholders})
      ORDER BY ura.user_id ASC, r.position ASC, r.name COLLATE NOCASE`,
    ids,
  );
  const result = new Map();
  for (const row of rows) {
    const userId = Number.parseInt(row.user_id, 10);
    if (!Number.isInteger(userId)) {
      continue;
    }
    const mapped = mapRoleRow(row);
    if (!mapped) {
      continue;
    }
    if (!result.has(userId)) {
      result.set(userId, []);
    }
    result.get(userId).push(mapped);
  }
  return result;
}

export async function getRolesForUser(userId) {
  const map = await listRolesForUsers([userId]);
  const numericId = Number.parseInt(userId, 10);
  if (Number.isInteger(numericId) && map.has(numericId)) {
    return map.get(numericId);
  }
  return [];
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
  const userRows = await all(
    "SELECT DISTINCT user_id FROM user_role_assignments WHERE role_id=?",
    [role.numeric_id],
  );
  for (const row of userRows) {
    const userId = Number.parseInt(row.user_id, 10);
    if (Number.isInteger(userId)) {
      await refreshUserRoleState(userId, { ensureDefault: true });
    }
  }
  invalidateRoleCache();
  return getRoleById(role.id || role.numeric_id);
}

export async function assignRoleToUser(userId, role, options = {}) {
  if (!userId) return [];
  const numericUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericUserId)) {
    return [];
  }
  const resolvedRoles = await resolveRoleInputs(role);
  const replace = options?.replace !== undefined ? Boolean(options.replace) : true;
  if (replace) {
    await run("DELETE FROM user_role_assignments WHERE user_id=?", [numericUserId]);
  }
  const existing = replace
    ? new Set()
    : new Set(
        (
          await all(
            "SELECT role_id FROM user_role_assignments WHERE user_id=?",
            [numericUserId],
          )
        )
          .map((row) => Number.parseInt(row.role_id, 10))
          .filter((value) => Number.isInteger(value)),
      );
  for (const roleEntry of resolvedRoles) {
    if (!roleEntry?.numeric_id || existing.has(roleEntry.numeric_id)) {
      continue;
    }
    await run(
      "INSERT OR IGNORE INTO user_role_assignments(user_id, role_id) VALUES(?, ?)",
      [numericUserId, roleEntry.numeric_id],
    );
    existing.add(roleEntry.numeric_id);
  }
  return refreshUserRoleState(numericUserId, { ensureDefault: true });
}

export async function addRoleToUser(userId, role) {
  return assignRoleToUser(userId, role, { replace: false });
}

export async function removeRoleFromUser(userId, roleId) {
  if (!userId || !roleId) {
    return [];
  }
  const numericUserId = Number.parseInt(userId, 10);
  const numericRoleId = Number.parseInt(roleId, 10);
  if (!Number.isInteger(numericUserId) || !Number.isInteger(numericRoleId)) {
    return [];
  }
  await run(
    "DELETE FROM user_role_assignments WHERE user_id=? AND role_id=?",
    [numericUserId, numericRoleId],
  );
  return refreshUserRoleState(numericUserId, { ensureDefault: true });
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
  const userRows = await all(
    "SELECT DISTINCT user_id FROM user_role_assignments WHERE role_id=?",
    [sourceRole.numeric_id],
  );
  const userIds = userRows
    .map((row) => Number.parseInt(row.user_id, 10))
    .filter((value) => Number.isInteger(value));
  if (!userIds.length) {
    return { targetRole: destination, moved: 0 };
  }
  await run(
    "INSERT OR IGNORE INTO user_role_assignments(user_id, role_id) SELECT user_id, ? FROM user_role_assignments WHERE role_id=?",
    [destination.numeric_id, sourceRole.numeric_id],
  );
  await run("DELETE FROM user_role_assignments WHERE role_id=?", [
    sourceRole.numeric_id,
  ]);
  for (const userId of userIds) {
    await refreshUserRoleState(userId, { ensureDefault: true });
  }
  return { targetRole: destination, moved: userIds.length };
}

export async function deleteRole(roleId) {
  const role = await getRoleById(roleId);
  if (!role) {
    return false;
  }
  if (role.is_system || role.isEveryone) {
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

function getCachedDefaultRole(cacheKey) {
  const cached = DEFAULT_ROLE_CACHE.get(cacheKey);
  if (!cached) {
    return null;
  }
  const { role, fetchedAt } = cached;
  if (!role) {
    return null;
  }
  if (Date.now() - fetchedAt > EVERYONE_CACHE_TTL_MS) {
    return null;
  }
  return role;
}

function setCachedDefaultRole(cacheKey, role) {
  DEFAULT_ROLE_CACHE.set(cacheKey, { role, fetchedAt: Date.now() });
}

async function getDefaultRole({
  cacheKey,
  snowflake,
  fallbackName,
  forceRefresh = false,
}) {
  if (!forceRefresh) {
    const cached = getCachedDefaultRole(cacheKey);
    if (cached) {
      return cached;
    }
  }
  let row = await get(
    `SELECT ${ROLE_SELECT_FIELDS} FROM roles WHERE snowflake_id=? LIMIT 1`,
    [snowflake],
  );
  if (!row && fallbackName) {
    row = await get(
      `SELECT ${ROLE_SELECT_FIELDS} FROM roles WHERE name=? COLLATE NOCASE LIMIT 1`,
      [fallbackName],
    );
    if (row?.id) {
      await run(
        "UPDATE roles SET snowflake_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [snowflake, row.id],
      );
      row.snowflake_id = snowflake;
    }
  } else if (row?.id && row.snowflake_id !== snowflake) {
    await run(
      "UPDATE roles SET snowflake_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [snowflake, row.id],
    );
    row.snowflake_id = snowflake;
  }
  const mapped = mapRoleRow(row);
  setCachedDefaultRole(cacheKey, mapped);
  return mapped;
}

export async function getEveryoneRole(options = {}) {
  return getDefaultRole({
    cacheKey: "everyone",
    snowflake: EVERYONE_ROLE_SNOWFLAKE,
    fallbackName: "Everyone",
    forceRefresh: Boolean(options?.forceRefresh),
  });
}

export async function getDefaultUserRole(options = {}) {
  return getDefaultRole({
    cacheKey: "user",
    snowflake: USER_ROLE_SNOWFLAKE,
    fallbackName: "Utilisateurs",
    forceRefresh: Boolean(options?.forceRefresh),
  });
}

export async function getPremiumRole(options = {}) {
  return getDefaultRole({
    cacheKey: "premium",
    snowflake: PREMIUM_ROLE_SNOWFLAKE,
    fallbackName: "Premium",
    forceRefresh: Boolean(options?.forceRefresh),
  });
}
