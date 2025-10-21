import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import { sanitizeReactionKey } from "./reactionHelpers.js";
import { normalizeHttpUrl } from "./urlValidation.js";

const REACTION_EMOJI_CACHE_TTL_MS = 60 * 1000;
let cachedReactionEmoji = null;
let cachedReactionEmojiAt = 0;

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.reaction_key,
    label: row.label,
    emoji: typeof row.emoji === "string" ? row.emoji : "",
    imageUrl: row.image_url || null,
    displayOrder: Number.isFinite(row.display_order)
      ? Number(row.display_order)
      : 0,
    snowflakeId: row.snowflake_id || null,
  };
}

function normalizeLabel(rawLabel, fallback) {
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (label) {
    return label.slice(0, 120);
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim().slice(0, 120);
  }
  return "Réaction";
}

function normalizeEmoji(rawEmoji) {
  if (typeof rawEmoji !== "string") {
    return "";
  }
  const trimmed = rawEmoji.trim();
  return trimmed.slice(0, 16);
}

function normalizeImageUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeHttpUrl(trimmed, { fieldName: "L'URL de l'image" });
}

async function getCurrentMaxOrder() {
  const row = await get(
    `SELECT MAX(display_order) AS max_order FROM reaction_options`,
  );
  const maxOrder = Number(row?.max_order ?? 0);
  return Number.isFinite(maxOrder) ? maxOrder : 0;
}

export async function listReactionOptions() {
  const rows = await all(
    `SELECT reaction_key, label, emoji, image_url, display_order, snowflake_id
       FROM reaction_options
      ORDER BY display_order ASC, reaction_key ASC`,
  );
  if (!rows.length) {
    return [];
  }
  return rows.map((row) => mapRow(row));
}

export async function listReactionEmoji() {
  const now = Date.now();
  if (
    Array.isArray(cachedReactionEmoji) &&
    cachedReactionEmojiAt &&
    now - cachedReactionEmojiAt < REACTION_EMOJI_CACHE_TTL_MS
  ) {
    return cachedReactionEmoji;
  }
  const options = await listReactionOptions();
  const emojiSet = new Set();
  for (const option of options) {
    if (typeof option.emoji === "string") {
      const trimmed = option.emoji.trim();
      if (trimmed) {
        emojiSet.add(trimmed);
      }
    }
  }
  cachedReactionEmoji = Array.from(emojiSet);
  cachedReactionEmojiAt = now;
  return cachedReactionEmoji;
}

export function invalidateReactionEmojiCache() {
  cachedReactionEmoji = null;
  cachedReactionEmojiAt = 0;
}

export async function getReactionOptionByKey(rawKey) {
  if (typeof rawKey !== "string") {
    return null;
  }

  const attempts = [];
  const normalized = sanitizeReactionKey(rawKey);
  if (normalized) {
    attempts.push(normalized);
  }
  const trimmed = rawKey.trim();
  if (trimmed && (!normalized || trimmed !== normalized)) {
    attempts.push(trimmed);
  }

  for (const key of attempts) {
    const row = await get(
      `SELECT reaction_key, label, emoji, image_url, display_order, snowflake_id
         FROM reaction_options
        WHERE reaction_key = ?`,
      [key],
    );
    if (row) {
      return mapRow(row);
    }
  }

  return null;
}

export async function createReactionOption(input) {
  const key = sanitizeReactionKey(input?.id || input?.key);
  if (!key) {
    throw new Error("Identifiant de réaction invalide.");
  }
  const existing = await get(
    `SELECT reaction_key FROM reaction_options WHERE reaction_key = ?`,
    [key],
  );
  if (existing) {
    throw new Error("Cet identifiant est déjà utilisé.");
  }
  const emoji = normalizeEmoji(input?.emoji);
  const imageUrl = normalizeImageUrl(input?.imageUrl);
  if (!emoji && !imageUrl) {
    throw new Error("Ajoutez un emoji ou une image pour la réaction.");
  }
  const label = normalizeLabel(input?.label, emoji || key);
  const order = (await getCurrentMaxOrder()) + 1;
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO reaction_options(snowflake_id, reaction_key, label, emoji, image_url, display_order)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, key, label, emoji || null, imageUrl, order],
  );
  invalidateReactionEmojiCache();
  return getReactionOptionByKey(key);
}

export async function updateReactionOption(rawKey, input) {
  const existing = await getReactionOptionByKey(rawKey);
  if (!existing) {
    throw new Error("Réaction introuvable.");
  }
  const emoji = normalizeEmoji(input?.emoji);
  const imageUrl = normalizeImageUrl(input?.imageUrl);
  const hasExplicitEmoji = typeof input?.emoji === "string";
  const hasExplicitImage = typeof input?.imageUrl === "string";
  const finalEmoji = hasExplicitEmoji ? emoji : existing.emoji;
  const finalImage = hasExplicitImage ? imageUrl : existing.imageUrl;
  if (!finalEmoji && !finalImage) {
    throw new Error("Une réaction doit contenir un emoji ou une image.");
  }
  const label = normalizeLabel(input?.label, existing.label || existing.id);
  await run(
    `UPDATE reaction_options
        SET label = ?,
            emoji = ?,
            image_url = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE reaction_key = ?`,
    [label, finalEmoji || null, finalImage, existing.id],
  );
  invalidateReactionEmojiCache();
  return getReactionOptionByKey(existing.id);
}

async function normalizeReactionOrdering() {
  const rows = await all(
    `SELECT reaction_key
       FROM reaction_options
      ORDER BY display_order ASC, reaction_key ASC`,
  );
  let order = 1;
  for (const row of rows) {
    await run(
      `UPDATE reaction_options SET display_order = ? WHERE reaction_key = ?`,
      [order++, row.reaction_key],
    );
  }
  invalidateReactionEmojiCache();
}

export async function deleteReactionOption(rawKey) {
  const existing = await getReactionOptionByKey(rawKey);
  if (!existing) {
    return false;
  }
  const result = await run(
    `DELETE FROM reaction_options WHERE reaction_key = ?`,
    [existing.id],
  );
  if (result.changes > 0) {
    await run(`DELETE FROM page_reactions WHERE reaction_key = ?`, [existing.id]);
    await run(`DELETE FROM comment_reactions WHERE reaction_key = ?`, [existing.id]);
    await normalizeReactionOrdering();
    invalidateReactionEmojiCache();
    return true;
  }
  return false;
}

export async function moveReactionOption(rawKey, direction) {
  const existing = await getReactionOptionByKey(rawKey);
  if (!existing) {
    throw new Error("Réaction introuvable.");
  }
  const rows = await all(
    `SELECT reaction_key, display_order
       FROM reaction_options
      ORDER BY display_order ASC, reaction_key ASC`,
  );
  const index = rows.findIndex((row) => row.reaction_key === existing.id);
  if (index === -1) {
    throw new Error("Réaction introuvable.");
  }
  const targetIndex =
    direction === "up"
      ? index - 1
      : direction === "down"
      ? index + 1
      : index;
  if (targetIndex < 0 || targetIndex >= rows.length || targetIndex === index) {
    return false;
  }
  const current = rows[index];
  const swap = rows[targetIndex];
  await run(
    `UPDATE reaction_options SET display_order = ? WHERE reaction_key = ?`,
    [swap.display_order, current.reaction_key],
  );
  await run(
    `UPDATE reaction_options SET display_order = ? WHERE reaction_key = ?`,
    [current.display_order, swap.reaction_key],
  );
  invalidateReactionEmojiCache();
  return true;
}
