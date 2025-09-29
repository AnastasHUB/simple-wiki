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

export async function countBanAppeals() {
  const row = await get("SELECT COUNT(*) AS total FROM ban_appeals");
  return Number(row?.total ?? 0);
}

export async function fetchBanAppeals({ limit, offset }) {
  const perPage = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  return all(
    `SELECT snowflake_id, ip, scope, value, reason, message, created_at
       FROM ban_appeals
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [perPage, start],
  );
}
