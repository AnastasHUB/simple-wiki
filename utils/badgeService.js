import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { normalizeHttpUrl } from "./urlValidation.js";

export function normalizeBadgeName(rawName) {
  if (typeof rawName !== "string") {
    return "";
  }
  return rawName.trim().slice(0, 80);
}

export function normalizeBadgeDescription(rawDescription) {
  if (typeof rawDescription !== "string") {
    return "";
  }
  return rawDescription.trim().slice(0, 240);
}

export function normalizeBadgeEmoji(rawEmoji) {
  if (typeof rawEmoji !== "string") {
    return "";
  }
  return rawEmoji.trim().slice(0, 16);
}

export function normalizeBadgeImageUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeHttpUrl(trimmed, { fieldName: "L'URL de l'image" });
}

function mapBadgeRow(row) {
  if (!row) {
    return null;
  }
  return {
    numericId: typeof row.id === "number" ? row.id : null,
    snowflakeId: row.snowflake_id || null,
    name: row.name || "",
    description: typeof row.description === "string" ? row.description : "",
    emoji: typeof row.emoji === "string" ? row.emoji : "",
    imageUrl: typeof row.image_url === "string" && row.image_url.trim()
      ? row.image_url.trim()
      : null,
    category:
      typeof row.category === "string" && row.category.trim()
        ? row.category.trim()
        : "custom",
    automaticKey:
      typeof row.automatic_key === "string" && row.automatic_key.trim()
        ? row.automatic_key.trim()
        : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapAssignmentRow(row) {
  return {
    assignmentId: row.assignment_snowflake_id || null,
    userId: row.user_id,
    username: row.username || null,
    displayName: row.display_name || null,
    assignedAt: row.assigned_at || null,
  };
}

export async function listBadgesWithAssignments() {
  const badgeRows = await all(`
    SELECT b.id,
           b.snowflake_id,
           b.name,
           b.description,
           b.emoji,
           b.image_url,
           b.category,
           b.automatic_key,
           b.created_at,
           b.updated_at,
           COUNT(ub.user_id) AS assignment_count
      FROM badges b
      LEFT JOIN user_badges ub ON ub.badge_id = b.id
     GROUP BY b.id
     ORDER BY LOWER(b.category) ASC, LOWER(b.name) ASC, b.created_at ASC
  `);

  if (!badgeRows.length) {
    return [];
  }

  const badgeIds = badgeRows
    .map((row) => (typeof row.id === "number" ? row.id : null))
    .filter((value) => Number.isInteger(value) && value > 0);

  const assignmentsMap = new Map();
  if (badgeIds.length) {
    const placeholders = badgeIds.map(() => "?").join(", ");
    const assignmentRows = await all(
      `SELECT ub.badge_id,
              ub.snowflake_id AS assignment_snowflake_id,
              ub.user_id,
              ub.assigned_at,
              u.username,
              u.display_name
         FROM user_badges ub
         JOIN users u ON u.id = ub.user_id
        WHERE ub.badge_id IN (${placeholders})
        ORDER BY ub.assigned_at ASC, LOWER(u.username) ASC`,
      badgeIds,
    );
    for (const row of assignmentRows) {
      const badgeId = row.badge_id;
      if (!assignmentsMap.has(badgeId)) {
        assignmentsMap.set(badgeId, []);
      }
      assignmentsMap.get(badgeId).push(mapAssignmentRow(row));
    }
  }

  return badgeRows.map((row) => {
    const base = mapBadgeRow(row);
    return {
      id: base.snowflakeId,
      snowflakeId: base.snowflakeId,
      name: base.name,
      description: base.description,
      emoji: base.emoji,
      imageUrl: base.imageUrl,
      category: base.category,
      automaticKey: base.automaticKey,
      isAutomatic: Boolean(base.automaticKey),
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      assignmentCount: Number.isFinite(Number(row.assignment_count))
        ? Number(row.assignment_count)
        : 0,
      assignees: assignmentsMap.get(base.numericId) || [],
    };
  });
}

export async function getBadgeBySnowflake(snowflakeId) {
  if (typeof snowflakeId !== "string" || !snowflakeId.trim()) {
    return null;
  }
  const row = await get(
    `SELECT id,
            snowflake_id,
            name,
            description,
            emoji,
            image_url,
            category,
            automatic_key,
            created_at,
            updated_at
       FROM badges
      WHERE snowflake_id = ?`,
    [snowflakeId.trim()],
  );
  const badge = mapBadgeRow(row);
  if (!badge) {
    return null;
  }
  return {
    id: badge.snowflakeId,
    snowflakeId: badge.snowflakeId,
    numericId: badge.numericId,
    name: badge.name,
    description: badge.description,
    emoji: badge.emoji,
    imageUrl: badge.imageUrl,
    category: badge.category,
    automaticKey: badge.automaticKey,
    isAutomatic: Boolean(badge.automaticKey),
    createdAt: badge.createdAt,
    updatedAt: badge.updatedAt,
  };
}

export async function createBadge(input) {
  const name = normalizeBadgeName(input?.name);
  const description = normalizeBadgeDescription(input?.description || "");
  const emoji = normalizeBadgeEmoji(input?.emoji);
  const imageUrl = normalizeBadgeImageUrl(input?.imageUrl);

  if (!name) {
    throw new Error("Le nom du badge est requis.");
  }
  if (!emoji && !imageUrl) {
    throw new Error("Ajoutez un emoji ou une image pour le badge.");
  }

  const existing = await get(
    `SELECT id FROM badges WHERE LOWER(name) = LOWER(?)`,
    [name],
  );
  if (existing) {
    throw new Error("Un badge avec ce nom existe déjà.");
  }

  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO badges(snowflake_id, name, description, emoji, image_url)
     VALUES(?,?,?,?,?)`,
    [snowflake, name, description || null, emoji || null, imageUrl],
  );

  return getBadgeBySnowflake(snowflake);
}

export async function updateBadge(snowflakeId, input) {
  const existing = await getBadgeBySnowflake(snowflakeId);
  if (!existing) {
    throw new Error("Badge introuvable.");
  }
  if (existing.isAutomatic) {
    throw new Error("Ce badge est géré automatiquement et ne peut pas être modifié.");
  }

  const hasName = Object.prototype.hasOwnProperty.call(input || {}, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(input || {}, "description");
  const hasEmoji = Object.prototype.hasOwnProperty.call(input || {}, "emoji");
  const hasImage = Object.prototype.hasOwnProperty.call(input || {}, "imageUrl");

  const name = hasName ? normalizeBadgeName(input?.name) : existing.name;
  const description = hasDescription
    ? normalizeBadgeDescription(input?.description || "")
    : existing.description;
  const emoji = hasEmoji ? normalizeBadgeEmoji(input?.emoji) : existing.emoji;
  const imageUrl = hasImage
    ? normalizeBadgeImageUrl(input?.imageUrl)
    : existing.imageUrl;

  if (!name) {
    throw new Error("Le nom du badge est requis.");
  }
  if (!emoji && !imageUrl) {
    throw new Error("Le badge doit contenir au moins un emoji ou une image.");
  }

  const duplicate = await get(
    `SELECT id FROM badges WHERE LOWER(name) = LOWER(?) AND snowflake_id <> ?`,
    [name, existing.snowflakeId],
  );
  if (duplicate) {
    throw new Error("Un autre badge utilise déjà ce nom.");
  }

  await run(
    `UPDATE badges
        SET name = ?,
            description = ?,
            emoji = ?,
            image_url = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE snowflake_id = ?`,
    [name, description || null, emoji || null, imageUrl, existing.snowflakeId],
  );

  return getBadgeBySnowflake(existing.snowflakeId);
}

export async function deleteBadge(snowflakeId) {
  if (typeof snowflakeId !== "string" || !snowflakeId.trim()) {
    return false;
  }
  const trimmed = snowflakeId.trim();
  const badge = await getBadgeBySnowflake(trimmed);
  if (!badge) {
    return false;
  }
  if (badge.isAutomatic) {
    throw new Error("Ce badge est géré automatiquement et ne peut pas être supprimé.");
  }
  const result = await run(`DELETE FROM badges WHERE snowflake_id = ?`, [trimmed]);
  return result.changes > 0;
}

export async function assignBadgeToUser({
  badgeSnowflakeId,
  username,
  assignedByUserId = null,
}) {
  const badge = await getBadgeBySnowflake(badgeSnowflakeId);
  if (!badge) {
    throw new Error("Badge introuvable.");
  }
  if (badge.isAutomatic) {
    throw new Error(
      "Ce badge est attribué automatiquement et ne peut pas être décerné manuellement.",
    );
  }
  const normalizedUsername =
    typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!normalizedUsername) {
    throw new Error("Veuillez indiquer un nom d'utilisateur.");
  }
  const user = await get(
    `SELECT id, username, display_name FROM users WHERE LOWER(username) = ?`,
    [normalizedUsername],
  );
  if (!user) {
    throw new Error("Utilisateur introuvable.");
  }

  const assignmentSnowflake = generateSnowflake();
  try {
    await run(
      `INSERT INTO user_badges(snowflake_id, user_id, badge_id, assigned_by_user_id)
       VALUES(?,?,?,?)`,
      [assignmentSnowflake, user.id, badge.numericId, assignedByUserId],
    );
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT") {
      throw new Error("Ce badge est déjà attribué à cet utilisateur.");
    }
    throw err;
  }

  return {
    assignmentId: assignmentSnowflake,
    badge,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || null,
    },
  };
}

export async function revokeBadgeFromUser({ badgeSnowflakeId, username }) {
  const badge = await getBadgeBySnowflake(badgeSnowflakeId);
  if (!badge) {
    throw new Error("Badge introuvable.");
  }
  if (badge.isAutomatic) {
    throw new Error(
      "Ce badge est attribué automatiquement et ne peut pas être retiré manuellement.",
    );
  }
  const normalizedUsername =
    typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!normalizedUsername) {
    throw new Error("Veuillez indiquer un nom d'utilisateur.");
  }
  const user = await get(
    `SELECT id FROM users WHERE LOWER(username) = ?`,
    [normalizedUsername],
  );
  if (!user) {
    throw new Error("Utilisateur introuvable.");
  }
  const result = await run(
    `DELETE FROM user_badges WHERE badge_id = ? AND user_id = ?`,
    [badge.numericId, user.id],
  );
  return result.changes > 0;
}

export async function listBadgesForUserIds(userIds = []) {
  const normalizedIds = Array.from(
    new Set(
      userIds
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  );
  if (!normalizedIds.length) {
    return new Map();
  }
  const placeholders = normalizedIds.map(() => "?").join(", ");
  const rows = await all(
    `SELECT ub.user_id,
            ub.snowflake_id AS assignment_snowflake_id,
            ub.assigned_at,
            b.snowflake_id AS badge_snowflake_id,
            b.name,
            b.description,
            b.emoji,
            b.image_url,
            b.category,
            b.automatic_key
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
      WHERE ub.user_id IN (${placeholders})
      ORDER BY b.name COLLATE NOCASE ASC, ub.assigned_at ASC`,
    normalizedIds,
  );
  const mapping = new Map();
  for (const row of rows) {
    const userId = row.user_id;
    if (!mapping.has(userId)) {
      mapping.set(userId, []);
    }
    mapping.get(userId).push({
      id: row.badge_snowflake_id || null,
      snowflakeId: row.badge_snowflake_id || null,
      name: row.name || "",
      description: typeof row.description === "string" ? row.description : "",
      emoji: typeof row.emoji === "string" ? row.emoji : "",
      imageUrl:
        typeof row.image_url === "string" && row.image_url.trim()
          ? row.image_url.trim()
          : null,
      category:
        typeof row.category === "string" && row.category.trim()
          ? row.category.trim()
          : "custom",
      assignmentId: row.assignment_snowflake_id || null,
      assignedAt: row.assigned_at || null,
      automaticKey:
        typeof row.automatic_key === "string" && row.automatic_key.trim()
          ? row.automatic_key.trim()
          : null,
      isAutomatic:
        typeof row.automatic_key === "string" && row.automatic_key.trim().length > 0,
    });
  }
  return mapping;
}

export async function listBadgesForUserId(userId) {
  const mapping = await listBadgesForUserIds([userId]);
  return mapping.get(Number.parseInt(userId, 10)) || [];
}
