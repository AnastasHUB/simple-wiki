import { Router } from "express";
import { randomUUID } from "crypto";
import {
  get,
  run,
  all,
  randSlugId,
  incrementView,
  savePageFts,
  removePageFts,
} from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { slugify, linkifyInternal } from "../utils/linkify.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
import { listUploads } from "../utils/uploads.js";
import { getClientIp } from "../utils/ip.js";
import { isIpBanned } from "../utils/ipBans.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  fetchRecentPages,
  fetchPaginatedPages,
  fetchPageWithStats,
  fetchPageTags,
  fetchPageComments,
  fetchPagesByTag,
  countPages,
} from "../utils/pageService.js";
import {
  validateCommentSubmission,
  validateCommentBody,
} from "../utils/commentValidation.js";

const r = Router();

r.use(
  asyncHandler(async (req, res, next) => {
    req.clientIp = getClientIp(req);
    if (req.clientIp) {
      const ban = await isIpBanned(req.clientIp, { action: "view" });
      if (ban && ban.scope === "global") {
        return res.status(403).render("banned", { ban });
      }
    }
    next();
  }),
);

const PAGE_SIZE_OPTIONS = [5, 10, 50, 100, 500];
const DEFAULT_PAGE_SIZE = 50;
const RECENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

r.get(
  "/",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const weekAgo = new Date(Date.now() - RECENT_LOOKBACK_MS).toISOString();

    const total = await countPages();
    const requestedSize = parseInt(req.query.size || String(DEFAULT_PAGE_SIZE), 10);
    const size = PAGE_SIZE_OPTIONS.includes(requestedSize)
      ? requestedSize
      : DEFAULT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(total / size));
    let page = parseInt(req.query.page || "1", 10);
    if (Number.isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const offset = (page - 1) * size;

    const [recent, rows] = await Promise.all([
      fetchRecentPages({ ip, since: weekAgo, limit: 3 }),
      fetchPaginatedPages({ ip, limit: size, offset }),
    ]);

    res.render("index", {
      recent,
      rows,
      total,
      page,
      totalPages,
      size,
      sizeOptions: PAGE_SIZE_OPTIONS,
    });
  }),
);

r.get(
  "/lookup/:base",
  asyncHandler(async (req, res) => {
    const row = await get(
      "SELECT slug_id FROM pages WHERE slug_base=? ORDER BY updated_at DESC LIMIT 1",
      [req.params.base],
    );
    if (!row) return res.status(404).send("Page introuvable");
    res.redirect("/wiki/" + row.slug_id);
  }),
);

r.get(
  "/new",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const uploads = await listUploads();
    res.render("edit", { page: null, tags: "", uploads });
  }),
);

r.post(
  "/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { title, content, tags } = req.body;
    const base = slugify(title);
    const slug_id = randSlugId(base);
    const result = await run(
      "INSERT INTO pages(slug_base, slug_id, title, content) VALUES(?,?,?,?)",
      [base, slug_id, title, content],
    );
    const tagNames = await upsertTags(result.lastID, tags);
    await recordRevision(result.lastID, title, content, req.session.user?.id || null);
    await savePageFts({
      id: result.lastID,
      title,
      content,
      slug_id,
      tags: tagNames.join(" "),
    });
    await sendAdminEvent("Page created", {
      user: req.session.user?.username,
      page: { title, slug_id, slug_base: base },
      extra: { tags },
    });
    await sendFeedEvent("Nouvel article", {
      page: { title, slug_id },
      author: req.session.user?.username,
      url: req.protocol + "://" + req.get("host") + "/wiki/" + slug_id,
      tags,
    });
    res.redirect("/wiki/" + slug_id);
  }),
);

r.get(
  "/wiki/:slugid",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const page = await fetchPageWithStats(req.params.slugid, ip);
    if (!page) return res.status(404).send("Page introuvable");

    const tagNames = await fetchPageTags(page.id);
    const tagBan = await isIpBanned(ip, { action: "view", tags: tagNames });
    if (tagBan) {
      return res.status(403).render("banned", { ban: tagBan });
    }

    await incrementView(page.id, ip);
    page.views = Number(page.views || 0) + 1;

    const comments = await fetchPageComments(page.id);
    const commentFeedback = consumeCommentFeedback(req, page.slug_id);
    const ownCommentTokens = collectOwnCommentTokens(
      comments,
      req.session.commentTokens || {},
    );
    const html = linkifyInternal(page.content);

    res.render("page", {
      page,
      html,
      tags: tagNames,
      comments,
      commentFeedback,
      ownCommentTokens,
    });
  }),
);

