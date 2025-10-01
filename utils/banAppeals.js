import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

const VALID_STATUSES = ["pending", "accepted", "rejected"];

function sanitizeStatus(status) {
  if (!status) {
    return null;
  }
  const lowered = String(status).toLowerCase();
  return VALID_STATUSES.includes(lowered) ? lowered : null;
}

export async function createBanAppeal({
  ip = null,
  scope = null,
  value = null,
  reason = null,
  message,
}) {
  const trimmed = (message || "").trim();
  if (!trimmed) {
    throw new Error("Message requis pour créer une demande de débannissement");
  }
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO ban_appeals(snowflake_id, ip, scope, value, reason, message, status)
     VALUES(?,?,?,?,?,?,?)`,
    [
      snowflake,
      ip || null,
      scope || null,
      value || null,
      reason || null,
      trimmed,
      "pending",
    ],
  );
  return snowflake;
}

export async function hasPendingBanAppeal(ip) {
  if (!ip) {
    return false;
  }
  const row = await get(
    `SELECT snowflake_id FROM ban_appeals WHERE ip=? AND status='pending' LIMIT 1`,
    [ip],
  );
  return Boolean(row);
}

export async function hasRejectedBanAppeal(ip) {
  if (!ip) {
    return false;
  }
  const row = await get(
    `SELECT snowflake_id FROM ban_appeals WHERE ip=? AND status='rejected' LIMIT 1`,
    [ip],
  );
  return Boolean(row);
}

export async function getBanAppealBySnowflake(snowflakeId) {
  if (!snowflakeId) {
    return null;
  }
  return get(
    `SELECT snowflake_id, ip, scope, value, reason, message, status, resolved_at, resolved_by, created_at
       FROM ban_appeals
      WHERE snowflake_id=?`,
    [snowflakeId],
  );
}

export async function resolveBanAppeal({
  snowflakeId,
  status,
  resolvedBy = null,
}) {
  const normalized = sanitizeStatus(status);
  if (!snowflakeId || !normalized || normalized === "pending") {
    throw new Error("Statut de résolution invalide");
  }
  const result = await run(
    `UPDATE ban_appeals
        SET status=?, resolved_at=CURRENT_TIMESTAMP, resolved_by=?
      WHERE snowflake_id=? AND status='pending'`,
    [normalized, resolvedBy || null, snowflakeId],
  );
  return Number(result?.changes ?? 0);
}

export async function deleteBanAppeal(snowflakeId) {
  if (!snowflakeId) {
    return 0;
  }
  const result = await run(`DELETE FROM ban_appeals WHERE snowflake_id=?`, [
    snowflakeId,
  ]);
  return Number(result?.changes ?? 0);
}

export async function countBanAppeals({ search, status } = {}) {
  const filters = [];
  const params = [];

  const normalizedStatus = sanitizeStatus(status);
  if (normalizedStatus) {
    filters.push("status=?");
    params.push(normalizedStatus);
  }

  if (search) {
    const like = `%${search}%`;
    filters.push(
      "(snowflake_id LIKE ? OR ip LIKE ? OR scope LIKE ? OR value LIKE ? OR reason LIKE ? OR message LIKE ?)",
    );
    params.push(like, like, like, like, like, like);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const row = await get(
    `SELECT COUNT(*) AS total FROM ban_appeals ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function fetchBanAppeals({ limit, offset, search, status } = {}) {
  const perPage = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;

  const filters = [];
  const params = [];

  const normalizedStatus = sanitizeStatus(status);
  if (normalizedStatus) {
    filters.push("status=?");
    params.push(normalizedStatus);
  }

  if (search) {
    const like = `%${search}%`;
    filters.push(
      "(snowflake_id LIKE ? OR ip LIKE ? OR scope LIKE ? OR value LIKE ? OR reason LIKE ? OR message LIKE ?)",
    );
    params.push(like, like, like, like, like, like);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  return all(
    `SELECT snowflake_id, ip, scope, value, reason, message, status, resolved_at, resolved_by, created_at
       FROM ban_appeals
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, perPage, start],
  );
}
