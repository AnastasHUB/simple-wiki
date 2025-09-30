import { Router } from "express";
import { all, get, isFtsAvailable } from "../db.js";
import { buildPreviewHtml } from "../utils/htmlPreview.js";
import { buildPaginationView } from "../utils/pagination.js";

const r = Router();

const SEARCH_PAGE_SIZE_OPTIONS = [5, 10, 25, 50];
const SEARCH_DEFAULT_PAGE_SIZE = 10;

r.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.redirect("/");

  const ftsPossible = isFtsAvailable();
  let mode = "fts";
  let rows = [];

  const paginationOptions = {
    pageParam: "page",
    perPageParam: "size",
    defaultPageSize: SEARCH_DEFAULT_PAGE_SIZE,
    pageSizeOptions: SEARCH_PAGE_SIZE_OPTIONS,
  };
  let pagination = buildPaginationView(req, 0, paginationOptions);

  const tokens = tokenize(q);
  if (ftsPossible && tokens.length) {
    const matchQuery = tokens.map((t) => `${t}*`).join(" AND ");
    try {
      const totalRow = await get(
        `SELECT COUNT(*) AS total FROM pages_fts WHERE pages_fts MATCH ?`,
        [matchQuery],
      );
      pagination = buildPaginationView(
        req,
        Number(totalRow?.total ?? 0),
        paginationOptions,
      );
      const offset = (pagination.page - 1) * pagination.perPage;
      const ftsRows = await all(
        `
        SELECT
          p.slug_id,
          p.title,
          substr(p.content, 1, 400) AS excerpt,
          bm25(pages_fts) AS score,
          snippet(pages_fts, 'content', '<mark>', '</mark>', '…', 20) AS contentSnippet,
          snippet(pages_fts, 'tags', '<mark>', '</mark>', '…', 10) AS tagsSnippet,
          (
            SELECT GROUP_CONCAT(t2.name, ',')
            FROM tags t2
            JOIN page_tags pt2 ON pt2.tag_id = t2.id
            WHERE pt2.page_id = p.id
          ) AS tagsCsv
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.rowid
        WHERE pages_fts MATCH ?
        ORDER BY score ASC, p.updated_at DESC, p.created_at DESC
        LIMIT ? OFFSET ?
      `,
        [matchQuery, pagination.perPage, offset],
      );
      rows = ftsRows.map((row) => {
        const numericScore = Number(row.score);
        return {
          ...row,
          snippet: chooseSnippet(row),
          score: Number.isFinite(numericScore) ? numericScore : null,
        };
      });
    } catch (err) {
      console.warn("FTS search failed, falling back to LIKE", err);
      mode = "basic";
    }
  } else {
    mode = "basic";
  }

  if (mode === "basic") {
    const fallbackCountRow = await get(
      `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM pages p
      LEFT JOIN page_tags pt ON pt.page_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.title   LIKE '%'||?||'%'
         OR p.content LIKE '%'||?||'%'
         OR t.name    LIKE '%'||?||'%'
    `,
      [q, q, q],
    );
    pagination = buildPaginationView(
      req,
      Number(fallbackCountRow?.total ?? 0),
      paginationOptions,
    );
    const offset = (pagination.page - 1) * pagination.perPage;
    const fallbackRows = await all(
      `
      SELECT DISTINCT
        p.title,
        p.slug_id,
        substr(p.content, 1, 400) AS excerpt,
        (
          SELECT GROUP_CONCAT(t2.name, ',')
          FROM tags t2
          JOIN page_tags pt2 ON pt2.tag_id = t2.id
          WHERE pt2.page_id = p.id
        ) AS tagsCsv
      FROM pages p
      LEFT JOIN page_tags pt ON pt.page_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.title   LIKE '%'||?||'%'
         OR p.content LIKE '%'||?||'%'
         OR t.name    LIKE '%'||?||'%'
      ORDER BY p.updated_at DESC, p.created_at DESC
      LIMIT ? OFFSET ?
    `,
      [q, q, q, pagination.perPage, offset],
    );
    rows = fallbackRows.map((row) => ({ ...row, snippet: null, score: null }));
  }

  const decoratedRows = rows.map((row) => ({
    ...row,
    excerpt: buildPreviewHtml(row.excerpt),
    snippet: row.snippet ? buildPreviewHtml(row.snippet) : null,
  }));

  const total = pagination.totalItems;

  res.render("search", {
    q,
    rows: decoratedRows,
    mode,
    ftsAvailable: ftsPossible,
    pagination,
    total,
  });
});

export default r;

function tokenize(input) {
  return input
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => term.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

function chooseSnippet(row) {
  const snippets = [row.contentSnippet, row.tagsSnippet];
  for (const s of snippets) {
    if (s && s.trim()) {
      return s;
    }
  }
  return row.excerpt || "";
}
