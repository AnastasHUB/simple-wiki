import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { ROLE_FLAG_FIELDS, getRoleFlagValues } from "./roleFlags.js";

function normalizeBoolean(value) {
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "1" || lower === "true" || lower === "on";
  }
  return Boolean(value);
}

function normalizePermissions(raw = {}) {
  const normalized = {};
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
    ...normalizedFlags,
  };
}

export async function listRoles() {
  const rows = await all(
    `SELECT id, snowflake_id, name, description, is_admin, is_moderator, is_helper, is_contributor, created_at, updated_at
     FROM roles
     ORDER BY name COLLATE NOCASE`,
  );
  return rows.map(mapRoleRow);
}

export async function listRolesWithUsage() {
  const roles = await listRoles();
  const usage = await all(
    "SELECT role_id, COUNT(*) AS total FROM users WHERE role_id IS NOT NULL GROUP BY role_id",
  );
  const usageMap = new Map(usage.map((row) => [row.role_id, Number(row.total) || 0]));
  return roles.map((role) => ({
    ...role,
    userCount: usageMap.get(role.id) || 0,
  }));
}

export async function getRoleById(roleId) {
  if (!roleId) return null;
  const row = await get(
    `SELECT id, snowflake_id, name, description, is_admin, is_moderator, is_helper, is_contributor, created_at, updated_at
     FROM roles
     WHERE id=?`,
    [roleId],
  );
  return mapRoleRow(row);
}

export async function getRoleByName(name) {
  if (!name) return null;
  const row = await get(
    `SELECT id, snowflake_id, name, description, is_admin, is_moderator, is_helper, is_contributor, created_at, updated_at
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
  const result = await run(
    "INSERT INTO roles(snowflake_id, name, description, is_admin, is_moderator, is_helper, is_contributor) VALUES(?,?,?,?,?,?,?)",
    [
      generateSnowflake(),
      trimmedName,
      trimmedDescription,
      ...getRoleFlagValues(perms),
    ],
  );
  return getRoleById(result.lastID);
}

export async function updateRolePermissions(roleId, { permissions = {} }) {
  const role = await getRoleById(roleId);
  if (!role) {
    return null;
  }
  const perms = normalizePermissions(permissions);
  const flagValues = getRoleFlagValues(perms);
  await run(
    "UPDATE roles SET is_admin=?, is_moderator=?, is_helper=?, is_contributor=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [...flagValues, roleId],
  );
  await run(
    "UPDATE users SET is_admin=?, is_moderator=?, is_helper=?, is_contributor=? WHERE role_id=?",
    [...flagValues, roleId],
  );
  return getRoleById(roleId);
}

export async function assignRoleToUser(userId, role) {
  if (!userId) return null;
  const targetRole =
    typeof role === "object" && role !== null ? role : await getRoleById(role);
  if (!targetRole) {
    return null;
  }
  const flagValues = getRoleFlagValues(targetRole);
  await run(
    "UPDATE users SET role_id=?, is_admin=?, is_moderator=?, is_helper=?, is_contributor=? WHERE id=?",
    [targetRole.id, ...flagValues, userId],
  );
  return targetRole;
}

export async function deleteRole(roleId) {
  if (!roleId) return false;
  const usage = await get(
    "SELECT COUNT(*) AS total FROM users WHERE role_id=?",
    [roleId],
  );
  if (usage?.total) {
    throw new Error("Impossible de supprimer un rôle attribué à des utilisateurs.");
  }
  await run("DELETE FROM roles WHERE id=?", [roleId]);
  return true;
}
