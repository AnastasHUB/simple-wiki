import { all, get } from "../db.js";

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

export async function fetchRecentPages({
  ip,
  since,
  limit = 3,
  excerptLength = 900,
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  return all(
    `
    SELECT p.id,
           p.title,
           p.slug_id,
           substr(p.content, 1, ${excerpt}) AS excerpt,
           p.created_at,
           ${TAGS_CSV_SUBQUERY} AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     WHERE p.created_at >= ?
     ORDER BY p.created_at DESC
     LIMIT ?
  `,
    [ip, since, limit],
  );
}

export async function fetchPaginatedPages({
  ip,
  limit,
  offset,
  excerptLength = 1200,
}) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  return all(
    `
    SELECT p.id,
           p.title,
           p.slug_id,
           substr(p.content, 1, ${excerpt}) AS excerpt,
           p.created_at,
           ${TAGS_CSV_SUBQUERY} AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     ORDER BY p.created_at DESC
     LIMIT ? OFFSET ?
  `,
    [ip, limit, offset],
  );
}

export async function fetchPageWithStats(slugId, ip) {
  return get(
    `
    SELECT p.*,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id = p.id AND ip = ?) AS userLiked,
           COALESCE((SELECT COUNT(*) FROM comments WHERE page_id = p.id AND status = 'approved'), 0) AS comment_count,
           ${VIEW_COUNT_SELECT} AS views
      FROM pages p
     WHERE slug_id = ?
  `,
    [ip, slugId],
  );
}

export async function fetchPageTags(pageId) {
  const rows = await all(
    `SELECT name FROM tags t JOIN page_tags pt ON t.id = pt.tag_id WHERE pt.page_id = ? ORDER BY name`,
    [pageId],
  );
  return rows.map((row) => row.name);
}

export async function fetchPageComments(pageId) {
  return all(
    `SELECT id AS legacy_id,
            snowflake_id,
            author,
            body,
            created_at,
            updated_at
       FROM comments
      WHERE page_id = ?
        AND status = 'approved'
      ORDER BY created_at ASC`,
    [pageId],
  );
}

export async function fetchPagesByTag({ tagName, ip, excerptLength = 1200 }) {
  const excerpt = Math.max(1, Math.trunc(excerptLength));
  return all(
    `
    SELECT p.id,
           p.title,
           p.slug_id,
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
     ORDER BY p.updated_at DESC
  `,
    [ip, tagName],
  );
}

export async function countPages() {
  const row = await get(`SELECT COUNT(*) AS total FROM pages`);
  return row?.total || 0;
}
