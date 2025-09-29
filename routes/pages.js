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
import { pushNotification } from "../utils/notifications.js";
import { upsertTags, recordRevision } from "../utils/pageEditing.js";
import { createPageSubmission } from "../utils/pageSubmissionService.js";
import {
  getIpProfileByHash,
  hashIp,
  touchIpProfile,
} from "../utils/ipProfiles.js";
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
import { buildPreviewHtml } from "../utils/htmlPreview.js";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  resolvePageSize,
  buildPagination,
  decoratePagination,
} from "../utils/pagination.js";

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

const RECENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

r.get(
  "/",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const weekAgo = new Date(Date.now() - RECENT_LOOKBACK_MS).toISOString();

    const total = await countPages();
    const size = resolvePageSize(req.query.size, DEFAULT_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(total / size));
    let page = parseInt(req.query.page || "1", 10);
    if (Number.isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    const offset = (page - 1) * size;

    const mapPreview = (row) => ({
      ...row,
      excerpt: buildPreviewHtml(row.excerpt),
    });

    const [recentRaw, rowsRaw] = await Promise.all([
      fetchRecentPages({ ip, since: weekAgo, limit: 3 }),
      fetchPaginatedPages({ ip, limit: size, offset }),
    ]);
    const recent = recentRaw.map(mapPreview);
    const rows = rowsRaw.map(mapPreview);

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
    const requested = (req.params.base || "").trim();
    if (!requested) {
      return res.status(404).send("Page introuvable");
    }

    const normalized = slugify(requested);
    if (!normalized) {
      return res.status(404).send("Page introuvable");
    }

    const byBase = await get(
      "SELECT slug_id FROM pages WHERE slug_base=? ORDER BY updated_at DESC LIMIT 1",
      [normalized],
    );
    if (byBase?.slug_id) {
      return res.redirect("/wiki/" + byBase.slug_id);
    }

    const direct = await get(
      "SELECT slug_id FROM pages WHERE slug_id=? LIMIT 1",
      [normalized],
    );
    if (direct?.slug_id) {
      return res.redirect("/wiki/" + direct.slug_id);
    }

    const prefixed = await get(
      "SELECT slug_id FROM pages WHERE slug_id LIKE ? ORDER BY updated_at DESC LIMIT 1",
      [normalized + "-%"],
    );
    if (prefixed?.slug_id) {
      return res.redirect("/wiki/" + prefixed.slug_id);
    }

    res.status(404).send("Page introuvable");
  }),
);

r.get(
  "/new",
  asyncHandler(async (req, res) => {
    const isAdmin = Boolean(req.session.user?.is_admin);
    if (!isAdmin) {
      const ban = await isIpBanned(req.clientIp, { action: "contribute" });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const uploads = isAdmin ? await listUploads() : [];
    res.render("edit", {
      page: null,
      tags: "",
      uploads,
      submissionMode: !isAdmin,
      allowUploads: isAdmin,
    });
  }),
);

r.post(
  "/new",
  asyncHandler(async (req, res) => {
    const { title, content, tags } = req.body;
    const isAdmin = Boolean(req.session.user?.is_admin);
    if (!isAdmin) {
      const ban = await isIpBanned(req.clientIp, { action: "contribute" });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
      const submissionId = await createPageSubmission({
        type: "create",
        title,
        content,
        tags,
        ip: req.clientIp,
        submittedBy: req.session.user?.username || null,
      });
      await touchIpProfile(req.clientIp);
      pushNotification(req, {
        type: "success",
        message: "Merci ! Votre proposition sera examinée par un administrateur.",
        timeout: 6000,
      });
      await sendAdminEvent("Soumission de nouvelle page", {
        page: { title },
        user: req.session.user?.username || null,
        extra: {
          ip: req.clientIp || null,
          submission: submissionId,
          status: "pending",
        },
      });
      return res.redirect("/");
    }

    const base = slugify(title);
    const slug_id = randSlugId(base);
    const pageSnowflake = generateSnowflake();
    const result = await run(
      "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content) VALUES(?,?,?,?,?)",
      [pageSnowflake, base, slug_id, title, content],
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
      page: { title, slug_id, slug_base: base, snowflake_id: pageSnowflake },
      extra: { tags },
    });
    await sendFeedEvent(
      "Nouvel article",
      {
        page: { title, slug_id, snowflake_id: pageSnowflake },
        author: req.session.user?.username,
        url: req.protocol + "://" + req.get("host") + "/wiki/" + slug_id,
        tags,
      },
      { articleContent: content },
    );
    pushNotification(req, {
      type: "success",
      message: `"${title}" a été créé avec succès !`,
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
    await touchIpProfile(ip);

    const totalComments = Number(page.comment_count || 0);
    const commentPaginationOptions = {
      pageParam: "commentsPage",
      perPageParam: "commentsPerPage",
      defaultPageSize: 10,
      pageSizeOptions: [5, 10, 20, 50],
    };
    let commentPagination = buildPagination(
      req,
      totalComments,
      commentPaginationOptions,
    );
    if (
      totalComments > 0 &&
      !Object.prototype.hasOwnProperty.call(req.query, "commentsPage")
    ) {
      const pageNumber = commentPagination.totalPages;
      const hasPrevious = pageNumber > 1;
      commentPagination = {
        ...commentPagination,
        page: pageNumber,
        hasPrevious,
        hasNext: false,
        previousPage: hasPrevious ? pageNumber - 1 : null,
        nextPage: null,
      };
    }
    const commentOffset =
      (commentPagination.page - 1) * commentPagination.perPage;
    const comments = await fetchPageComments(page.id, {
      limit: commentPagination.perPage,
      offset: commentOffset,
    });
    commentPagination = decoratePagination(
      req,
      commentPagination,
      commentPaginationOptions,
    );
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
      commentPagination,
      commentFeedback,
      ownCommentTokens,
    });
  }),
);

