import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import {
  listReactionOptions,
  getReactionOptionByKey,
} from "./reactionOptions.js";
import { sanitizeReactionKey } from "./reactionHelpers.js";

function ensureIntegerId(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} invalide`);
  }
  return parsed;
}

export async function listAvailableReactions() {
  const reactions = await listReactionOptions();
  if (!reactions.length) {
    return [];
  }
  return reactions.map((reaction) => ({
    id: reaction.id,
    label: reaction.label,
    emoji: reaction.emoji || "",
    imageUrl: reaction.imageUrl || null,
  }));
}

export async function resolveReactionOption(rawKey) {
  const normalized = sanitizeReactionKey(rawKey);
  const attempts = [];
  if (normalized) {
    attempts.push(normalized);
  }
  const trimmed = typeof rawKey === "string" ? rawKey.trim() : "";
  if (trimmed && trimmed !== normalized) {
    attempts.push(trimmed);
  }
  for (const key of attempts) {
    const option = await getReactionOptionByKey(key);
    if (option) {
      return {
        id: option.id,
        label: option.label,
        emoji: option.emoji || "",
        imageUrl: option.imageUrl || null,
      };
    }
  }
  return null;
}

export function combineReactionState(reactions, state) {
  const totals = new Map();
  const userSelections = new Set();
  if (state && state.totals instanceof Map) {
    state.totals.forEach((value, key) => {
      totals.set(key, Number.isFinite(value) ? Number(value) : 0);
    });
  }
  if (state && state.userSelections instanceof Set) {
    state.userSelections.forEach((value) => {
      if (typeof value === "string") {
        userSelections.add(value);
      }
    });
  }
  return reactions.map((reaction) => {
    const key = reaction.id;
    const count = totals.has(key) ? totals.get(key) : 0;
    return {
      ...reaction,
      key,
      count: Number.isFinite(count) ? count : 0,
      reacted: userSelections.has(key),
    };
  });
}

export async function getPageReactionState(pageId, ip = null) {
  const safePageId = ensureIntegerId(pageId, "pageId");
  const totalsRows = await all(
    `SELECT reaction_key AS key, COUNT(*) AS total
       FROM page_reactions
      WHERE page_id = ?
      GROUP BY reaction_key`,
    [safePageId],
  );
  const totals = new Map();
  for (const row of totalsRows) {
    const key = typeof row.key === "string" ? row.key : null;
    if (!key) continue;
    totals.set(key, Number(row.total) || 0);
  }
  const selections = new Set();
  if (ip) {
    const userRows = await all(
      `SELECT reaction_key AS key
         FROM page_reactions
        WHERE page_id = ? AND ip = ?`,
      [safePageId, ip],
    );
    for (const row of userRows) {
      if (typeof row.key === "string") {
        selections.add(row.key);
      }
    }
  }
  return { totals, userSelections: selections };
}

export async function togglePageReaction({ pageId, reactionKey, ip }) {
  const option = await resolveReactionOption(reactionKey);
  if (!option) {
    const error = new Error("Réaction introuvable.");
    error.statusCode = 400;
    throw error;
  }
  if (!ip) {
    const error = new Error("Adresse IP requise pour enregistrer une réaction.");
    error.statusCode = 400;
    throw error;
  }
  const safePageId = ensureIntegerId(pageId, "pageId");
  const existing = await get(
    `SELECT id
       FROM page_reactions
      WHERE page_id = ?
        AND reaction_key = ?
        AND ip = ?`,
    [safePageId, option.id, ip],
  );
  if (existing) {
    await run("DELETE FROM page_reactions WHERE id = ?", [existing.id]);
    return { added: false, key: option.id };
  }
  const insertion = await run(
    `INSERT OR IGNORE INTO page_reactions(snowflake_id, page_id, reaction_key, ip)
     VALUES(?,?,?,?)`,
    [generateSnowflake(), safePageId, option.id, ip],
  );
  if (insertion?.changes > 0) {
    return { added: true, key: option.id };
  }
  const created = await get(
    `SELECT id
       FROM page_reactions
      WHERE page_id = ?
        AND reaction_key = ?
        AND ip = ?`,
    [safePageId, option.id, ip],
  );
  return { added: Boolean(created), key: option.id };
}

export async function getCommentReactionState(commentSnowflakeId, ip = null) {
  if (typeof commentSnowflakeId !== "string" || !commentSnowflakeId.trim()) {
    throw new Error("commentSnowflakeId invalide");
  }
  const normalized = commentSnowflakeId.trim();
  const totalsRows = await all(
    `SELECT reaction_key AS key, COUNT(*) AS total
       FROM comment_reactions
      WHERE comment_snowflake_id = ?
      GROUP BY reaction_key`,
    [normalized],
  );
  const totals = new Map();
  for (const row of totalsRows) {
    const key = typeof row.key === "string" ? row.key : null;
    if (!key) continue;
    totals.set(key, Number(row.total) || 0);
  }
  const selections = new Set();
  if (ip) {
    const userRows = await all(
      `SELECT reaction_key AS key
         FROM comment_reactions
        WHERE comment_snowflake_id = ?
          AND ip = ?`,
      [normalized, ip],
    );
    for (const row of userRows) {
      if (typeof row.key === "string") {
        selections.add(row.key);
      }
    }
  }
  return { totals, userSelections: selections };
}

export async function getCommentReactionStates(commentSnowflakeIds = [], ip = null) {
  if (!Array.isArray(commentSnowflakeIds) || commentSnowflakeIds.length === 0) {
    return new Map();
  }
  const normalizedIds = commentSnowflakeIds
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim());
  if (!normalizedIds.length) {
    return new Map();
  }
  const placeholders = normalizedIds.map(() => "?").join(", ");
  const totalsRows = await all(
    `SELECT comment_snowflake_id AS commentId,
            reaction_key AS key,
            COUNT(*) AS total
       FROM comment_reactions
      WHERE comment_snowflake_id IN (${placeholders})
      GROUP BY comment_snowflake_id, reaction_key`,
    normalizedIds,
  );
  const map = new Map();
  for (const row of totalsRows) {
    const commentId = typeof row.commentId === "string" ? row.commentId : null;
    const key = typeof row.key === "string" ? row.key : null;
    if (!commentId || !key) continue;
    if (!map.has(commentId)) {
      map.set(commentId, { totals: new Map(), userSelections: new Set() });
    }
    const entry = map.get(commentId);
    entry.totals.set(key, Number(row.total) || 0);
  }
  if (ip) {
    const userRows = await all(
      `SELECT comment_snowflake_id AS commentId,
              reaction_key AS key
         FROM comment_reactions
        WHERE comment_snowflake_id IN (${placeholders})
          AND ip = ?`,
      [...normalizedIds, ip],
    );
    for (const row of userRows) {
      const commentId = typeof row.commentId === "string" ? row.commentId : null;
      const key = typeof row.key === "string" ? row.key : null;
      if (!commentId || !key) continue;
      if (!map.has(commentId)) {
        map.set(commentId, { totals: new Map(), userSelections: new Set() });
      }
      map.get(commentId).userSelections.add(key);
    }
  }
  return map;
}

export async function toggleCommentReaction({ commentSnowflakeId, reactionKey, ip }) {
  if (typeof commentSnowflakeId !== "string" || !commentSnowflakeId.trim()) {
    const error = new Error("Commentaire introuvable");
    error.statusCode = 404;
    throw error;
  }
  const option = await resolveReactionOption(reactionKey);
  if (!option) {
    const error = new Error("Réaction introuvable.");
    error.statusCode = 400;
    throw error;
  }
  if (!ip) {
    const error = new Error("Adresse IP requise pour enregistrer une réaction.");
    error.statusCode = 400;
    throw error;
  }
  const normalized = commentSnowflakeId.trim();
  const comment = await get(
    `SELECT snowflake_id FROM comments WHERE snowflake_id = ?`,
    [normalized],
  );
  if (!comment) {
    const error = new Error("Commentaire introuvable");
    error.statusCode = 404;
    throw error;
  }
  const existing = await get(
    `SELECT id
       FROM comment_reactions
      WHERE comment_snowflake_id = ?
        AND reaction_key = ?
        AND ip = ?`,
    [normalized, option.id, ip],
  );
  if (existing) {
    await run("DELETE FROM comment_reactions WHERE id = ?", [existing.id]);
    return { added: false, key: option.id };
  }
  const insertion = await run(
    `INSERT OR IGNORE INTO comment_reactions(snowflake_id, comment_snowflake_id, reaction_key, ip)
     VALUES(?,?,?,?)`,
    [generateSnowflake(), normalized, option.id, ip],
  );
  if (insertion?.changes > 0) {
    return { added: true, key: option.id };
  }
  const created = await get(
    `SELECT id
       FROM comment_reactions
      WHERE comment_snowflake_id = ?
        AND reaction_key = ?
        AND ip = ?`,
    [normalized, option.id, ip],
  );
  return { added: Boolean(created), key: option.id };
}