r.post(
  "/wiki/:slugid/comments",
  asyncHandler(async (req, res) => {
    const page = await get("SELECT id, title, slug_id FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");

    const ip = req.clientIp;
    const tagNames = await fetchPageTags(page.id);
    const ban = await isIpBanned(ip, {
      action: "comment",
      tags: tagNames,
    });
    if (ban) {
      req.session.commentFeedback = {
        slug: page.slug_id,
        errors: [
          "Vous n'êtes pas autorisé à publier des commentaires sur cet article.",
        ],
      };
      return res.redirect(`/wiki/${page.slug_id}#comments`);
    }

    const validation = validateCommentSubmission({
      authorInput: req.body.author,
      bodyInput: req.body.body,
      captchaInput: req.body.captcha,
      honeypotInput: req.body.website,
      lastCommentAt: req.session.lastCommentAt,
      now: Date.now(),
    });

    if (validation.errors.length) {
      req.session.commentFeedback = {
        slug: page.slug_id,
        errors: validation.errors,
        values: { author: validation.author, body: validation.body },
      };
      return res.redirect(`/wiki/${page.slug_id}#comments`);
    }

    const token = randomUUID();
    const commentSnowflake = generateSnowflake();
    const insertResult = await run(
      "INSERT INTO comments(snowflake_id, page_id, author, body, ip, edit_token) VALUES(?,?,?,?,?,?)",
      [
        commentSnowflake,
        page.id,
        validation.author || null,
        validation.body,
        ip || null,
        token,
      ],
    );

    req.session.commentTokens = req.session.commentTokens || {};
    req.session.commentTokens[commentSnowflake] = token;
    if (insertResult?.lastID) {
      req.session.commentTokens[insertResult.lastID] = token;
    }

    req.session.lastCommentAt = validation.now;
    req.session.commentFeedback = {
      slug: page.slug_id,
      success: true,
      message:
        "Merci ! Votre commentaire a été enregistré et sera publié après validation.",
    };

    await sendAdminEvent("Nouveau commentaire", {
      page,
      comment: {
        id: commentSnowflake,
        author: validation.author || "Anonyme",
        preview: validation.body.slice(0, 200),
      },
      user: req.session.user?.username || null,
      extra: {
        ip,
        status: "pending",
      },
    });

    res.redirect(`/wiki/${page.slug_id}#comments`);
  }),
);

r.get(
  "/wiki/:slugid/comments/:commentId/edit",
  asyncHandler(async (req, res) => {
    const comment = await get(
      `SELECT c.id AS legacy_id, c.snowflake_id, c.author, c.body, c.status, c.edit_token, p.slug_id, p.title
        FROM comments c
        JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=? AND p.slug_id=?`,
      [req.params.commentId, req.params.slugid],
    );
    if (!comment) return res.status(404).send("Commentaire introuvable");
    if (!canManageComment(req, comment)) {
      return res.status(403).render("banned", {
        ban: {
          reason: "Vous n'avez pas la permission de modifier ce commentaire.",
        },
      });
    }
    res.render("comment_edit", { comment, pageSlug: req.params.slugid });
  }),
);

