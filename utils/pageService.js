import { all, get } from "../db.js";
import { formatIpProfileLabel, hashIp } from "./ipProfiles.js";
import { resolveHandleColors, getHandleColor } from "./userHandles.js";

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

function buildPublishedFilter({ includeUnpublished = false, alias = "p" } = {}) {
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
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
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
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
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
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
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
  const params = [pageId];
  let query = `SELECT c.id AS legacy_id,
            c.snowflake_id,
            c.author,
            c.body,
            c.created_at,
            c.updated_at,
            c.ip AS raw_ip,
            c.author_is_admin,
            ipr.hash AS ip_hash
       FROM comments c
       LEFT JOIN ip_profiles ipr ON ipr.ip = c.ip
      WHERE c.page_id = ?
        AND c.status = 'approved'
      ORDER BY c.created_at ASC`;

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : null;
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : null;

  if (safeLimit !== null) {
    query += " LIMIT ?";
    params.push(safeLimit);
    if (safeOffset !== null) {
      query += " OFFSET ?";
      params.push(safeOffset);
    }
  } else if (safeOffset !== null) {
    query += " LIMIT -1 OFFSET ?";
    params.push(safeOffset);
  }

  const rows = await all(query, params);
  const handleMap = await resolveHandleColors(rows.map((row) => row.author));
  return rows.map((row) => {
    const ipHash = row.ip_hash || hashIp(row.raw_ip || "");
    const {
      raw_ip: _unusedIp,
      ip_hash: _unusedHash,
      author_is_admin: _unusedAuthorIsAdmin,
      ...rest
    } = row;
    return {
      ...rest,
      isAdminAuthor: Boolean(row.author_is_admin),
      authorRole: getHandleColor(row.author, handleMap),
      ipProfile: ipHash
        ? {
            hash: ipHash,
            shortHash: formatIpProfileLabel(ipHash),
          }
        : null,
    };
  });
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
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
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