r.post(
  "/wiki/:slugid/comments",
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, snowflake_id, title, slug_id FROM pages WHERE slug_id=?",
      [
        req.params.slugid,
      ],
    );
    if (!page) return res.status(404).send("Page introuvable");

    const ip = req.clientIp;
    const adminDisplayName = req.session.user?.is_admin
      ? getUserDisplayName(req.session.user)
      : null;
    const trimmedAuthorInput = (req.body.author || "").trim().slice(0, 80);
    const trimmedBodyInput = (req.body.body || "").trim();
    const tagNames = await fetchPageTags(page.id);
    const ban = await isIpBanned(ip, {
      action: "comment",
      tags: tagNames,
    });
    if (ban) {
      req.session.commentFeedback = {
        slug: page.slug_id,
        values: {
          author: adminDisplayName || trimmedAuthorInput,
          body: trimmedBodyInput,
        },
      };
      pushNotification(req, {
        type: "error",
        message:
          "Vous n'êtes pas autorisé à publier des commentaires sur cet article.",
        timeout: 6000,
      });
      return res.redirect(`/wiki/${page.slug_id}#comments`);
    }

    const validation = validateCommentSubmission({
      authorInput: req.body.author,
      bodyInput: req.body.body,
      captchaInput: req.body.captcha,
      honeypotInput: req.body.website,
    });

    const authorToUse = adminDisplayName || validation.author;

    if (validation.errors.length) {
      req.session.commentFeedback = {
        slug: page.slug_id,
        values: { author: authorToUse, body: validation.body },
      };
      for (const error of validation.errors) {
        pushNotification(req, {
          type: "error",
          message: error,
          timeout: 6000,
        });
      }
      return res.redirect(`/wiki/${page.slug_id}#comments`);
    }

    const token = randomUUID();
    const commentSnowflake = generateSnowflake();
    const insertResult = await run(
      "INSERT INTO comments(snowflake_id, page_id, author, body, ip, edit_token) VALUES(?,?,?,?,?,?)",
      [
        commentSnowflake,
        page.id,
        authorToUse || null,
        validation.body,
        ip || null,
        token,
      ],
    );

    await touchIpProfile(ip);

    req.session.commentTokens = req.session.commentTokens || {};
    req.session.commentTokens[commentSnowflake] = token;
    if (insertResult?.lastID) {
      req.session.commentTokens[insertResult.lastID] = token;
    }

    delete req.session.commentFeedback;
    pushNotification(req, {
      type: "success",
      message:
        "Merci ! Votre commentaire a été enregistré et sera publié après validation.",
      timeout: 6000,
    });

    await sendAdminEvent("Nouveau commentaire", {
      page,
      comment: {
        id: commentSnowflake,
        author: authorToUse || "Anonyme",
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
      `SELECT c.id AS legacy_id, c.snowflake_id, c.page_id, c.author, c.body, c.status, c.edit_token, c.ip, p.slug_id, p.title, p.snowflake_id AS page_snowflake_id
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
      const inlineNotifications = bodyValidation.errors.map((message) => ({
        id: randomUUID(),
        type: "error",
        message,
        timeout: 6000,
      }));
      return res.render("comment_edit", {
        comment: { ...comment, author, body: bodyValidation.body },
        pageSlug: req.params.slugid,
        notifications: inlineNotifications,
      });
    }

    await run(
      `UPDATE comments
          SET author=?, body=?, status='pending', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      [author || null, bodyValidation.body, comment.legacy_id],
    );
    await sendAdminEvent("Commentaire modifié", {
      page: {
        title: comment.title,
        slug_id: comment.slug_id,
        snowflake_id: comment.page_snowflake_id,
      },
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
    delete req.session.commentFeedback;
    pushNotification(req, {
      type: "success",
      message:
        "Votre commentaire a été mis à jour et sera revu par un modérateur.",
      timeout: 6000,
    });
    res.redirect(`/wiki/${comment.slug_id}#comments`);
  }),
);

r.post(
  "/wiki/:slugid/comments/:commentId/delete",
  asyncHandler(async (req, res) => {
    const comment = await get(
      `SELECT c.id AS legacy_id, c.snowflake_id, c.page_id, c.edit_token, c.ip, p.slug_id, p.title, p.snowflake_id AS page_snowflake_id
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
      page: {
        title: comment.title,
        slug_id: comment.slug_id,
        snowflake_id: comment.page_snowflake_id,
      },
      comment: { id: comment.snowflake_id },
      user: req.session.user?.username || null,
      extra: {
        action: "delete",
        ip: comment.ip || null,
      },
    });
    delete req.session.commentFeedback;
    pushNotification(req, {
      type: "success",
      message: "Votre commentaire a été supprimé.",
      timeout: 5000,
    });
    res.redirect(`/wiki/${comment.slug_id}#comments`);
  }),
);

r.post(
  "/wiki/:slugid/like",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const wantsJson =
      req.get("X-Requested-With") === "XMLHttpRequest" ||
      (req.headers.accept || "").includes("application/json");

      const page = await get(
        "SELECT id, snowflake_id, slug_id, title, slug_base FROM pages WHERE slug_id=?",
        [req.params.slugid],
      );
    if (!page) {
      if (wantsJson) {
        return res.status(404).json({
          ok: false,
          message: "Page introuvable",
        });
      }
      return res.status(404).send("Page introuvable");
    }

    const tagNames = await fetchPageTags(page.id);
    const ban = await isIpBanned(ip, {
      action: "like",
      tags: tagNames,
    });
    if (ban) {
      if (wantsJson) {
        return res.status(403).json({
          ok: false,
          message: ban?.reason
            ? `Action interdite: ${ban.reason}`
            : "Action interdite",
          ban,
        });
      }
      return res.status(403).render("banned", { ban });
    }

    const notifications = [];
    const existingLike = await get(
      "SELECT snowflake_id FROM likes WHERE page_id=? AND ip=?",
      [page.id, ip],
    );

    if (existingLike) {
      await run("DELETE FROM likes WHERE page_id=? AND ip=?", [page.id, ip]);
      await sendAdminEvent("Like removed", {
        user: req.session.user?.username,
        page,
        extra: { ip, likeSnowflake: existingLike.snowflake_id || null },
      });
      notifications.push({
        type: "info",
        message: "Article retiré de vos favoris.",
        timeout: 2500,
      });
      if (!wantsJson) {
        pushNotification(req, notifications[notifications.length - 1]);
      }
    } else {
      const likeSnowflake = generateSnowflake();
      await run("INSERT INTO likes(snowflake_id, page_id, ip) VALUES(?,?,?)", [
        likeSnowflake,
        page.id,
        ip,
      ]);
      await sendAdminEvent("Like added", {
        user: req.session.user?.username,
        page,
        extra: { ip, likeSnowflake },
      });
      notifications.push({
        type: "success",
        message: "Article ajouté à vos favoris.",
        timeout: 3000,
      });
      if (!wantsJson) {
        pushNotification(req, notifications[notifications.length - 1]);
      }
    }

    await touchIpProfile(ip);

    const total = await get("SELECT COUNT(*) AS totalLikes FROM likes WHERE page_id=?", [
      page.id,
    ]);
    const likeCount = total?.totalLikes || 0;

    if (wantsJson) {
      return res.json({
        ok: true,
        liked: !existingLike,
        likes: likeCount,
        slug: page.slug_id,
        notifications,
      });
    }

    const back = req.get("referer") || "/wiki/" + page.slug_id;
    res.redirect(back);
  }),
);

