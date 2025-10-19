import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { ACHIEVEMENT_DEFINITIONS } from "./achievementDefinitions.js";

const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function getAchievementDefinitions() {
  return [...ACHIEVEMENT_DEFINITIONS];
}

export async function ensureAchievementBadges() {
  for (const achievement of ACHIEVEMENT_DEFINITIONS) {
    const existing = await get(
      `SELECT id, name, description, emoji FROM badges WHERE automatic_key = ?`,
      [achievement.key],
    );
    const normalizedDescription =
      typeof achievement.description === "string" && achievement.description.trim()
        ? achievement.description.trim()
        : null;
    const normalizedEmoji =
      typeof achievement.emoji === "string" && achievement.emoji.trim()
        ? achievement.emoji.trim()
        : null;
    if (!existing) {
      const snowflake = generateSnowflake();
      await run(
        `INSERT INTO badges(snowflake_id, name, description, emoji, image_url, automatic_key)
         VALUES(?,?,?,?,?,?)`,
        [
          snowflake,
          achievement.name,
          normalizedDescription,
          normalizedEmoji,
          null,
          achievement.key,
        ],
      );
      continue;
    }
    const requiresUpdate =
      existing.name !== achievement.name ||
      existing.description !== normalizedDescription ||
      existing.emoji !== normalizedEmoji;
    if (requiresUpdate) {
      await run(
        `UPDATE badges
            SET name = ?,
                description = ?,
                emoji = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE automatic_key = ?`,
        [achievement.name, normalizedDescription, normalizedEmoji, achievement.key],
      );
    }
  }
}

export async function evaluateUserAchievements(userId) {
  const numericId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return;
  }

  await ensureAchievementBadges();

  const user = await get(
    `SELECT id, username, created_at
       FROM users
      WHERE id = ?`,
    [numericId],
  );
  if (!user) {
    return;
  }

  const automaticBadges = await all(
    `SELECT id, automatic_key
       FROM badges
      WHERE automatic_key IS NOT NULL`,
  );
  if (!automaticBadges.length) {
    return;
  }

  const badgeByKey = new Map();
  for (const row of automaticBadges) {
    if (typeof row.automatic_key !== "string" || !row.automatic_key.trim()) {
      continue;
    }
    badgeByKey.set(row.automatic_key.trim(), {
      numericId: Number.parseInt(row.id, 10),
    });
  }

  const existingAssignments = await all(
    `SELECT badge_id
       FROM user_badges
      WHERE user_id = ?`,
    [numericId],
  );
  const heldBadgeIds = new Set(
    existingAssignments
      .map((row) => Number.parseInt(row.badge_id, 10))
      .filter((value) => Number.isInteger(value) && value > 0),
  );

  let membershipDays = 0;
  if (user.created_at) {
    const createdAt = new Date(user.created_at);
    if (!Number.isNaN(createdAt.getTime())) {
      const diff = Date.now() - createdAt.getTime();
      membershipDays = diff > 0 ? diff / MS_IN_DAY : 0;
    }
  }

  const needsPageCount = ACHIEVEMENT_DEFINITIONS.some(
    (achievement) => achievement.type === "page_count",
  );
  let pageCount = 0;
  if (needsPageCount) {
    const pageRow = await get(
      `SELECT COUNT(*) AS total
         FROM page_revisions
        WHERE author_id = ? AND revision = 1`,
      [numericId],
    );
    pageCount = Number.parseInt(pageRow?.total ?? 0, 10) || 0;
  }

  for (const achievement of ACHIEVEMENT_DEFINITIONS) {
    const badge = badgeByKey.get(achievement.key);
    if (!badge || !Number.isInteger(badge.numericId) || badge.numericId <= 0) {
      continue;
    }
    if (heldBadgeIds.has(badge.numericId)) {
      continue;
    }

    let qualifies = false;
    if (achievement.type === "membership_duration") {
      const requiredDays = Number(achievement.options?.days ?? 0);
      qualifies = membershipDays >= requiredDays;
    } else if (achievement.type === "page_count") {
      const requiredCount = Number(achievement.options?.count ?? 0);
      qualifies = pageCount >= requiredCount;
    }

    if (!qualifies) {
      continue;
    }

    try {
      await run(
        `INSERT OR IGNORE INTO user_badges(snowflake_id, user_id, badge_id)
         VALUES(?,?,?)`,
        [generateSnowflake(), numericId, badge.numericId],
      );
    } catch (err) {
      console.error("Unable to assign automatic badge", {
        error: err,
        userId: numericId,
        badgeKey: achievement.key,
      });
    }
  }
}
