import { all, get } from "../db.js";
import { formatIpProfileLabel, hashIp } from "./ipProfiles.js";
import {
  resolveHandleColors,
  getHandleColor,
  getHandleProfile,
} from "./userHandles.js";

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
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
  const params = [ip, since, limit];
  if (visibility.params.length) {
    params.push(...visibility.params);
  }
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
       AND ${visibility.clause}
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
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
  const params = [ip, limit, offset];
  if (visibility.params.length) {
    params.push(...visibility.params);
  }
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
     WHERE ${visibility.clause}
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?
  `,
    params,
  );
}

export async function fetchPageWithStats(slugId, ip, { includeUnpublished = false } = {}) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const params = [ip, slugId];
  if (visibility.params.length) {
    params.push(...visibility.params);
  }
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
       ${includeUnpublished ? "" : `AND ${visibility.clause}`}
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

  const nodeClones = new Map();
  for (const node of baseNodes) {
    if (!allowedIds.has(node.snowflake_id)) continue;
    const { rawParentId: _discardedRawParent, ...rest } = node;
    nodeClones.set(node.snowflake_id, {
      ...rest,
      children: [],
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

export async function countPagesByTag(tagName, { includeUnpublished = false } = {}) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const row = await get(
    `
    SELECT COUNT(DISTINCT p.id) AS total
      FROM pages p
      JOIN page_tags pt ON p.id = pt.page_id
      JOIN tags t ON t.id = pt.tag_id
     WHERE t.name = ?
       AND ${visibility.clause}
  `,
    visibility.params.length ? [tagName, ...visibility.params] : [tagName],
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
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  const visibility = buildPublishedFilter({ includeUnpublished });
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
       AND ${visibility.clause}
     ORDER BY p.updated_at DESC`;
  const params = [ip, tagName];
  if (visibility.params.length) {
    params.push(...visibility.params);
  }

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

export async function countPages({ includeUnpublished = false } = {}) {
  const visibility = buildPublishedFilter({ includeUnpublished });
  const params = visibility.params.length ? visibility.params : [];
  const row = await get(
    `SELECT COUNT(*) AS total FROM pages p WHERE ${visibility.clause}`,
    params,
  );
  return row?.total || 0;
}
