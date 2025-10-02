import { all, get, run } from "../db.js";
import { normalizeTagInput } from "./pageEditing.js";
import { generateSnowflake } from "./snowflake.js";
import { resolveHandleColors, getHandleColor } from "./userHandles.js";

export async function createPageSubmission({
  type,
  pageId = null,
  title,
  content,
  tags = "",
  ip = null,
  submittedBy = null,
  targetSlugId = null,
  authorName = null,
}) {
  if (!type || !title || !content) {
    throw new Error("Invalid submission payload");
  }

  const normalizedType = type === "edit" ? "edit" : "create";
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO page_submissions(
      snowflake_id, page_id, target_slug_id, type, title, content, tags, ip, submitted_by, author_name
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      snowflake,
      pageId || null,
      targetSlugId || null,
      normalizedType,
      title,
      content,
      typeof tags === "string" ? tags : normalizeTagInput(tags).join(", "),
      ip || null,
      submittedBy || null,
      authorName || null,
    ],
  );
  return snowflake;
}

export async function getPageSubmissionById(id) {
  if (!id) {
    return null;
  }

  const submission = await get(
    `SELECT ps.*, p.title AS current_title, p.slug_id AS current_slug,
            r.username AS reviewer_username
       FROM page_submissions ps
       LEFT JOIN pages p ON p.id = ps.page_id
       LEFT JOIN users r ON r.id = ps.reviewer_id
      WHERE ps.snowflake_id=?`,
    [id],
  );
  if (!submission) {
    return null;
  }
  const handleMap = await resolveHandleColors([
    submission.submitted_by,
    submission.author_name,
    submission.reviewer_username,
  ]);
  return {
    ...submission,
    submittedByRole: getHandleColor(submission.submitted_by, handleMap),
    authorNameRole: getHandleColor(submission.author_name, handleMap),
    reviewerRole: getHandleColor(submission.reviewer_username, handleMap),
  };
}

function applySubmissionSearch(filters, params, search) {
  if (!search) {
    return;
  }
  const like = `%${search}%`;
  filters.push(
    "(ps.snowflake_id LIKE ? OR ps.ip LIKE ? OR ps.title LIKE ? OR ps.target_slug_id LIKE ? OR COALESCE(p.slug_id, '') LIKE ? OR COALESCE(p.title, '') LIKE ? OR COALESCE(ps.submitted_by, '') LIKE ?)",
  );
  params.push(like, like, like, like, like, like, like);
}

function applySubmissionIdentityFilter(
  filters,
  params,
  { submittedBy = null, ip = null } = {},
) {
  const normalizedSubmittedBy =
    typeof submittedBy === "string" && submittedBy.trim()
      ? submittedBy.trim()
      : null;
  const normalizedIp = typeof ip === "string" && ip.trim() ? ip.trim() : null;

  if (normalizedSubmittedBy && normalizedIp) {
    filters.push("(ps.submitted_by=? OR ps.ip=?)");
    params.push(normalizedSubmittedBy, normalizedIp);
  } else if (normalizedSubmittedBy) {
    filters.push("ps.submitted_by=?");
    params.push(normalizedSubmittedBy);
  } else if (normalizedIp) {
    filters.push("ps.ip=?");
    params.push(normalizedIp);
  }
}

export async function countPageSubmissions({
  status = null,
  search = null,
  submittedBy = null,
  ip = null,
} = {}) {
  const filters = [];
  const params = [];

  if (typeof status === "string" && status) {
    filters.push("ps.status=?");
    params.push(status);
  } else if (Array.isArray(status) && status.length) {
    const placeholders = status.map(() => "?").join(",");
    filters.push(`ps.status IN (${placeholders})`);
    params.push(...status);
  }

  applySubmissionSearch(filters, params, search);
  applySubmissionIdentityFilter(filters, params, { submittedBy, ip });

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const row = await get(
    `SELECT COUNT(*) AS total
       FROM page_submissions ps
       LEFT JOIN pages p ON p.id = ps.page_id
      ${where}`,
    params,
  );
  return Number(row?.total ?? 0);
}

export async function fetchPageSubmissions({
  status = null,
  limit = 50,
  offset = 0,
  orderBy = "created_at",
  direction = "DESC",
  search = null,
  submittedBy = null,
  ip = null,
} = {}) {
  const allowedOrder = new Set(["created_at", "reviewed_at", "title", "type"]);
  const safeOrder = allowedOrder.has(orderBy) ? orderBy : "created_at";
  const safeDirection = direction === "ASC" ? "ASC" : "DESC";

  const whereClauses = [];
  const params = [];
  if (typeof status === "string" && status) {
    whereClauses.push("ps.status=?");
    params.push(status);
  } else if (Array.isArray(status) && status.length) {
    const placeholders = status.map(() => "?").join(",");
    whereClauses.push(`ps.status IN (${placeholders})`);
    params.push(...status);
  }

  applySubmissionSearch(whereClauses, params, search);
  applySubmissionIdentityFilter(whereClauses, params, { submittedBy, ip });

  const where = whereClauses.length
    ? `WHERE ${whereClauses.join(" AND ")}`
    : "";

  const rows = await all(
    `SELECT ps.*, p.title AS current_title, p.slug_id AS current_slug,
            r.username AS reviewer_username
       FROM page_submissions ps
       LEFT JOIN pages p ON p.id = ps.page_id
       LEFT JOIN users r ON r.id = ps.reviewer_id
       ${where}
      ORDER BY ps.${safeOrder} ${safeDirection}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const handleMap = await resolveHandleColors([
    ...rows.map((row) => row.submitted_by),
    ...rows.map((row) => row.author_name),
    ...rows.map((row) => row.reviewer_username),
  ]);
  return rows.map((row) => ({
    ...row,
    submittedByRole: getHandleColor(row.submitted_by, handleMap),
    authorNameRole: getHandleColor(row.author_name, handleMap),
    reviewerRole: getHandleColor(row.reviewer_username, handleMap),
  }));
}

export async function updatePageSubmissionStatus(
  id,
  {
    status,
    reviewerId = null,
    reviewNote = null,
    pageId = null,
    resultSlugId = null,
    targetSlugId = null,
  } = {},
) {
  if (!id || !status) {
    return false;
  }

  const allowed = new Set(["approved", "rejected"]);
  if (!allowed.has(status)) {
    throw new Error("Invalid submission status");
  }

  const result = await run(
    `UPDATE page_submissions
        SET status=?, reviewer_id=?, review_note=?, reviewed_at=CURRENT_TIMESTAMP,
            page_id=COALESCE(?, page_id), result_slug_id=COALESCE(?, result_slug_id),
            target_slug_id=COALESCE(?, target_slug_id)
      WHERE snowflake_id=? AND status='pending'`,
    [
      status,
      reviewerId || null,
      reviewNote || null,
      pageId || null,
      resultSlugId || null,
      targetSlugId || null,
      id,
    ],
  );
  return result?.changes > 0;
}

export function mapSubmissionTags(submission) {
  if (!submission) {
    return [];
  }
  return normalizeTagInput(submission.tags || "");
}
