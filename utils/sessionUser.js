import { get } from "../db.js";
import { ROLE_FLAG_FIELDS, buildSessionUser, deriveRoleFlags } from "./roleFlags.js";
import { getRolesForUser } from "./roleService.js";

const ROLE_FIELD_SELECT = ROLE_FLAG_FIELDS.map(
  (field) => `r.${field} AS role_${field}`,
).join(", ");

export async function loadSessionUserById(userId) {
  if (!userId) {
    return null;
  }
  const row = await get(
    `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id=?`,
    [userId],
  );
  if (!row) {
    return null;
  }
  const assignedRoles = await getRolesForUser(row.id);
  const flags = deriveRoleFlags({ ...row, roles: assignedRoles });
  return buildSessionUser({ ...row, roles: assignedRoles }, flags);
}
