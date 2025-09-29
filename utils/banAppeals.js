import { run } from "../db.js";
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
