import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import {
  ACHIEVEMENT_CRITERIA,
  getAchievementCriterionByKey,
} from "./achievementCriteria.js";
import {
  normalizeBadgeDescription,
  normalizeBadgeEmoji,
  normalizeBadgeImageUrl,
  normalizeBadgeName,
  getBadgeBySnowflake,
} from "./badgeService.js";

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SUCCESS_BADGE_KEYS = [
  "membership_days_7",
  "membership_days_365",
  "page_count_1",
  "page_count_5",
];

function cloneCriterion(criterion) {
  if (!criterion) {
    return null;
  }
  return {
    ...criterion,
    options: typeof criterion.options === "object" && criterion.options
      ? { ...criterion.options }
      : {},
  };
}

function normalizeSuccessBadgeInput(input, criterion, existing = {}) {
  const hasName = Object.prototype.hasOwnProperty.call(input || {}, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(input || {}, "description");
  const hasEmoji = Object.prototype.hasOwnProperty.call(input || {}, "emoji");
  const hasImage = Object.prototype.hasOwnProperty.call(input || {}, "imageUrl");

  const fallbackName = existing.name || criterion?.name || "";
  const fallbackDescription =
    existing.description || criterion?.description || "";
  const fallbackEmoji = existing.emoji || criterion?.emoji || "";
  const fallbackImage = existing.imageUrl || null;

  const name = normalizeBadgeName(
    hasName ? input?.name : fallbackName,
  );
  const description = normalizeBadgeDescription(
    hasDescription ? input?.description || "" : fallbackDescription,
  );
  const emoji = normalizeBadgeEmoji(hasEmoji ? input?.emoji : fallbackEmoji);
  const imageUrl = normalizeBadgeImageUrl(
    hasImage ? input?.imageUrl : fallbackImage,
  );

  if (!name) {
    throw new Error("Le nom du badge est requis.");
  }
  if (!emoji && !imageUrl) {
    throw new Error("Ajoutez un emoji ou une image pour le badge.");
  }

  return { name, description, emoji, imageUrl };
}

export function getAchievementDefinitions() {
  return ACHIEVEMENT_CRITERIA.map((criterion) => cloneCriterion(criterion));
}

export async function ensureAchievementBadges() {
  for (const key of DEFAULT_SUCCESS_BADGE_KEYS) {
    const criterion = getAchievementCriterionByKey(key);
    if (!criterion) {
      continue;
    }
    const existing = await get(
      `SELECT id, name, description, emoji, category
         FROM badges
        WHERE automatic_key = ?`,
      [key],
    );
    const normalizedName = normalizeBadgeName(criterion.name);
    const normalizedDescription = normalizeBadgeDescription(
      criterion.description || "",
    );
    const normalizedEmoji = normalizeBadgeEmoji(criterion.emoji);
    if (!existing) {
      const snowflake = generateSnowflake();
      await run(
        `INSERT INTO badges(snowflake_id, name, description, emoji, image_url, automatic_key, category)
         VALUES(?,?,?,?,?,?,?)`,
        [
          snowflake,
          normalizedName,
          normalizedDescription || null,
          normalizedEmoji || null,
          null,
          key,
          "success",
        ],
      );
      continue;
    }
    const requiresUpdate =
      existing.name !== normalizedName ||
      existing.description !== normalizedDescription ||
      existing.emoji !== normalizedEmoji ||
      existing.category !== "success";
    if (requiresUpdate) {
      await run(
        `UPDATE badges
            SET name = ?,
                description = ?,
                emoji = ?,
                category = 'success',
                updated_at = CURRENT_TIMESTAMP
          WHERE automatic_key = ?`,
        [
          normalizedName,
          normalizedDescription || null,
          normalizedEmoji || null,
          key,
        ],
      );
    }
  }
}

export async function createAchievementBadge(input) {
  const criterionKey =
    typeof input?.criterionKey === "string" ? input.criterionKey.trim() : "";
  if (!criterionKey) {
    throw new Error("Sélectionnez un critère de réussite valide.");
  }
  const criterion = getAchievementCriterionByKey(criterionKey);
  if (!criterion) {
    throw new Error("Critère de réussite introuvable.");
  }
  const duplicateCriterion = await get(
    `SELECT id FROM badges WHERE automatic_key = ?`,
    [criterion.key],
  );
  if (duplicateCriterion) {
    throw new Error("Un badge de succès utilise déjà ce critère.");
  }
  const { name, description, emoji, imageUrl } = normalizeSuccessBadgeInput(
    input,
    criterion,
  );
  const duplicateName = await get(
    `SELECT id FROM badges WHERE LOWER(name) = LOWER(?)`,
    [name],
  );
  if (duplicateName) {
    throw new Error("Un badge existe déjà avec ce nom.");
  }
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO badges(snowflake_id, name, description, emoji, image_url, automatic_key, category)
     VALUES(?,?,?,?,?,?,?)`,
    [
      snowflake,
      name,
      description || null,
      emoji || null,
      imageUrl,
      criterion.key,
      "success",
    ],
  );
  return getBadgeBySnowflake(snowflake);
}

export async function updateAchievementBadge(snowflakeId, input) {
  const existing = await getBadgeBySnowflake(snowflakeId);
  if (!existing || existing.category !== "success" || !existing.automaticKey) {
    throw new Error("Badge de succès introuvable.");
  }
  const hasCriterionKey = Object.prototype.hasOwnProperty.call(
    input || {},
    "criterionKey",
  );
  const nextCriterionKey = hasCriterionKey
    ? typeof input?.criterionKey === "string"
      ? input.criterionKey.trim()
      : ""
    : existing.automaticKey;
  if (!nextCriterionKey) {
    throw new Error("Sélectionnez un critère de réussite valide.");
  }
  const criterion = getAchievementCriterionByKey(nextCriterionKey);
  if (!criterion) {
    throw new Error("Critère de réussite introuvable.");
  }
  if (nextCriterionKey !== existing.automaticKey) {
    const duplicate = await get(
      `SELECT id FROM badges WHERE automatic_key = ? AND snowflake_id <> ?`,
      [nextCriterionKey, existing.snowflakeId],
    );
    if (duplicate) {
      throw new Error("Un autre badge de succès utilise déjà ce critère.");
    }
  }
  const { name, description, emoji, imageUrl } = normalizeSuccessBadgeInput(
    input,
    criterion,
    existing,
  );
  const duplicateName = await get(
    `SELECT id FROM badges WHERE LOWER(name) = LOWER(?) AND snowflake_id <> ?`,
    [name, existing.snowflakeId],
  );
  if (duplicateName) {
    throw new Error("Un autre badge utilise déjà ce nom.");
  }
  const updated = await run(
    `UPDATE badges
        SET name = ?,
            description = ?,
            emoji = ?,
            image_url = ?,
            automatic_key = ?,
            category = 'success',
            updated_at = CURRENT_TIMESTAMP
      WHERE snowflake_id = ?`,
    [
      name,
      description || null,
      emoji || null,
      imageUrl,
      criterion.key,
      existing.snowflakeId,
    ],
  );
  if (nextCriterionKey !== existing.automaticKey && existing.numericId) {
    await run(`DELETE FROM user_badges WHERE badge_id = ?`, [existing.numericId]);
  }
  return updated.changes > 0
    ? getBadgeBySnowflake(existing.snowflakeId)
    : existing;
}

export async function deleteAchievementBadge(snowflakeId) {
  const existing = await getBadgeBySnowflake(snowflakeId);
  if (!existing || existing.category !== "success" || !existing.automaticKey) {
    throw new Error("Badge de succès introuvable.");
  }
  await run(`DELETE FROM badges WHERE snowflake_id = ?`, [existing.snowflakeId]);
  return true;
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

  const automaticRows = await all(
    `SELECT id, automatic_key
       FROM badges
      WHERE category = 'success' AND automatic_key IS NOT NULL`,
  );
  if (!automaticRows.length) {
    return;
  }

  const badgeByKey = new Map();
  for (const row of automaticRows) {
    const key = typeof row.automatic_key === "string" ? row.automatic_key.trim() : "";
    if (!key) {
      continue;
    }
    const criterion = getAchievementCriterionByKey(key);
    if (!criterion) {
      continue;
    }
    badgeByKey.set(key, {
      numericId: Number.parseInt(row.id, 10),
      criterion,
    });
  }

  if (!badgeByKey.size) {
    return;
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

  const needsPageCount = Array.from(badgeByKey.values()).some(
    (entry) => entry.criterion.type === "page_count",
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

  for (const [key, entry] of badgeByKey.entries()) {
    const badgeInfo = entry;
    if (!badgeInfo || !Number.isInteger(badgeInfo.numericId) || badgeInfo.numericId <= 0) {
      continue;
    }
    if (heldBadgeIds.has(badgeInfo.numericId)) {
      continue;
    }
    const { criterion } = badgeInfo;
    let qualifies = false;
    if (criterion.type === "membership_duration") {
      const requiredDays = Number(criterion.options?.days ?? 0);
      qualifies = membershipDays >= requiredDays;
    } else if (criterion.type === "page_count") {
      const requiredCount = Number(criterion.options?.count ?? 0);
      qualifies = pageCount >= requiredCount;
    }
    if (!qualifies) {
      continue;
    }
    try {
      await run(
        `INSERT OR IGNORE INTO user_badges(snowflake_id, user_id, badge_id)
         VALUES(?,?,?)`,
        [generateSnowflake(), numericId, badgeInfo.numericId],
      );
    } catch (err) {
      console.error("Unable to assign automatic badge", {
        error: err,
        userId: numericId,
        badgeKey: key,
      });
    }
  }
}
