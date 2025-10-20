import { all, get, run } from "../db.js";
import { formatIpProfileLabel, hashIp } from "./ipProfiles.js";
import {
  resolveHandleColors,
  getHandleColor,
  getHandleProfile,
} from "./userHandles.js";
import { normalizeRoleSnowflake } from "./roleVisibility.js";

function normalizeRoleSnowflakeList(values) {
  if (values === null || values === undefined) {
    return [];
  }
  const inputs =
    values instanceof Set
      ? Array.from(values)
      : Array.isArray(values)
        ? values
        : [values];
  const seen = new Set();
  for (const value of inputs) {
    const normalized = normalizeRoleSnowflake(value);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }
  return Array.from(seen);
}

function buildVisibilityClause({
  joinTable,
  entityColumn,
  alias,
  allowedRoleSnowflakes = null,
}) {
  const safeAlias = alias || "entity";
  if (allowedRoleSnowflakes === null) {
    return { clause: "1=1", params: [] };
  }
  const normalized = normalizeRoleSnowflakeList(allowedRoleSnowflakes);
  const baseClause = `NOT EXISTS (SELECT 1 FROM ${joinTable} vis WHERE vis.${entityColumn} = ${safeAlias}.id)`;
  if (normalized.length === 0) {
    return { clause: baseClause, params: [] };
  }
  const placeholders = normalized.map(() => "?").join(", ");
  const clause = `(${baseClause} OR EXISTS (SELECT 1 FROM ${joinTable} vis_allowed WHERE vis_allowed.${entityColumn} = ${safeAlias}.id AND vis_allowed.role_snowflake IN (${placeholders})))`;
  return { clause, params: normalized };
}

export function buildPageVisibilityClause({
  alias = "p",
  allowedRoleSnowflakes = null,
} = {}) {
  return buildVisibilityClause({
    joinTable: "page_role_visibility",
    entityColumn: "page_id",
    alias,
    allowedRoleSnowflakes,
  });
}

export function buildTagVisibilityClause({
  alias = "t",
  allowedRoleSnowflakes = null,
} = {}) {
  return buildVisibilityClause({
    joinTable: "tag_role_visibility",
    entityColumn: "tag_id",
    alias,
    allowedRoleSnowflakes,
  });
}

const COMMENT_ATTACHMENT_IMAGE_PATTERN = /^image\/[^\s]+$/i;

const TAGS_CSV_SUBQUERY = `(
  SELECT GROUP_CONCAT(t.name, ',')
  FROM tags t
  JOIN page_tags pt ON pt.tag_id = t.id
  WHERE pt.page_id = p.id
)`;

const VIEW_COUNT_SELECT = `
  COALESCE((SELECT SUM(views) FROM page_view_daily WHERE page_id = p.id), 0) +
  COALESCE((SELECT COUNT(*) FROM page_views WHERE page_id = p.id), 0)
`;

export function buildPublishedFilter({ includeUnpublished = false, alias = "p" } = {}) {
  if (includeUnpublished) {
    return { clause: "1=1", params: [] };
  }
  const safeAlias = alias || "p";
  return {
    clause: `(${safeAlias}.status = 'published' OR (${safeAlias}.status = 'scheduled' AND ${safeAlias}.publish_at IS NOT NULL AND datetime(${safeAlias}.publish_at) <= datetime('now')))`,
    params: [],
  };
}

