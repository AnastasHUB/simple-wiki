import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

export async function getActiveUserActionBans(userId) {
  if (!userId) {
    return [];
  }
  return all(
    `SELECT * FROM user_action_bans
       WHERE user_id=? AND lifted_at IS NULL
       ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getActiveUserActionBan({ userId, scope, value = null }) {
  if (!userId || !scope) {
    return null;
  }
  const normalizedScope =
    scope === "tag" ? "tag" : scope === "global" ? "global" : "action";
  const normalizedValue =
    normalizedScope === "action" || normalizedScope === "tag"
      ? value || null
      : null;
  return get(
    `SELECT * FROM user_action_bans
       WHERE user_id=?
         AND scope=?
         AND COALESCE(value, '') = COALESCE(?, '')
         AND lifted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [userId, normalizedScope, normalizedValue],
  );
}

export async function isUserActionBanned(
  userId,
  { action = null, tags = [] } = {},
) {
  if (!userId) {
    return null;
  }
  const bans = await getActiveUserActionBans(userId);
  if (!Array.isArray(bans) || !bans.length) {
    return null;
  }
  for (const ban of bans) {
    if (ban.scope === "global") {
      return ban;
    }
    if (ban.scope === "action" && action && ban.value === action) {
      return ban;
    }
    if (
      ban.scope === "tag" &&
      Array.isArray(tags) &&
      tags.length &&
      tags.includes(ban.value)
    ) {
      return ban;
    }
  }
  return null;
}

export async function banUserAction({
  userId,
  scope,
  value = null,
  reason = null,
}) {
  if (!userId || !scope) {
    return null;
  }
  const normalizedScope =
    scope === "tag" ? "tag" : scope === "global" ? "global" : "action";
  const normalizedValue =
    normalizedScope === "action" || normalizedScope === "tag"
      ? value || null
      : null;
  const snowflake = generateSnowflake();
  await run(
    "INSERT INTO user_action_bans(snowflake_id, user_id, scope, value, reason) VALUES(?,?,?,?,?)",
    [snowflake, userId, normalizedScope, normalizedValue, reason || null],
  );
  return snowflake;
}

export async function liftUserActionBan(id) {
  if (!id) {
    return;
  }
  await run(
    "UPDATE user_action_bans SET lifted_at=CURRENT_TIMESTAMP WHERE snowflake_id=?",
    [id],
  );
}

export async function deleteUserActionBan(id) {
  if (!id) {
    return;
  }
  await run("DELETE FROM user_action_bans WHERE snowflake_id=?", [id]);
}

export async function getUserActionBan(id) {
  if (!id) {
    return null;
  }
  return get("SELECT * FROM user_action_bans WHERE snowflake_id=?", [id]);
}

export async function getUserActionBanWithUser(id) {
  if (!id) {
    return null;
  }
  return get(
    `SELECT uab.*, u.username, u.display_name
       FROM user_action_bans uab
       LEFT JOIN users u ON u.id = uab.user_id
      WHERE uab.snowflake_id=?`,
    [id],
  );
}