r.get(
  "/edit/:slugid",
  asyncHandler(async (req, res) => {
    const page = await get("SELECT * FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");
    const tagNames = await fetchPageTags(page.id);
    const isAdmin = Boolean(req.session.user?.is_admin);
    if (!isAdmin) {
      const ban = await isIpBanned(req.clientIp, {
        action: "contribute",
        tags: tagNames,
      });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const uploads = isAdmin ? await listUploads() : [];
    res.render("edit", {
      page,
      tags: tagNames.join(", "),
      uploads,
      submissionMode: !isAdmin,
      allowUploads: isAdmin,
    });
  }),
);

r.post(
  "/edit/:slugid",
  asyncHandler(async (req, res) => {
    const { title, content, tags } = req.body;
    const page = await get("SELECT * FROM pages WHERE slug_id=?", [
      req.params.slugid,
    ]);
    if (!page) return res.status(404).send("Page introuvable");

    const isAdmin = Boolean(req.session.user?.is_admin);
    if (!isAdmin) {
      const tagNames = await fetchPageTags(page.id);
      const ban = await isIpBanned(req.clientIp, {
        action: "contribute",
        tags: tagNames,
      });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
      const submissionId = await createPageSubmission({
        type: "edit",
        pageId: page.id,
        title,
        content,
        tags,
        ip: req.clientIp,
        submittedBy: req.session.user?.username || null,
        targetSlugId: page.slug_id,
      });
      await touchIpProfile(req.clientIp);
      pushNotification(req, {
        type: "success",
        message:
          "Merci ! Votre proposition de mise à jour sera vérifiée avant publication.",
        timeout: 6000,
      });
      await sendAdminEvent("Soumission de modification", {
        page: {
          title: page.title,
          slug_id: page.slug_id,
          snowflake_id: page.snowflake_id,
        },
        user: req.session.user?.username || null,
        extra: {
          ip: req.clientIp || null,
          submission: submissionId,
          status: "pending",
        },
      });
      return res.redirect("/wiki/" + page.slug_id);
    }

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
      page: {
        title,
        slug_id: req.params.slugid,
        slug_base: base,
        snowflake_id: page.snowflake_id,
      },
      extra: { tags },
    });
    pushNotification(req, {
      type: "success",
      message: `"${title}" a été mis à jour !`,
    });
    res.redirect("/wiki/" + req.params.slugid);
  }),
);

