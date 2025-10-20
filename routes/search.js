import { Router } from "express";
import { all, get, isFtsAvailable } from "../db.js";
import { buildPreviewHtml } from "../utils/htmlPreview.js";
import { buildPaginationView } from "../utils/pagination.js";
import {
  buildPublishedFilter,
  buildPageVisibilityClause,
  buildTagVisibilityClause,
} from "../utils/pageService.js";
import { collectAccessibleRoleSnowflakes } from "../utils/roleVisibility.js";

const r = Router();

const SEARCH_PAGE_SIZE_OPTIONS = [5, 10, 25, 50];
const SEARCH_DEFAULT_PAGE_SIZE = 10;
const DEFAULT_SORT_KEY = "relevance";
const TAG_VALIDATION_PATTERN = /^[\p{L}\p{N}\s._-]+$/u;

const SORT_DEFINITIONS = {
  relevance: {
    label: "Pertinence",
    orderBy: (mode) =>
      mode === "fts"
        ?
          "score ASC, p.publish_at DESC, p.updated_at DESC, p.created_at DESC, p.slug_id ASC"
        : "p.updated_at DESC, p.publish_at DESC, p.created_at DESC, p.slug_id ASC",
  },
  published_desc: {
    label: "Plus récents (publication)",
    orderBy:
      "CASE WHEN p.publish_at IS NULL THEN 1 ELSE 0 END, p.publish_at DESC, p.updated_at DESC, p.created_at DESC, p.slug_id ASC",
  },
  published_asc: {
    label: "Plus anciens (publication)",
    orderBy:
      "CASE WHEN p.publish_at IS NULL THEN 1 ELSE 0 END, p.publish_at ASC, p.updated_at ASC, p.created_at ASC, p.slug_id ASC",
  },
  updated_desc: {
    label: "Mises à jour récentes",
    orderBy:
      "p.updated_at DESC, p.publish_at DESC, p.created_at DESC, p.slug_id ASC",
  },
  updated_asc: {
    label: "Mises à jour anciennes",
    orderBy:
      "p.updated_at ASC, p.publish_at ASC, p.created_at ASC, p.slug_id ASC",
  },
  title_asc: {
    label: "Titre A → Z",
    orderBy: "p.title COLLATE NOCASE ASC, p.slug_id ASC",
  },
  title_desc: {
    label: "Titre Z → A",
    orderBy: "p.title COLLATE NOCASE DESC, p.slug_id DESC",
  },
};

const SORT_OPTIONS = Object.entries(SORT_DEFINITIONS).map(([value, definition]) => ({
  value,
  label: definition.label,
}));

