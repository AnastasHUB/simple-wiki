import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

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
    `INSERT INTO ban_appeals(snowflake_id, ip, scope, value, reason, message)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, ip || null, scope || null, value || null, reason || null, trimmed],
  );
  return snowflake;
}

export async function countBanAppeals({ search } = {}) {
  const filters = [];
  const params = [];

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

export async function fetchBanAppeals({ limit, offset, search } = {}) {
  const perPage = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;

  const filters = [];
  const params = [];

  if (search) {
    const like = `%${search}%`;
    filters.push(
      "(snowflake_id LIKE ? OR ip LIKE ? OR scope LIKE ? OR value LIKE ? OR reason LIKE ? OR message LIKE ?)",
    );
    params.push(like, like, like, like, like, like);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  return all(
    `SELECT snowflake_id, ip, scope, value, reason, message, created_at
       FROM ban_appeals
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, perPage, start],
  );
}