r.delete(
  "/delete/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, snowflake_id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
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
    pushNotification(req, {
      type: "info",
      message: page?.title
        ? `"${page.title}" a été supprimé.`
        : "La page a été supprimée.",
    });
    res.redirect("/");
  }),
);

r.post(
  "/delete/:slugid",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, snowflake_id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
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
    pushNotification(req, {
      type: "info",
      message: page?.title
        ? `"${page.title}" a été supprimé.`
        : "La page a été supprimée.",
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
    const pagesRaw = await fetchPagesByTag({ tagName: req.params.name, ip });
    const pages = pagesRaw.map((page) => ({
      ...page,
      excerpt: buildPreviewHtml(page.excerpt),
    }));
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

r.get(
  "/profiles/ip/me",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    if (!ip) {
      return res.status(400).render("error", {
        message:
          "Impossible de déterminer votre adresse IP pour générer un profil public.",
      });
    }
    const profile = await touchIpProfile(ip);
    if (!profile?.hash) {
      return res.status(500).render("error", {
        message: "Profil IP actuellement indisponible. Veuillez réessayer plus tard.",
      });
    }
    res.redirect(`/profiles/ip/${profile.hash}`);
  }),
);

r.get(
  "/profiles/ip/:hash",
  asyncHandler(async (req, res) => {
    const requestedHash = (req.params.hash || "").trim().toLowerCase();
    if (!requestedHash) {
      return res.status(404).render("page404");
    }
    const profile = await getIpProfileByHash(requestedHash);
    if (!profile) {
      return res.status(404).render("page404");
    }
    const viewerHash = hashIp(req.clientIp);
    res.render("ip_profile", {
      profile,
      isOwner: viewerHash ? viewerHash === profile.hash : false,
    });
  }),
);

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
  return {
    slug: feedback.slug,
    values: feedback.values || {},
  };
}

function getUserDisplayName(user) {
  if (!user) {
    return null;
  }
  if (typeof user.display_name === "string") {
    const trimmedDisplay = user.display_name.trim();
    if (trimmedDisplay) {
      return trimmedDisplay;
    }
  }
  if (typeof user.username === "string") {
    const trimmedUsername = user.username.trim();
    if (trimmedUsername) {
      return trimmedUsername;
    }
  }
  return null;
}

export default r;