export async function fetchRecentPages({
  ip,
  since,
  limit = 3,
  excerptLength = 900,
  includeUnpublished = false,
  allowedRoleSnowflakes = null,
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
  const access = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (access.clause && access.clause !== "1=1") {
    clauseParts.push(access.clause);
    clauseParams.push(...access.params);
  }
  const accessClause = clauseParts.length ? ` AND ${clauseParts.join(" AND ")}` : "";
  const params = [ip, since, ...clauseParams, limit];
  return all(
    `
    SELECT p.id,
           p.snowflake_id,
           p.title,
           p.slug_id,
           p.author,
           substr(p.content, 1, ${excerpt}) AS excerpt,
           p.created_at,
           ${TAGS_CSV_SUBQUERY} AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*)
                     FROM comments
                     WHERE page_id = p.id
                       AND status = 'approved'
                       AND parent_snowflake_id IS NULL), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     WHERE p.created_at >= ?
       ${accessClause}
    ORDER BY p.created_at DESC
     LIMIT ?
  `,
    params,
  );
}

export async function fetchPaginatedPages({
  ip,
  limit,
  offset,
  excerptLength = 1200,
  includeUnpublished = false,
  allowedRoleSnowflakes = null,
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
  const access = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (access.clause && access.clause !== "1=1") {
    clauseParts.push(access.clause);
    clauseParams.push(...access.params);
  }
  const combinedClause = clauseParts.length ? clauseParts.join(" AND ") : "1=1";
  const params = [ip, ...clauseParams, limit, offset];
  return all(
    `
    SELECT p.id,
           p.snowflake_id,
           p.title,
           p.slug_id,
           p.author,
           substr(p.content, 1, ${excerpt}) AS excerpt,
           p.created_at,
           ${TAGS_CSV_SUBQUERY} AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*)
                     FROM comments
                     WHERE page_id = p.id
                       AND status = 'approved'
                       AND parent_snowflake_id IS NULL), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     WHERE ${combinedClause}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?
  `,
    params,
  );
}

export async function fetchPageWithStats(
  slugId,
  ip,
  { includeUnpublished = false, allowedRoleSnowflakes = null } = {},
) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const access = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (!includeUnpublished && visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (access.clause && access.clause !== "1=1") {
    clauseParts.push(access.clause);
    clauseParams.push(...access.params);
  }
  const clauseSql = clauseParts.length ? ` AND ${clauseParts.join(" AND ")}` : "";
  const params = [ip, slugId, ...clauseParams];
  const page = await get(
    `
    SELECT p.*,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*)
                     FROM comments
                     WHERE page_id = p.id
                       AND status = 'approved'
                       AND parent_snowflake_id IS NULL), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     WHERE slug_id = ?
      ${clauseSql}
  `,
    params,
  );

  if (!page) {
    return null;
  }

  const handleMap = await resolveHandleColors([page.author]);
  return {
    ...page,
    authorRole: getHandleColor(page.author, handleMap),
  };
}

export async function fetchPageTags(pageId) {
  const rows = await all(
    `SELECT name FROM tags t JOIN page_tags pt ON t.id = pt.tag_id WHERE pt.page_id = ? ORDER BY name`,
    [pageId],
  );
  return rows.map((row) => row.name);
}

export async function fetchPageComments(pageId, options = {}) {
  const { limit, offset } = options;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const rootRows = await all(
    `SELECT snowflake_id
       FROM comments
      WHERE page_id = ?
        AND status = 'approved'
        AND parent_snowflake_id IS NULL
      ORDER BY created_at ASC`,
    [pageId],
  );

  const rootIds = rootRows.map((row) => row.snowflake_id);
  const sliceStart = safeOffset || 0;
  const sliceEnd = safeLimit !== null ? sliceStart + safeLimit : undefined;
  const selectedRootIds = rootIds.slice(sliceStart, sliceEnd);

  if (!selectedRootIds.length) {
    return [];
  }

  const threadPlaceholders = selectedRootIds.map(() => "?").join(", ");
  const rows = await all(
    `WITH RECURSIVE thread AS (
       SELECT c.id,
              c.snowflake_id,
              c.parent_snowflake_id,
              c.page_id,
              c.author,
              c.body,
              c.created_at,
              c.updated_at,
              c.ip,
              c.author_is_admin
         FROM comments c
        WHERE c.page_id = ?
          AND c.status = 'approved'
          AND c.snowflake_id IN (${threadPlaceholders})
       UNION ALL
       SELECT child.id,
              child.snowflake_id,
              child.parent_snowflake_id,
              child.page_id,
              child.author,
              child.body,
              child.created_at,
              child.updated_at,
              child.ip,
              child.author_is_admin
         FROM comments child
         JOIN thread parent ON parent.snowflake_id = child.parent_snowflake_id
        WHERE child.status = 'approved'
          AND child.page_id = ?
     )
     SELECT t.id AS legacy_id,
            t.snowflake_id,
            t.parent_snowflake_id,
            t.author,
            t.body,
            t.created_at,
            t.updated_at,
            t.ip AS raw_ip,
            t.author_is_admin,
            ipr.hash AS ip_hash
       FROM thread t
       LEFT JOIN ip_profiles ipr ON ipr.ip = t.ip
      ORDER BY t.created_at ASC`,
    [pageId, ...selectedRootIds, pageId],
  );

  if (!rows.length) {
    return [];
  }

  const handleMap = await resolveHandleColors(rows.map((row) => row.author));
  const baseNodes = rows.map((row) => {
    const handleProfile = getHandleProfile(row.author, handleMap);
    const ipHash = row.ip_hash || hashIp(row.raw_ip || "");
    const {
      raw_ip: _unusedIp,
      ip_hash: _unusedHash,
      author_is_admin: _unusedAuthorIsAdmin,
      parent_snowflake_id: rawParentId,
      ...rest
    } = row;
    const trimmedParent =
      typeof rawParentId === "string" && rawParentId.trim().length
        ? rawParentId.trim()
        : null;
    return {
      ...rest,
      parentId: trimmedParent,
      rawParentId: trimmedParent,
      isAdminAuthor: Boolean(row.author_is_admin),
      authorRole: handleProfile,
      authorAvatar: handleProfile?.avatarUrl || null,
      authorBanner: handleProfile?.bannerUrl || null,
      authorBadges: Array.isArray(handleProfile?.badges)
        ? handleProfile.badges
        : [],
      ipProfile: ipHash
        ? {
            hash: ipHash,
            shortHash: formatIpProfileLabel(ipHash),
          }
        : null,
    };
  });

  const nodesById = new Map();
  for (const node of baseNodes) {
    nodesById.set(node.snowflake_id, node);
  }

  for (const node of baseNodes) {
    let parentId = node.rawParentId;
    if (!parentId || !nodesById.has(parentId)) {
      node.parentId = null;
      continue;
    }
    const visited = new Set();
    let currentId = parentId;
    let hasCycle = false;
    while (currentId) {
      if (currentId === node.snowflake_id) {
        hasCycle = true;
        break;
      }
      if (visited.has(currentId)) {
        hasCycle = true;
        break;
      }
      visited.add(currentId);
      const currentNode = nodesById.get(currentId);
      if (!currentNode) {
        parentId = null;
        break;
      }
      currentId = currentNode.rawParentId || null;
    }
    node.parentId = hasCycle ? null : parentId;
  }

  const childMap = new Map();
  for (const node of baseNodes) {
    if (!node.parentId) continue;
    if (!childMap.has(node.parentId)) {
      childMap.set(node.parentId, []);
    }
    childMap.get(node.parentId).push(node.snowflake_id);
  }

  const allowedIds = new Set();
  const collectSubtree = (snowflakeId) => {
    if (!snowflakeId || allowedIds.has(snowflakeId)) {
      return;
    }
    allowedIds.add(snowflakeId);
    const children = childMap.get(snowflakeId) || [];
    for (const childId of children) {
      if (childId === snowflakeId) {
        continue;
      }
      collectSubtree(childId);
    }
  };

  for (const rootId of selectedRootIds) {
    collectSubtree(rootId);
  }

  let attachmentsByComment = new Map();
  if (allowedIds.size) {
    const attachmentPlaceholders = Array.from(allowedIds)
      .map(() => "?")
      .join(", ");
    if (attachmentPlaceholders.length) {
      const attachmentRows = await all(
        `SELECT snowflake_id,
                comment_snowflake_id,
                file_path,
                mime_type,
                file_size,
                original_name
           FROM comment_attachments
          WHERE comment_snowflake_id IN (${attachmentPlaceholders})
          ORDER BY id ASC`,
        [...allowedIds],
      );
      attachmentsByComment = new Map();
      for (const row of attachmentRows) {
        const commentId = row.comment_snowflake_id;
        const normalizedPath =
          typeof row.file_path === "string"
            ? row.file_path.replace(/\\/g, "/")
            : "";
        const safePath = normalizedPath.replace(/^[\\/]+/, "");
        const downloadUrl = safePath ? `/public/${safePath}` : null;
        const size = Number.parseInt(row.file_size, 10);
        const attachment = {
          id: row.snowflake_id,
          commentId,
          path: safePath,
          url: downloadUrl,
          mimeType: row.mime_type,
          size: Number.isNaN(size) ? 0 : size,
          originalName:
            typeof row.original_name === "string" && row.original_name
              ? row.original_name
              : "Pièce jointe",
          isImage: COMMENT_ATTACHMENT_IMAGE_PATTERN.test(row.mime_type || ""),
        };
        if (!attachmentsByComment.has(commentId)) {
          attachmentsByComment.set(commentId, []);
        }
        attachmentsByComment.get(commentId).push(attachment);
      }
    }
  }

  const nodeClones = new Map();
  for (const node of baseNodes) {
    if (!allowedIds.has(node.snowflake_id)) continue;
    const { rawParentId: _discardedRawParent, ...rest } = node;
    const attachments = attachmentsByComment.get(node.snowflake_id) || [];
    nodeClones.set(node.snowflake_id, {
      ...rest,
      children: [],
      attachments,
      hasAttachments: attachments.length > 0,
    });
  }

  for (const node of nodeClones.values()) {
    if (!node.parentId) continue;
    const parentNode = nodeClones.get(node.parentId);
    if (parentNode) {
      parentNode.children.push(node);
    }
  }

  const roots = [];
  for (const rootId of selectedRootIds) {
    const rootNode = nodeClones.get(rootId);
    if (rootNode) {
      roots.push(rootNode);
    }
  }

  const assignDepth = (nodes, depth) => {
    for (const node of nodes) {
      node.depth = depth;
      if (node.children && node.children.length) {
        assignDepth(node.children, depth + 1);
      }
    }
  };

  assignDepth(roots, 0);

  return roots;
}

export async function countPagesByTag(
  tagName,
  { includeUnpublished = false, allowedRoleSnowflakes = null } = {},
) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const pageAccess = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const tagAccess = buildTagVisibilityClause({
    alias: "t",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (pageAccess.clause && pageAccess.clause !== "1=1") {
    clauseParts.push(pageAccess.clause);
    clauseParams.push(...pageAccess.params);
  }
  if (tagAccess.clause && tagAccess.clause !== "1=1") {
    clauseParts.push(tagAccess.clause);
    clauseParams.push(...tagAccess.params);
  }
  const clauseSql = clauseParts.length ? ` AND ${clauseParts.join(" AND ")}` : "";
  const row = await get(
    `
    SELECT COUNT(DISTINCT p.id) AS total
      FROM pages p
      JOIN page_tags pt ON p.id = pt.page_id
      JOIN tags t ON t.id = pt.tag_id
     WHERE t.name = ?
       ${clauseSql}
  `,
    [tagName, ...clauseParams],
  );
  return Number(row?.total ?? 0);
}

export async function fetchPagesByTag({
  tagName,
  ip,
  limit,
  offset,
  excerptLength = 1200,
  includeUnpublished = false,
  allowedRoleSnowflakes = null,
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
  const pageAccess = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const tagAccess = buildTagVisibilityClause({
    alias: "t",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (pageAccess.clause && pageAccess.clause !== "1=1") {
    clauseParts.push(pageAccess.clause);
    clauseParams.push(...pageAccess.params);
  }
  if (tagAccess.clause && tagAccess.clause !== "1=1") {
    clauseParts.push(tagAccess.clause);
    clauseParams.push(...tagAccess.params);
  }
  const clauseSql = clauseParts.length ? ` AND ${clauseParts.join(" AND ")}` : "";
  let query = `
    SELECT p.id,
           p.snowflake_id,
           p.title,
           p.slug_id,
           p.author,
           substr(p.content, 1, ${excerpt}) AS excerpt,
           p.created_at,
           ${TAGS_CSV_SUBQUERY} AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*)
                     FROM comments
                     WHERE page_id = p.id
                       AND status = 'approved'
                       AND parent_snowflake_id IS NULL), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
      JOIN page_tags pt ON p.id = pt.page_id
      JOIN tags t ON t.id = pt.tag_id
     WHERE t.name = ?
       ${clauseSql}
     ORDER BY p.updated_at DESC`;
  const params = [ip, tagName, ...clauseParams];

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : null;

  if (safeLimit !== null) {
    query += "\n     LIMIT ?";
    params.push(safeLimit);
    if (safeOffset !== null) {
      query += " OFFSET ?";
      params.push(safeOffset);
    }
  } else if (safeOffset !== null) {
    query += "\n     LIMIT -1 OFFSET ?";
    params.push(safeOffset);
  }

  return all(query, params);
}

export async function countPages({
  includeUnpublished = false,
  allowedRoleSnowflakes = null,
} = {}) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const access = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const clauseParts = [];
  const clauseParams = [];
  if (visibility.clause && visibility.clause !== "1=1") {
    clauseParts.push(visibility.clause);
    clauseParams.push(...visibility.params);
  }
  if (access.clause && access.clause !== "1=1") {
    clauseParts.push(access.clause);
    clauseParams.push(...access.params);
  }
  const combinedClause = clauseParts.length ? clauseParts.join(" AND ") : "1=1";
  const row = await get(
    `SELECT COUNT(*) AS total FROM pages p WHERE ${combinedClause}`,
    clauseParams,
  );
  return row?.total || 0;
}

export async function listPageVisibilityRoles(pageId) {
  if (!pageId) {
    return [];
  }
  const rows = await all(
    "SELECT role_snowflake FROM page_role_visibility WHERE page_id=? ORDER BY role_snowflake ASC",
    [pageId],
  );
  return rows
    .map((row) => normalizeRoleSnowflake(row?.role_snowflake))
    .filter(Boolean);
}

export async function setPageVisibilityRoles(pageId, roleSnowflakes = []) {
  if (!pageId) {
    return;
  }
  const normalized = normalizeRoleSnowflakeList(roleSnowflakes);
  await run("DELETE FROM page_role_visibility WHERE page_id=?", [pageId]);
  if (!normalized.length) {
    return;
  }
  for (const snowflake of normalized) {
    await run(
      "INSERT OR IGNORE INTO page_role_visibility(page_id, role_snowflake) VALUES(?, ?)",
      [pageId, snowflake],
    );
  }
}

export async function listTagVisibilityRoles(tagId) {
  if (!tagId) {
    return [];
  }
  const rows = await all(
    "SELECT role_snowflake FROM tag_role_visibility WHERE tag_id=? ORDER BY role_snowflake ASC",
    [tagId],
  );
  return rows
    .map((row) => normalizeRoleSnowflake(row?.role_snowflake))
    .filter(Boolean);
}

export async function setTagVisibilityRoles(tagId, roleSnowflakes = []) {
  if (!tagId) {
    return;
  }
  const normalized = normalizeRoleSnowflakeList(roleSnowflakes);
  await run("DELETE FROM tag_role_visibility WHERE tag_id=?", [tagId]);
  if (!normalized.length) {
    return;
  }
  for (const snowflake of normalized) {
    await run(
      "INSERT OR IGNORE INTO tag_role_visibility(tag_id, role_snowflake) VALUES(?, ?)",
      [tagId, snowflake],
    );
  }
}
