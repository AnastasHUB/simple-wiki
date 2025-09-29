import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

export async function getActiveBans(ip) {
  if (!ip) return [];
  return all(
    `SELECT * FROM ip_bans
     WHERE ip=? AND lifted_at IS NULL
     ORDER BY created_at DESC`,
    [ip],
  );
}

export async function isIpBanned(ip, { action = null, tags = [] } = {}) {
  if (!ip) return null;
  const bans = await getActiveBans(ip);
  for (const ban of bans) {
    if (ban.scope === "global") {
      return ban;
    }
    if (ban.scope === "action" && action && ban.value === action) {
      return ban;
    }
    if (ban.scope === "tag" && tags && tags.includes(ban.value)) {
      return ban;
    }
  }
  return null;
}

export async function banIp({ ip, scope, value = null, reason = null }) {
  if (!ip || !scope) return null;
  const normalizedScope = scope === "global" ? "global" : scope;
  const normalizedValue = value || null;
  const snowflake = generateSnowflake();
  await run(
    "INSERT INTO ip_bans(snowflake_id, ip, scope, value, reason) VALUES(?,?,?,?,?)",
    [snowflake, ip, normalizedScope, normalizedValue, reason || null],
  );
  return snowflake;
}

export async function liftBan(id) {
  await run(
    "UPDATE ip_bans SET lifted_at=CURRENT_TIMESTAMP WHERE snowflake_id=?",
    [id],
  );
}

export async function getBan(id) {
  return get("SELECT * FROM ip_bans WHERE snowflake_id=?", [id]);
}

export async function deleteBan(id) {
  await run("DELETE FROM ip_bans WHERE snowflake_id=?", [id]);
}