r.post(
  "/wiki/:slugid/comments/:commentId/edit",
  asyncHandler(async (req, res) => {
    const comment = await get(
      `SELECT c.id AS legacy_id, c.snowflake_id, c.page_id, c.author, c.body, c.status, c.edit_token, c.ip, p.slug_id, p.title
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=? AND p.slug_id=?`,
      [req.params.commentId, req.params.slugid],
    );
    if (!comment) return res.status(404).send("Commentaire introuvable");
    if (!canManageComment(req, comment)) {
      return res.status(403).render("banned", {
        ban: {
          reason: "Vous n'avez pas la permission de modifier ce commentaire.",
        },
      });
    }

    const author = (req.body.author || "").trim().slice(0, 80);
    const bodyValidation = validateCommentBody(req.body.body);
    if (bodyValidation.errors.length) {
      return res.render("comment_edit", {
        comment: { ...comment, author, body: bodyValidation.body },
        errors: bodyValidation.errors,
        pageSlug: req.params.slugid,
      });
    }

    await run(
      `UPDATE comments
          SET author=?, body=?, status='pending', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      [author || null, bodyValidation.body, comment.legacy_id],
    );
    await sendAdminEvent("Commentaire modifié", {
      page: { title: comment.title, slug_id: comment.slug_id },
      comment: {
        id: comment.snowflake_id,
        author: author || "Anonyme",
        preview: bodyValidation.body.slice(0, 200),
      },
      user: req.session.user?.username || null,
      extra: {
        status: "pending",
        action: "edit",
        ip: comment.ip || null,
      },
    });
    req.session.commentFeedback = {
      slug: comment.slug_id,
      success: true,
      message: "Votre commentaire a été mis à jour et sera revu par un modérateur.",
    };
    res.redirect(`/wiki/${comment.slug_id}#comments`);
  }),
);

r.post(
  "/wiki/:slugid/comments/:commentId/delete",
  asyncHandler(async (req, res) => {
    const comment = await get(
      `SELECT c.id AS legacy_id, c.snowflake_id, c.page_id, c.edit_token, c.ip, p.slug_id, p.title
        FROM comments c
        JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=? AND p.slug_id=?`,
      [req.params.commentId, req.params.slugid],
    );
    if (!comment) return res.status(404).send("Commentaire introuvable");
    if (!canManageComment(req, comment)) {
      return res.status(403).render("banned", {
        ban: {
          reason: "Vous n'avez pas la permission de supprimer ce commentaire.",
        },
      });
    }
    await run("DELETE FROM comments WHERE id=?", [comment.legacy_id]);
    if (req.session.commentTokens) {
      delete req.session.commentTokens[comment.snowflake_id];
    }
    await sendAdminEvent("Commentaire supprimé par auteur", {
      page: { title: comment.title, slug_id: comment.slug_id },
      comment: { id: comment.snowflake_id },
      user: req.session.user?.username || null,
      extra: {
        action: "delete",
        ip: comment.ip || null,
      },
    });
    req.session.commentFeedback = {
      slug: comment.slug_id,
      success: true,
      message: "Votre commentaire a été supprimé.",
    };
    res.redirect(`/wiki/${comment.slug_id}#comments`);
  }),
);

r.post(
  "/wiki/:slugid/like",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const page = await get(
      "SELECT id, slug_id, title, slug_base FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    if (!page) return res.status(404).send("Page introuvable");

    const tagNames = await fetchPageTags(page.id);
    const ban = await isIpBanned(ip, {
      action: "like",
      tags: tagNames,
    });
    if (ban) {
      return res.status(403).render("banned", { ban });
    }

    const exists = await get("SELECT 1 FROM likes WHERE page_id=? AND ip=?", [
      page.id,
      ip,
    ]);
    if (exists) {
      await run("DELETE FROM likes WHERE page_id=? AND ip=?", [page.id, ip]);
      await sendAdminEvent("Like removed", {
        user: req.session.user?.username,
        page,
        extra: { ip },
      });
    } else {
      await run("INSERT INTO likes(page_id, ip) VALUES(?,?)", [page.id, ip]);
      await sendAdminEvent("Like added", {
        user: req.session.user?.username,
        page,
        extra: { ip },
      });
    }
    const back = req.get("referer") || "/wiki/" + page.slug_id;
    res.redirect(back);
  }),
);

r.get(
  "/edit/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get("SELECT * FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");
    const tagNames = await fetchPageTags(page.id);
    const uploads = await listUploads();
    res.render("edit", {
      page,
      tags: tagNames.join(", "),
      uploads,
    });
  }),
);

r.post(
  "/edit/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { title, content, tags } = req.body;
    const page = await get("SELECT * FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");

    await recordRevision(page.id, page.title, page.content, req.session.user?.id || null);
    const base = slugify(title);
    await run(
      "UPDATE pages SET title=?, content=?, slug_base=?, updated_at=CURRENT_TIMESTAMP WHERE slug_id=?",
      [title, content, base, req.params.slugid],
    );
    await run("DELETE FROM page_tags WHERE page_id=?", [page.id]);
    const tagNames = await upsertTags(page.id, tags);
    await recordRevision(page.id, title, content, req.session.user?.id || null);
    await savePageFts({
      id: page.id,
      title,
      content,
      slug_id: page.slug_id,
      tags: tagNames.join(" "),
    });
    await sendAdminEvent("Page updated", {
      user: req.session.user?.username,
      page: { title, slug_id: req.params.slugid, slug_base: base },
      extra: { tags },
    });
    res.redirect("/wiki/" + req.params.slugid);
  }),
);