r.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.redirect("/");

  const permissions = req.permissionFlags || {};
  const allowedRoleSnowflakes = permissions.is_admin
    ? null
    : collectAccessibleRoleSnowflakes(req.session?.user || null);
  const filters = parseSearchFilters(req.query);
  const filterSql = buildFilterSql(filters, { allowedRoleSnowflakes });
  const filterClause = filterSql.whereClauses.length
    ? ` AND ${filterSql.whereClauses.join(" AND ")}`
    : "";
  const filterParams = filterSql.params;
  const visibility = buildPublishedFilter({ alias: "p" });
  const visibilityClause =
    visibility.clause && visibility.clause !== "1=1"
      ? ` AND ${visibility.clause}`
      : "";
  const visibilityParams =
    visibility.clause && visibility.clause !== "1=1"
      ? visibility.params ?? []
      : [];
  const pageAccess = buildPageVisibilityClause({
    alias: "p",
    allowedRoleSnowflakes,
  });
  const pageAccessClause =
    pageAccess.clause && pageAccess.clause !== "1=1"
      ? ` AND ${pageAccess.clause}`
      : "";
  const pageAccessParams =
    pageAccess.clause && pageAccess.clause !== "1=1"
      ? pageAccess.params ?? []
      : [];

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
        `
        SELECT COUNT(*) AS total
          FROM pages_fts
          JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ?
           ${visibilityClause}
           ${pageAccessClause}
          ${filterClause}
        `,
        [
          matchQuery,
          ...visibilityParams,
          ...pageAccessParams,
          ...filterParams,
        ],
      );
      pagination = buildPaginationView(
        req,
        Number(totalRow?.total ?? 0),
        paginationOptions,
      );
      const offset = (pagination.page - 1) * pagination.perPage;
      const orderClause = resolveOrderClause(filters.sortKey, mode);
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
          ${visibilityClause}
          ${pageAccessClause}
          ${filterClause}
        ORDER BY ${orderClause}
        LIMIT ? OFFSET ?
      `,
      [
        matchQuery,
        ...visibilityParams,
        ...pageAccessParams,
        ...filterParams,
        pagination.perPage,
        offset,
      ],
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
      WHERE (p.title   LIKE '%'||?||'%'
         OR p.content LIKE '%'||?||'%'
         OR t.name    LIKE '%'||?||'%')
        ${visibilityClause}
        ${pageAccessClause}
        ${filterClause}
    `,
      [q, q, q, ...visibilityParams, ...pageAccessParams, ...filterParams],
    );
    pagination = buildPaginationView(
      req,
      Number(fallbackCountRow?.total ?? 0),
      paginationOptions,
    );
    const offset = (pagination.page - 1) * pagination.perPage;
    const orderClause = resolveOrderClause(filters.sortKey, mode);
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
      WHERE (p.title   LIKE '%'||?||'%'
         OR p.content LIKE '%'||?||'%'
         OR t.name    LIKE '%'||?||'%')
        ${visibilityClause}
        ${pageAccessClause}
        ${filterClause}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `,
    [
      q,
      q,
      q,
      ...visibilityParams,
      ...pageAccessParams,
      ...filterParams,
      pagination.perPage,
      offset,
    ],
    );
    rows = fallbackRows.map((row) => ({ ...row, snippet: null, score: null }));
  }

const decoratedRows = rows.map((row) => ({
  ...row,
  excerpt: buildPreviewHtml(row.excerpt),
  snippet: row.snippet ? buildPreviewHtml(row.snippet) : null,
}));

  const total = pagination.totalItems;

  const tagListAccess = buildTagVisibilityClause({
    alias: "t",
    allowedRoleSnowflakes,
  });
  const tagListClause =
    tagListAccess.clause && tagListAccess.clause !== "1=1"
      ? ` WHERE ${tagListAccess.clause}`
      : "";
  const tagListParams =
    tagListAccess.clause && tagListAccess.clause !== "1=1"
      ? tagListAccess.params ?? []
      : [];
  const availableTagsRows = await all(
    `SELECT name FROM tags t${tagListClause} ORDER BY name COLLATE NOCASE ASC`,
    tagListParams,
  );
  const availableTagNames = availableTagsRows.map((row) => row.name);
  const filtersForView = buildFiltersViewModel(filters, {
    availableTagNames,
    query: q,
  });

  
  res.render("search", {
    q,
    rows: decoratedRows,
    mode,
    ftsAvailable: ftsPossible,
    pagination,
    total,
    filters: filtersForView,
    sortOptions: SORT_OPTIONS,
    availableTags: availableTagNames,
  });
});

export default r;

function parseSearchFilters(query = {}) {
  const filters = {
    tags: [],
    normalizedTags: [],
    author: "",
    authorQuery: null,
    startDate: null,
    endDate: null,
    sortKey: DEFAULT_SORT_KEY,
  };

  const rawTags = toArray(query.tag).map((value) => String(value ?? "").trim());
  const normalizedSet = new Set();
  for (const tag of rawTags) {
    if (!tag || tag.length > 50) continue;
    if (!TAG_VALIDATION_PATTERN.test(tag)) continue;
    const normalized = tag.toLowerCase();
    if (normalizedSet.has(normalized)) continue;
    normalizedSet.add(normalized);
    filters.tags.push(tag);
    filters.normalizedTags.push(normalized);
  }

  const author = String(query.author ?? "").trim();
  if (author && author.length <= 120) {
    filters.author = author;
    filters.authorQuery = author.toLowerCase();
  }

  let startDate = parseDateParameter(query.start);
  let endDate = parseDateParameter(query.end);
  if (startDate && endDate && startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }
  filters.startDate = startDate;
  filters.endDate = endDate;

  const sortRaw = String(query.sort ?? "").trim().toLowerCase();
  if (sortRaw && SORT_DEFINITIONS[sortRaw]) {
    filters.sortKey = sortRaw;
  }

  return filters;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function parseDateParameter(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return value;
}

function buildFilterSql(filters, { allowedRoleSnowflakes } = {}) {
  const whereClauses = [];
  const params = [];

  if (filters.authorQuery) {
    whereClauses.push("LOWER(IFNULL(p.author, '')) = ?");
    params.push(filters.authorQuery);
  }

  if (filters.startDate) {
    whereClauses.push(
      "p.publish_at IS NOT NULL AND date(p.publish_at) >= date(?)",
    );
    params.push(filters.startDate);
  }

  if (filters.endDate) {
    whereClauses.push(
      "p.publish_at IS NOT NULL AND date(p.publish_at) <= date(?)",
    );
    params.push(filters.endDate);
  }

  if (filters.normalizedTags.length) {
    const placeholders = filters.normalizedTags.map(() => "?").join(", ");
    const tagAccess = buildTagVisibilityClause({
      alias: "t",
      allowedRoleSnowflakes,
    });
    const tagAccessClause =
      tagAccess.clause && tagAccess.clause !== "1=1"
        ? ` AND ${tagAccess.clause}`
        : "";
    whereClauses.push(`p.id IN (
      SELECT pt.page_id
      FROM page_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE LOWER(t.name) IN (${placeholders})
        ${tagAccessClause}
      GROUP BY pt.page_id
      HAVING COUNT(DISTINCT t.id) = ${filters.normalizedTags.length}
    )`);
    params.push(...filters.normalizedTags);
    if (tagAccessClause) {
      params.push(...(tagAccess.params ?? []));
    }
  }

  return { whereClauses, params };
}

function resolveOrderClause(sortKey, mode) {
  const definition = SORT_DEFINITIONS[sortKey] || SORT_DEFINITIONS[DEFAULT_SORT_KEY];
  const orderBy =
    typeof definition.orderBy === "function"
      ? definition.orderBy(mode)
      : definition.orderBy;
  return orderBy;
}

function buildFiltersViewModel(filters, { availableTagNames, query }) {
  const normalizedToName = new Map();
  for (const tagName of availableTagNames) {
    normalizedToName.set(tagName.toLowerCase(), tagName);
  }

  const displayTags = [];
  const seen = new Set();
  filters.normalizedTags.forEach((normalized, index) => {
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const resolved = normalizedToName.get(normalized);
    const fallbackValue = filters.tags[index] ||
      filters.tags.find((value) => value.toLowerCase() === normalized) ||
      normalized;
    displayTags.push({
      label: resolved || fallbackValue,
      value: resolved || fallbackValue,
    });
  });

  const hasActiveFilters =
    filters.normalizedTags.length > 0 ||
    Boolean(filters.author) ||
    Boolean(filters.startDate) ||
    Boolean(filters.endDate) ||
    filters.sortKey !== DEFAULT_SORT_KEY;

  return {
    author: filters.author,
    startDate: filters.startDate,
    endDate: filters.endDate,
    sortKey: filters.sortKey,
    selectedTagKeys: filters.normalizedTags,
    displayTags,
    hasActiveFilters,
    resetUrl: buildResetUrl(query),
  };
}

function buildResetUrl(query) {
  const params = new URLSearchParams();
  params.set("q", query);
  return `/search?${params.toString()}`;
}

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
