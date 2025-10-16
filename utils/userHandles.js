import { all } from "../db.js";
import {
  parseStoredRoleColor,
  buildRoleColorPresentation,
} from "./roleColors.js";
import { listBadgesForUserIds } from "./badgeService.js";

function normalizeHandles(handles = []) {
  const normalized = new Set();
  for (const value of handles) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed.toLowerCase());
  }
  return Array.from(normalized);
}

export async function resolveHandleColors(handles = []) {
  const normalized = normalizeHandles(handles);
  if (!normalized.length) {
    return {};
  }
  const placeholders = normalized.map(() => "?").join(", ");
  const rows = await all(
    `SELECT u.id,
            u.username,
            u.display_name,
            u.avatar_url,
            u.banner_url,
            r.color AS role_color
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE LOWER(u.username) IN (${placeholders})
         OR (u.display_name IS NOT NULL AND LOWER(u.display_name) IN (${placeholders}))`,
    [...normalized, ...normalized],
  );
  const userIds = rows
    .map((row) => (typeof row.id === "number" ? row.id : null))
    .filter((value) => Number.isInteger(value) && value > 0);
  const badgesMap = await listBadgesForUserIds(userIds);
  const mapping = {};
  for (const row of rows) {
    const scheme = parseStoredRoleColor(row.role_color);
    const color = buildRoleColorPresentation(scheme);
    const payload = {
      userId: typeof row.id === "number" ? row.id : null,
      username: row.username || null,
      displayName: row.display_name || null,
      color,
      colorScheme: scheme,
      avatarUrl: row.avatar_url || null,
      bannerUrl: row.banner_url || null,
      badges: badgesMap.get(row.id) || [],
    };
    if (row.username) {
      mapping[row.username.toLowerCase()] = payload;
    }
    if (row.display_name) {
      mapping[row.display_name.toLowerCase()] = payload;
    }
  }
  return mapping;
}

export function getHandleProfile(handle, mapping = {}) {
  if (typeof handle !== "string") {
    return null;
  }
  const normalized = handle.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return mapping[normalized] || null;
}

export function getHandleColor(handle, mapping = {}) {
  return getHandleProfile(handle, mapping);
}