r.delete(
  "/delete/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
    if (page?.id) {
      await removePageFts(page.id);
    }
    await sendAdminEvent("Page deleted", {
      user: req.session.user?.username,
      page,
    });
    res.redirect("/");
  }),
);

r.post(
  "/delete/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
    if (page?.id) {
      await removePageFts(page.id);
    }
    await sendAdminEvent("Page deleted", {
      user: req.session.user?.username,
      page,
    });
    res.redirect("/");
  }),
);

r.get(
  "/tags/:name",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const tagName = req.params.name.toLowerCase();
    const tagBan = await isIpBanned(ip, {
      action: "view",
      tags: [tagName],
    });
    if (tagBan) {
      return res.status(403).render("banned", { ban: tagBan });
    }
    const pages = await fetchPagesByTag({ tagName: req.params.name, ip });
    res.render("tags", { tag: req.params.name, pages });
  }),
);

r.get(
  "/wiki/:slugid/history",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get("SELECT id, title, slug_id FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");
    const revisions = await all(
      `SELECT pr.revision, pr.title, pr.created_at, u.username AS author
       FROM page_revisions pr
       LEFT JOIN users u ON u.id = pr.author_id
      WHERE pr.page_id=?
      ORDER BY pr.revision DESC`,
      [page.id],
    );
    res.render("history", { page, revisions });
  }),
);

r.get(
  "/wiki/:slugid/revisions/:revisionId",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get("SELECT * FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");
    const revNumber = parseInt(req.params.revisionId, 10);
    if (Number.isNaN(revNumber)) return res.status(400).send("Révision invalide");
    const revision = await get(
      `SELECT pr.*, u.username AS author
       FROM page_revisions pr
       LEFT JOIN users u ON u.id = pr.author_id
      WHERE pr.page_id=? AND pr.revision=?`,
      [page.id, revNumber],
    );
    if (!revision) return res.status(404).send("Révision introuvable");
    const html = linkifyInternal(revision.content);
    res.render("revision", { page, revision, html });
  }),
);

async function upsertTags(pageId, csv = "") {
  const names = Array.from(
    new Set(
      csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    ),
  );
  for (const n of names) {
    await run("INSERT OR IGNORE INTO tags(name) VALUES(?)", [n]);
    const tag = await get("SELECT id FROM tags WHERE name=?", [n]);
    await run("INSERT OR IGNORE INTO page_tags(page_id, tag_id) VALUES(?,?)", [
      pageId,
      tag.id,
    ]);
  }
  return names;
}

async function recordRevision(pageId, title, content, authorId = null) {
  const row = await get(
    "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM page_revisions WHERE page_id=?",
    [pageId],
  );
  const next = row?.next || 1;
  await run(
    "INSERT INTO page_revisions(page_id, revision, title, content, author_id) VALUES(?,?,?,?,?)",
    [pageId, next, title, content, authorId],
  );
  return next;
}

function canManageComment(req, comment) {
  if (req.session.user?.is_admin) return true;
  const tokens = req.session.commentTokens || {};
  if (!comment?.edit_token) return false;
  if (comment?.snowflake_id && tokens[comment.snowflake_id]) {
    return tokens[comment.snowflake_id] === comment.edit_token;
  }
  if (comment?.legacy_id && tokens[comment.legacy_id]) {
    const legacyToken = tokens[comment.legacy_id];
    if (comment?.snowflake_id) {
      tokens[comment.snowflake_id] = legacyToken;
      delete tokens[comment.legacy_id];
    }
    return legacyToken === comment.edit_token;
  }
  return false;
}

function collectOwnCommentTokens(comments, tokens) {
  const ownTokens = {};
  if (!tokens) {
    return ownTokens;
  }
  for (const comment of comments) {
    if (!comment?.snowflake_id) continue;
    if (tokens[comment.snowflake_id]) {
      ownTokens[comment.snowflake_id] = tokens[comment.snowflake_id];
      continue;
    }
    if (comment?.legacy_id && tokens[comment.legacy_id]) {
      const token = tokens[comment.legacy_id];
      ownTokens[comment.snowflake_id] = token;
      tokens[comment.snowflake_id] = token;
      delete tokens[comment.legacy_id];
    }
  }
  return ownTokens;
}

function consumeCommentFeedback(req, slugId) {
  const feedback = req.session.commentFeedback;
  if (!feedback || feedback.slug !== slugId) {
    return null;
  }
  delete req.session.commentFeedback;
  return feedback;
}

export default r;
