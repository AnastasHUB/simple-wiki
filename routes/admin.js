import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { all, get, run, randSlugId, savePageFts } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { slugify } from "../utils/linkify.js";
import { sendAdminEvent } from "../utils/webhook.js";
import { hashPassword } from "../utils/passwords.js";
import {
  uploadDir,
  ensureUploadDir,
  recordUpload,
  listUploads,
  removeUpload,
  updateUploadName,
  optimizeUpload,
  normalizeDisplayName,
} from "../utils/uploads.js";
import { banIp, liftBan } from "../utils/ipBans.js";
import { getClientIp } from "../utils/ip.js";
import {
  getSiteSettingsForForm,
  updateSiteSettingsFromForm,
  invalidateSiteSettingsCache,
} from "../utils/settingsService.js";
import { pushNotification } from "../utils/notifications.js";

const PAGE_SIZE_OPTIONS = [5, 10, 50, 100, 500];
const DEFAULT_PAGE_SIZE = 10;

await ensureUploadDir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = randomUUID();
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Type de fichier non supporté"));
    }
  },
});

const jsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      /^application\/json$/i.test(file.mimetype) ||
      file.originalname.toLowerCase().endsWith(".json")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Le fichier doit être au format JSON"));
    }
  },
});

const r = Router();

r.use(requireAdmin);

r.get("/comments", async (req, res) => {
  const pending = await all(
    `SELECT c.id, c.snowflake_id, c.author, c.body, c.created_at, c.updated_at, c.status, c.ip,
            p.title AS page_title, p.slug_id AS page_slug
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.status='pending'
      ORDER BY c.created_at ASC`,
  );
  const recent = await all(
    `SELECT c.id, c.snowflake_id, c.author, c.body, c.created_at, c.updated_at, c.status, c.ip,
            p.title AS page_title, p.slug_id AS page_slug
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.status<>'pending'
      ORDER BY c.created_at DESC
      LIMIT 30`,
  );
  res.render("admin/comments", { pending, recent });
});

r.post("/comments/:id/approve", async (req, res) => {
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.status, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("UPDATE comments SET status='approved' WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "success",
    message: "Commentaire approuvé.",
  });
  await sendAdminEvent("Commentaire approuvé", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
});

r.post("/comments/:id/reject", async (req, res) => {
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.status, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("UPDATE comments SET status='rejected' WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "info",
    message: "Commentaire rejeté.",
  });
  await sendAdminEvent("Commentaire rejeté", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
});

async function handleCommentDeletion(req, res) {
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("DELETE FROM comments WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "success",
    message: "Commentaire supprimé.",
  });
  await sendAdminEvent("Commentaire supprimé", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
}

r.delete("/comments/:id", handleCommentDeletion);
r.post("/comments/:id/delete", handleCommentDeletion);

r.get("/ip-bans", async (req, res) => {
  const [activeBans, liftedBans] = await Promise.all([
    all(
      `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
         FROM ip_bans
        WHERE lifted_at IS NULL
        ORDER BY created_at DESC`,
    ),
    all(
      `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
         FROM ip_bans
        WHERE lifted_at IS NOT NULL
        ORDER BY lifted_at DESC
        LIMIT 200`,
    ),
  ]);
  res.render("admin/ip_bans", {
    activeBans,
    liftedBans,
  });
});

r.post("/ip-bans", async (req, res) => {
  const ip = (req.body.ip || "").trim();
  const scopeInput = (req.body.scope || "").trim();
  const reason = (req.body.reason || "").trim();
  const tagValue = (req.body.tag || "").trim().toLowerCase();
  if (!ip || !scopeInput) {
    pushNotification(req, {
      type: "error",
      message: "Adresse IP et portée requis.",
    });
    return res.redirect("/admin/ip-bans");
  }
  let scope = "global";
  let value = null;
  if (scopeInput === "tag") {
    scope = "tag";
    value = tagValue;
    if (!value) {
      pushNotification(req, {
        type: "error",
        message: "Veuillez préciser le tag à restreindre.",
      });
      return res.redirect("/admin/ip-bans");
    }
  } else if (scopeInput !== "global") {
    scope = "action";
    value = scopeInput;
  }
  const banId = await banIp({ ip, scope, value, reason: reason || null });
  pushNotification(req, {
    type: "success",
    message: "Blocage enregistré.",
  });
  await sendAdminEvent("IP bannie", {
    extra: { id: banId, ip, scope, value, reason: reason || null },
    user: req.session.user?.username || null,
  });
  res.redirect("/admin/ip-bans");
});

r.post("/ip-bans/:id/lift", async (req, res) => {
  const ban = await get(
    "SELECT snowflake_id, ip, scope, value FROM ip_bans WHERE snowflake_id=?",
    [req.params.id],
  );
  await liftBan(req.params.id);
  pushNotification(req, {
    type: "success",
    message: "Blocage levé.",
  });
  await sendAdminEvent("IP débannie", {
    extra: {
      id: req.params.id,
      ip: ban?.ip || null,
      scope: ban?.scope,
      value: ban?.value,
    },
    user: req.session.user?.username || null,
  });
  res.redirect("/admin/ip-bans");
});

r.get("/pages", async (req, res) => {
  const countRow = await get("SELECT COUNT(*) AS c FROM pages");
  const latest = await get(`
    SELECT title, slug_id,
      COALESCE(updated_at, created_at) AS ts
    FROM pages
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 1
  `);
  const result = req.session.importResult || null;
  delete req.session.importResult;
  res.render("admin/pages", {
    stats: {
      count: countRow?.c || 0,
      latest,
    },
    importResult: result,
  });
});

r.get("/stats", async (_req, res) => {
  const periods = [
    {
      key: "day",
      label: "24 dernières heures",
      durationMs: 24 * 60 * 60 * 1000,
      limit: 10,
    },
    {
      key: "week",
      label: "7 derniers jours",
      durationMs: 7 * 24 * 60 * 60 * 1000,
      limit: 15,
    },
    {
      key: "month",
      label: "30 derniers jours",
      durationMs: 30 * 24 * 60 * 60 * 1000,
      limit: 15,
    },
    { key: "all", label: "Depuis toujours", durationMs: null, limit: 20 },
  ];

  const stats = {};
  for (const period of periods) {
    let fromIso = null;
    let fromDay = null;
    if (period.durationMs) {
      const from = new Date(Date.now() - period.durationMs);
      fromIso = from.toISOString();
      fromDay = fromIso.slice(0, 10);
    }
    const { query, params } = buildViewLeaderboardQuery(
      fromIso,
      fromDay,
      period.limit,
    );
    stats[period.key] = await all(query, params);
  }

  const totals = await get(
    `SELECT
      COALESCE((SELECT SUM(views) FROM page_view_daily),0)
      + COALESCE((SELECT COUNT(*) FROM page_views),0) AS totalViews`,
  );

  const likeTotals = await get("SELECT COUNT(*) AS totalLikes FROM likes");
  const commentByStatus = await all(
    "SELECT status, COUNT(*) AS count FROM comments GROUP BY status",
  );
  const topLikedPages = await all(`
    SELECT p.title, p.slug_id, COUNT(*) AS likes
      FROM likes l
      JOIN pages p ON p.id = l.page_id
     GROUP BY l.page_id
     ORDER BY likes DESC, p.title ASC
     LIMIT 15`);
  const topCommenters = await all(`
    SELECT COALESCE(author, 'Anonyme') AS author, COUNT(*) AS comments
      FROM comments
     GROUP BY COALESCE(author, 'Anonyme')
     ORDER BY comments DESC
     LIMIT 15`);
  const topCommentedPages = await all(`
    SELECT p.title, p.slug_id, COUNT(*) AS comments
      FROM comments c
      JOIN pages p ON p.id = c.page_id
     WHERE c.status='approved'
     GROUP BY c.page_id
     ORDER BY comments DESC, p.title ASC
     LIMIT 15`);
  const tagUsage = await all(`
    SELECT t.name, COUNT(*) AS pages
      FROM page_tags pt
      JOIN tags t ON t.id = pt.tag_id
     GROUP BY pt.tag_id
     ORDER BY pages DESC, t.name ASC
     LIMIT 20`);
  const commentTimeline = await all(`
    SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS comments
      FROM comments
     GROUP BY day
     ORDER BY day DESC
     LIMIT 30`);
  const activeIps = await all(`
    SELECT ip, COUNT(*) AS views
      FROM page_views
     WHERE ip IS NOT NULL AND ip <> ''
     GROUP BY ip
     ORDER BY views DESC
     LIMIT 25`);
  const uniqueIps = await get(
    "SELECT COUNT(DISTINCT ip) AS total FROM page_views WHERE ip IS NOT NULL AND ip <> ''",
  );
  const ipViewsByPage = await all(`
    SELECT pv.ip, p.title, p.slug_id, COUNT(*) AS views
      FROM page_views pv
      JOIN pages p ON p.id = pv.page_id
     WHERE pv.ip IS NOT NULL AND pv.ip <> ''
     GROUP BY pv.ip, pv.page_id
     ORDER BY views DESC
     LIMIT 50`);
  const banCount = await get(
    "SELECT COUNT(*) AS count FROM ip_bans WHERE lifted_at IS NULL",
  );
  const eventCount = await get("SELECT COUNT(*) AS count FROM event_logs");

  res.render("admin/stats", {
    periods,
    stats,
    totalViews: totals?.totalViews || 0,
    totalsBreakdown: {
      likes: likeTotals?.totalLikes || 0,
      comments: commentByStatus.reduce(
        (sum, row) => sum + (row?.count || 0),
        0,
      ),
      commentByStatus,
      activeBans: banCount?.count || 0,
      events: eventCount?.count || 0,
      uniqueIps: uniqueIps?.total || 0,
    },
    topLikedPages,
    topCommenters,
    topCommentedPages,
    tagUsage,
    commentTimeline,
    activeIps,
    ipViewsByPage,
  });
});

r.get("/pages/export", async (_req, res) => {
  const settingsRow = await get(
    `SELECT id, wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text
       FROM settings
      WHERE id=1`,
  );
  const pageRows = await all(`
    SELECT p.id, p.slug_base, p.slug_id, p.title, p.content, p.created_at, p.updated_at,
      (SELECT GROUP_CONCAT(t.name, ',') FROM tags t
        JOIN page_tags pt ON pt.tag_id = t.id
       WHERE pt.page_id = p.id) AS tagsCsv
    FROM pages p
    ORDER BY p.created_at ASC
  `);
  const pages = pageRows.map((r) => ({
    id: r.id,
    slug_base: r.slug_base,
    slug_id: r.slug_id,
    title: r.title,
    content: r.content,
    created_at: r.created_at,
    updated_at: r.updated_at,
    tags: r.tagsCsv
      ? r.tagsCsv
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
  }));
  const users = await all(
    `SELECT id, username, password, is_admin FROM users ORDER BY id ASC`,
  );
  const likes = await all(`
    SELECT l.id, l.page_id, p.slug_id, l.ip, l.created_at
      FROM likes l
      JOIN pages p ON p.id = l.page_id
     ORDER BY l.created_at ASC`);
  const comments = await all(`
    SELECT c.id, c.snowflake_id AS snowflake_id, c.page_id, p.slug_id, c.author, c.body, c.status,
           c.created_at, c.updated_at, c.ip, c.edit_token
      FROM comments c
      JOIN pages p ON p.id = c.page_id
     ORDER BY c.created_at ASC`);
  const viewEvents = await all(`
    SELECT pv.id, pv.page_id, p.slug_id, pv.ip, pv.viewed_at
      FROM page_views pv
      JOIN pages p ON p.id = pv.page_id
     ORDER BY pv.viewed_at ASC`);
  const aggregatedViews = await all(`
    SELECT v.page_id, p.slug_id, v.day, v.views
      FROM page_view_daily v
      JOIN pages p ON p.id = v.page_id
     ORDER BY v.day ASC`);
  const pageRevisions = await all(`
    SELECT pr.page_id, p.slug_id, pr.revision, pr.title, pr.content, pr.author_id, u.username AS author_username,
           pr.created_at
      FROM page_revisions pr
      JOIN pages p ON p.id = pr.page_id
      LEFT JOIN users u ON u.id = pr.author_id
     ORDER BY p.slug_id ASC, pr.revision ASC`);
  const uploads = await all(
    `SELECT id, original_name, display_name, extension, size, created_at FROM uploads ORDER BY created_at ASC`,
  );
  const ipBans = await all(
    `SELECT id, snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      ORDER BY created_at ASC`,
  );
  const events = await all(
    `SELECT id, channel, type, payload, ip, username, created_at
       FROM event_logs
      ORDER BY created_at ASC`,
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const date = new Date().toISOString().split("T")[0];
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="wiki-pages-${date}.json"`,
  );
  const payload = {
    schema_version: 2,
    full_export: true,
    exported_at: new Date().toISOString(),
    count: pages.length,
    counts: {
      pages: pages.length,
      users: users.length,
      likes: likes.length,
      comments: comments.length,
      view_events: viewEvents.length,
      view_daily: aggregatedViews.length,
      revisions: pageRevisions.length,
      uploads: uploads.length,
      ip_bans: ipBans.length,
      events: events.length,
    },
    settings: settingsRow || null,
    users,
    pages,
    page_revisions: pageRevisions,
    likes,
    comments,
    views: {
      events: viewEvents,
      daily: aggregatedViews,
    },
    uploads,
    ip_bans: ipBans,
    events,
  };
  res.send(JSON.stringify(payload, null, 2));
});

r.post(
  "/pages/import",
  jsonUpload.single("archive"),
  async (req, res, next) => {
    try {
      const ip = getClientIp(req);
      if (!req.file) {
        req.session.importResult = { errors: ["Aucun fichier importé."] };
        pushNotification(req, {
          type: "error",
          message: "Aucun fichier importé.",
        });
        return res.redirect("/admin/pages");
      }

      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString("utf8"));
      } catch (err) {
        req.session.importResult = {
          errors: ["Le fichier JSON est invalide: " + (err?.message || err)],
        };
        pushNotification(req, {
          type: "error",
          message: "Le fichier JSON est invalide.",
        });
        return res.redirect("/admin/pages");
      }

      const pages = Array.isArray(parsed) ? parsed : parsed?.pages;
      if (!Array.isArray(pages)) {
        req.session.importResult = {
          errors: ['Structure inattendue: un tableau "pages" est requis.'],
        };
        pushNotification(req, {
          type: "error",
          message: "Structure JSON inattendue : tableau \"pages\" requis.",
        });
        return res.redirect("/admin/pages");
      }

      const likesInput = Array.isArray(parsed?.likes) ? parsed.likes : [];
      const commentsInput = Array.isArray(parsed?.comments) ? parsed.comments : [];
      const viewEventsInput = Array.isArray(parsed?.views?.events)
        ? parsed.views.events
        : [];
      const viewDailyInput = Array.isArray(parsed?.views?.daily)
        ? parsed.views.daily
        : [];
      const ipBansInput = Array.isArray(parsed?.ip_bans) ? parsed.ip_bans : [];
      const eventsInput = Array.isArray(parsed?.events) ? parsed.events : [];
      const usersInput = Array.isArray(parsed?.users) ? parsed.users : [];
      const revisionsInput = Array.isArray(parsed?.page_revisions)
        ? parsed.page_revisions
        : [];
      const uploadsInput = Array.isArray(parsed?.uploads) ? parsed.uploads : [];
      const settingsInput =
        parsed && typeof parsed === "object" && parsed.settings &&
        typeof parsed.settings === "object"
          ? parsed.settings
          : null;

      const summary = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        stats: {
          users: 0,
          likes: 0,
          comments: 0,
          viewEvents: 0,
          viewDaily: 0,
          ipBans: 0,
          events: 0,
          revisions: 0,
          uploads: 0,
        },
        settingsUpdated: false,
      };

      const tagCache = new Map();
      const slugToId = new Map();

      await run("BEGIN TRANSACTION");
      try {
        if (settingsInput) {
          const currentSettings = await get(
            `SELECT wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text
               FROM settings
              WHERE id=1`,
          );
          const wikiName =
            typeof settingsInput.wiki_name === "string"
              ? settingsInput.wiki_name.trim()
              : typeof settingsInput.wikiName === "string"
                ? settingsInput.wikiName.trim()
                : currentSettings?.wiki_name || "Wiki";
          const logoUrl =
            typeof settingsInput.logo_url === "string"
              ? settingsInput.logo_url.trim()
              : typeof settingsInput.logoUrl === "string"
                ? settingsInput.logoUrl.trim()
                : currentSettings?.logo_url || "";
          const adminWebhook =
            typeof settingsInput.admin_webhook_url === "string"
              ? settingsInput.admin_webhook_url.trim()
              : typeof settingsInput.adminWebhook === "string"
                ? settingsInput.adminWebhook.trim()
                : currentSettings?.admin_webhook_url || "";
          const feedWebhook =
            typeof settingsInput.feed_webhook_url === "string"
              ? settingsInput.feed_webhook_url.trim()
              : typeof settingsInput.feedWebhook === "string"
                ? settingsInput.feedWebhook.trim()
                : currentSettings?.feed_webhook_url || "";
          const footerText =
            typeof settingsInput.footer_text === "string"
              ? settingsInput.footer_text.trim()
              : typeof settingsInput.footerText === "string"
                ? settingsInput.footerText.trim()
                : currentSettings?.footer_text || "";
          await run(
            `UPDATE settings
                SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?
              WHERE id=1`,
            [wikiName, logoUrl, adminWebhook, feedWebhook, footerText],
          );
          summary.settingsUpdated = true;
        }

        for (let idx = 0; idx < usersInput.length; idx++) {
          const user = usersInput[idx] || {};
          const username =
            typeof user.username === "string" ? user.username.trim() : "";
          const password =
            typeof user.password === "string" ? user.password : "";
          const isAdminRaw = user.is_admin ?? user.isAdmin ?? 0;
        const isAdmin =
          typeof isAdminRaw === "boolean"
            ? isAdminRaw
            : Number(isAdminRaw) === 1;
        if (!username || !password) {
          summary.errors.push(
            `Utilisateur #${idx + 1}: identifiant ou mot de passe manquant.`,
          );
          continue;
        }
        const providedUserSnowflake =
          typeof user.snowflake_id === "string" && user.snowflake_id.trim()
            ? user.snowflake_id.trim()
            : null;
        const userSnowflake = providedUserSnowflake || generateSnowflake();
        const insertParams = [userSnowflake, username, password, isAdmin ? 1 : 0];
        const userId = parseInteger(user.id);
        if (userId !== null) {
          await run(
            `INSERT INTO users(id, snowflake_id, username, password, is_admin) VALUES(?,?,?,?,?)
             ON CONFLICT(username) DO UPDATE SET password=excluded.password, is_admin=excluded.is_admin`,
            [userId, ...insertParams],
          );
        } else {
          await run(
            `INSERT INTO users(snowflake_id, username, password, is_admin) VALUES(?,?,?,?)
             ON CONFLICT(username) DO UPDATE SET password=excluded.password, is_admin=excluded.is_admin`,
            insertParams,
          );
        }
          summary.stats.users++;
        }

        const userRows = await all(`SELECT id, username FROM users`);
        const usernameToId = new Map();
        const userIdSet = new Set();
        for (const row of userRows) {
          usernameToId.set(row.username, row.id);
          userIdSet.add(row.id);
        }

        for (let idx = 0; idx < pages.length; idx++) {
          const item = pages[idx] || {};
          const title = typeof item.title === "string" ? item.title.trim() : "";
          const content = typeof item.content === "string" ? item.content : "";
          if (!title || !content) {
            summary.errors.push(
              `Entrée #${idx + 1}: titre ou contenu manquant.`,
            );
            summary.skipped++;
            continue;
          }

          let slugId =
            typeof item.slug_id === "string" ? item.slug_id.trim() : "";
          let slugBase =
            typeof item.slug_base === "string" ? item.slug_base.trim() : "";
          if (!slugBase) {
            slugBase = slugify(title);
          }
          if (!slugId) {
            slugId = randSlugId(slugBase);
          }

          const tagsRaw = Array.isArray(item.tags)
            ? item.tags
            : typeof item.tags === "string"
              ? item.tags.split(",")
              : [];
          const tags = tagsRaw
            .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
            .filter(Boolean);

          const createdAt =
            sanitizeDate(item.created_at) || new Date().toISOString();
          const updatedAt = sanitizeDate(item.updated_at);

          const providedPageSnowflake =
            typeof item.snowflake_id === "string" && item.snowflake_id.trim()
              ? item.snowflake_id.trim()
              : null;
          const pageSnowflake = providedPageSnowflake || generateSnowflake();

          const existing = await get(
            "SELECT id, created_at FROM pages WHERE slug_id=?",
            [slugId],
          );
          let pageId;
          if (existing) {
            const finalCreatedAt =
              sanitizeDate(item.created_at) || existing.created_at;
            const finalUpdatedAt = updatedAt || new Date().toISOString();
            await run(
              "UPDATE pages SET slug_base=?, title=?, content=?, created_at=?, updated_at=? WHERE id=?",
              [
                slugBase,
                title,
                content,
                finalCreatedAt,
                finalUpdatedAt,
                existing.id,
              ],
            );
            pageId = existing.id;
            summary.updated++;
          } else {
            const explicitId = parseInteger(item.id);
            if (explicitId !== null) {
              await run(
                "INSERT INTO pages(id, snowflake_id, slug_base, slug_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                [
                  explicitId,
                  pageSnowflake,
                  slugBase,
                  slugId,
                  title,
                  content,
                  createdAt,
                  updatedAt,
                ],
              );
              pageId = explicitId;
              summary.created++;
            } else {
              const result = await run(
                "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                [
                  pageSnowflake,
                  slugBase,
                  slugId,
                  title,
                  content,
                  createdAt,
                  updatedAt,
                ],
              );
              pageId = result.lastID;
              summary.created++;
            }
          }

          slugToId.set(slugId, pageId);

          await run("DELETE FROM page_tags WHERE page_id=?", [pageId]);
          for (const tagName of tags) {
            let tagId = tagCache.get(tagName);
            if (!tagId) {
              await run("INSERT OR IGNORE INTO tags(name, snowflake_id) VALUES(?,?)", [
                tagName,
                generateSnowflake(),
              ]);
              const row = await get("SELECT id FROM tags WHERE name=?", [
                tagName,
              ]);
              tagId = row?.id;
              if (tagId) {
                tagCache.set(tagName, tagId);
              }
            }
            if (tagId) {
              await run(
                "INSERT OR IGNORE INTO page_tags(snowflake_id, page_id, tag_id) VALUES(?,?,?)",
                [generateSnowflake(), pageId, tagId],
              );
            }
          }

          await savePageFts({
            id: pageId,
            title,
            content,
            slug_id: slugId,
            tags: tags.join(","),
          });
        }

        const slugRows = await all("SELECT id, slug_id FROM pages");
        for (const row of slugRows) {
          slugToId.set(row.slug_id, row.id);
        }

        for (let idx = 0; idx < revisionsInput.length; idx++) {
          const revision = revisionsInput[idx] || {};
          const slugId =
            typeof revision.slug_id === "string" ? revision.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Révision #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const revisionNumber = parseInteger(revision.revision);
          if (revisionNumber === null || revisionNumber < 1) {
            summary.errors.push(
              `Révision #${idx + 1}: numéro de révision invalide.`,
            );
            continue;
          }
          const title =
            typeof revision.title === "string" ? revision.title : "";
          const content =
            typeof revision.content === "string" ? revision.content : "";
          const createdAt = sanitizeDate(revision.created_at);
          const authorUsername =
            typeof revision.author_username === "string"
              ? revision.author_username.trim()
              : "";
          let authorId = parseInteger(revision.author_id);
          if (authorId && !userIdSet.has(authorId)) {
            authorId = null;
          }
          if (!authorId && authorUsername) {
            authorId = usernameToId.get(authorUsername) || null;
          }
          const revisionSnowflake =
            typeof revision.snowflake_id === "string" && revision.snowflake_id.trim()
              ? revision.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO page_revisions(snowflake_id, page_id, revision, title, content, author_id, created_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(page_id, revision) DO UPDATE SET
               title=excluded.title,
               content=excluded.content,
               author_id=excluded.author_id,
               created_at=excluded.created_at`,
            [
              revisionSnowflake,
              pageId,
              revisionNumber,
              title,
              content,
              authorId,
              createdAt,
            ],
          );
          summary.stats.revisions++;
        }

        for (let idx = 0; idx < likesInput.length; idx++) {
          const like = likesInput[idx] || {};
          const slugId =
            typeof like.slug_id === "string" ? like.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Like #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const ipValue =
            typeof like.ip === "string" && like.ip.trim()
              ? like.ip.trim()
              : null;
          if (!ipValue) {
            summary.errors.push(
              `Like #${idx + 1}: adresse IP manquante pour ${slugId}.`,
            );
            continue;
          }
          const createdAt =
            sanitizeDate(like.created_at) || new Date().toISOString();
          const likeId = parseInteger(like.id);
          const likeSnowflake =
            typeof like.snowflake_id === "string" && like.snowflake_id.trim()
              ? like.snowflake_id.trim()
              : generateSnowflake();
          if (likeId !== null) {
            await run(
              `INSERT INTO likes(id, snowflake_id, page_id, ip, created_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, ip=excluded.ip, created_at=excluded.created_at`,
              [likeId, likeSnowflake, pageId, ipValue, createdAt],
            );
          } else {
            await run(
              `INSERT INTO likes(snowflake_id, page_id, ip, created_at) VALUES(?,?,?,?)
               ON CONFLICT(page_id, ip) DO UPDATE SET created_at=excluded.created_at`,
              [likeSnowflake, pageId, ipValue, createdAt],
            );
          }
          summary.stats.likes++;
        }

        for (let idx = 0; idx < commentsInput.length; idx++) {
          const comment = commentsInput[idx] || {};
          const slugId =
            typeof comment.slug_id === "string" ? comment.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Commentaire #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const snowflakeId =
            typeof comment.snowflake_id === "string"
              ? comment.snowflake_id
              : typeof comment.id === "string"
                ? comment.id
                : null;
          if (!snowflakeId) {
            summary.errors.push(
              `Commentaire #${idx + 1}: identifiant absent pour ${slugId}.`,
            );
            continue;
          }
          const author =
            typeof comment.author === "string" ? comment.author : null;
          const body =
            typeof comment.body === "string" ? comment.body : "";
          if (!body) {
            summary.errors.push(
              `Commentaire #${idx + 1}: contenu manquant pour ${slugId}.`,
            );
            continue;
          }
          const status =
            typeof comment.status === "string" && comment.status
              ? comment.status
              : "pending";
          const createdAt =
            sanitizeDate(comment.created_at) || new Date().toISOString();
          const updatedAt = sanitizeDate(comment.updated_at);
          const ipValue =
            typeof comment.ip === "string" && comment.ip.trim()
              ? comment.ip.trim()
              : null;
          const editToken =
            typeof comment.edit_token === "string"
              ? comment.edit_token
              : null;
          const commentId = parseInteger(comment.id);
          await run(
            `INSERT INTO comments(id, snowflake_id, page_id, author, body, status, created_at, updated_at, ip, edit_token)
             VALUES(?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(snowflake_id) DO UPDATE SET
               page_id=excluded.page_id,
               author=excluded.author,
               body=excluded.body,
               status=excluded.status,
               created_at=excluded.created_at,
               updated_at=excluded.updated_at,
               ip=excluded.ip,
               edit_token=excluded.edit_token`,
            [
              commentId,
              snowflakeId,
              pageId,
              author,
              body,
              status,
              createdAt,
              updatedAt,
              ipValue,
              editToken,
            ],
          );
          summary.stats.comments++;
        }

        for (let idx = 0; idx < viewEventsInput.length; idx++) {
          const view = viewEventsInput[idx] || {};
          const slugId =
            typeof view.slug_id === "string" ? view.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Vue #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const viewedAt =
            sanitizeDate(view.viewed_at) || new Date().toISOString();
          const ipValue =
            typeof view.ip === "string" && view.ip.trim()
              ? view.ip.trim()
              : null;
          const viewSnowflake =
            typeof view.snowflake_id === "string" && view.snowflake_id.trim()
              ? view.snowflake_id.trim()
              : generateSnowflake();
          const viewId = parseInteger(view.id);
          if (viewId !== null) {
            await run(
              `INSERT INTO page_views(id, snowflake_id, page_id, ip, viewed_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, ip=excluded.ip, viewed_at=excluded.viewed_at`,
              [viewId, viewSnowflake, pageId, ipValue, viewedAt],
            );
          } else {
            await run(
              `INSERT INTO page_views(snowflake_id, page_id, ip, viewed_at) VALUES(?,?,?,?)`,
              [viewSnowflake, pageId, ipValue, viewedAt],
            );
          }
          summary.stats.viewEvents++;
        }

        for (let idx = 0; idx < viewDailyInput.length; idx++) {
          const view = viewDailyInput[idx] || {};
          const slugId =
            typeof view.slug_id === "string" ? view.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Statistiques quotidiennes #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const day = typeof view.day === "string" ? view.day : null;
          if (!day) {
            summary.errors.push(
              `Statistiques quotidiennes #${idx + 1}: jour manquant.`,
            );
            continue;
          }
          const viewsValue = parseInteger(view.views);
          const finalViews = viewsValue ?? 0;
          const viewDailySnowflake =
            typeof view.snowflake_id === "string" && view.snowflake_id.trim()
              ? view.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO page_view_daily(snowflake_id, page_id, day, views) VALUES(?,?,?,?)
             ON CONFLICT(page_id, day) DO UPDATE SET views=excluded.views`,
            [viewDailySnowflake, pageId, day, finalViews],
          );
          summary.stats.viewDaily++;
        }

        for (let idx = 0; idx < uploadsInput.length; idx++) {
          const upload = uploadsInput[idx] || {};
          const id = typeof upload.id === "string" ? upload.id : null;
          if (!id) {
            summary.errors.push(
              `Upload #${idx + 1}: identifiant manquant.`,
            );
            continue;
          }
          const originalName =
            typeof upload.original_name === "string"
              ? upload.original_name
              : upload.originalName;
          const extension =
            typeof upload.extension === "string"
              ? upload.extension
              : null;
          if (!originalName || !extension) {
            summary.errors.push(
              `Upload #${idx + 1}: nom d'origine ou extension manquants.`,
            );
            continue;
          }
          const displayName =
            typeof upload.display_name === "string"
              ? upload.display_name
              : typeof upload.displayName === "string"
                ? upload.displayName
                : null;
          const sizeValue = parseInteger(upload.size);
          const createdAt = sanitizeDate(upload.created_at);
          const uploadSnowflake =
            typeof upload.snowflake_id === "string" && upload.snowflake_id.trim()
              ? upload.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO uploads(id, snowflake_id, original_name, display_name, extension, size, created_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               original_name=excluded.original_name,
               display_name=excluded.display_name,
               extension=excluded.extension,
               size=excluded.size,
               created_at=excluded.created_at`,
            [
              id,
              uploadSnowflake,
              originalName,
              displayName,
              extension,
              sizeValue ?? null,
              createdAt,
            ],
          );
          summary.stats.uploads++;
        }

        for (let idx = 0; idx < ipBansInput.length; idx++) {
          const ban = ipBansInput[idx] || {};
          const snowflakeId =
            typeof ban.snowflake_id === "string"
              ? ban.snowflake_id
              : typeof ban.id === "string"
                ? ban.id
                : null;
          if (!snowflakeId) {
            summary.errors.push(
              `Blocage #${idx + 1}: identifiant manquant.`,
            );
            continue;
          }
          const ipValue = typeof ban.ip === "string" ? ban.ip.trim() : "";
          const scope = typeof ban.scope === "string" ? ban.scope : null;
          if (!ipValue || !scope) {
            summary.errors.push(
              `Blocage #${idx + 1}: IP ou portée manquante.`,
            );
            continue;
          }
          const createdAt = sanitizeDate(ban.created_at);
          const liftedAt = sanitizeDate(ban.lifted_at);
          const banId = parseInteger(ban.id);
          await run(
            `INSERT INTO ip_bans(id, snowflake_id, ip, scope, value, reason, created_at, lifted_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(snowflake_id) DO UPDATE SET
               ip=excluded.ip,
               scope=excluded.scope,
               value=excluded.value,
               reason=excluded.reason,
               created_at=excluded.created_at,
               lifted_at=excluded.lifted_at`,
            [
              banId,
              snowflakeId,
              ipValue,
              scope,
              typeof ban.value === "string" ? ban.value : null,
              typeof ban.reason === "string" ? ban.reason : null,
              createdAt,
              liftedAt,
            ],
          );
          summary.stats.ipBans++;
        }

        for (let idx = 0; idx < eventsInput.length; idx++) {
          const event = eventsInput[idx] || {};
          const eventId = parseInteger(event.id);
          if (eventId === null) {
            summary.errors.push(
              `Événement #${idx + 1}: identifiant numérique requis.`,
            );
            continue;
          }
          const channel =
            typeof event.channel === "string" ? event.channel : null;
          const type = typeof event.type === "string" ? event.type : null;
          if (!channel || !type) {
            summary.errors.push(
              `Événement #${idx + 1}: canal ou type manquant.`,
            );
            continue;
          }
          const eventSnowflake =
            typeof event.snowflake_id === "string" && event.snowflake_id.trim()
              ? event.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO event_logs(id, snowflake_id, channel, type, payload, ip, username, created_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               channel=excluded.channel,
               type=excluded.type,
               payload=excluded.payload,
               ip=excluded.ip,
               username=excluded.username,
               created_at=excluded.created_at`,
            [
              eventId,
              eventSnowflake,
              channel,
              type,
              typeof event.payload === "string"
                ? event.payload
                : event.payload
                  ? JSON.stringify(event.payload)
                  : null,
              typeof event.ip === "string" ? event.ip : null,
              typeof event.username === "string" ? event.username : null,
              sanitizeDate(event.created_at) || new Date().toISOString(),
            ],
          );
          summary.stats.events++;
        }

        await run("COMMIT");
      } catch (transactionError) {
        await run("ROLLBACK");
        throw transactionError;
      }

      if (summary.settingsUpdated) {
        invalidateSiteSettingsCache();
      }

      if (summary.errors.length) {
        req.session.importResult = summary;
      } else {
        delete req.session.importResult;
      }
      const baseSummaryMessage =
        `${summary.created} article(s) créé(s), ${summary.updated} article(s) mis à jour, ${summary.skipped} article(s) ignoré(s).`;
      const extraMetrics = [];
      if (summary.stats.users) {
        extraMetrics.push(`${summary.stats.users} utilisateur(s)`);
      }
      if (summary.stats.likes) {
        extraMetrics.push(`${summary.stats.likes} like(s)`);
      }
      if (summary.stats.comments) {
        extraMetrics.push(`${summary.stats.comments} commentaire(s)`);
      }
      if (summary.stats.viewEvents || summary.stats.viewDaily) {
        const viewsDetail = [];
        if (summary.stats.viewEvents) {
          viewsDetail.push(`${summary.stats.viewEvents} vue(s)`);
        }
        if (summary.stats.viewDaily) {
          viewsDetail.push(`${summary.stats.viewDaily} statistique(s) quotidienne(s)`);
        }
        if (viewsDetail.length) {
          extraMetrics.push(`statistiques (${viewsDetail.join(", ")})`);
        }
      }
      if (summary.stats.revisions) {
        extraMetrics.push(`${summary.stats.revisions} révision(s)`);
      }
      if (summary.stats.uploads) {
        extraMetrics.push(`${summary.stats.uploads} fichier(s)`);
      }
      if (summary.stats.ipBans) {
        extraMetrics.push(`${summary.stats.ipBans} blocage(s) IP`);
      }
      if (summary.stats.events) {
        extraMetrics.push(`${summary.stats.events} événement(s) journalisé(s)`);
      }
      const extraSummary =
        extraMetrics.length > 0
          ? ` Données synchronisées : ${extraMetrics.join(", ")}.`
          : "";
      const importSummaryMessage = summary.errors.length
        ? `Import terminé : ${baseSummaryMessage}${extraSummary} ${summary.errors.length} erreur(s) à consulter.`
        : `Import terminé avec succès : ${baseSummaryMessage}${extraSummary}`;
      pushNotification(req, {
        type: summary.errors.length ? "info" : "success",
        message: importSummaryMessage,
        timeout: 7000,
      });
      await sendAdminEvent(
        "Import de pages",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            total: pages.length,
            created: summary.created,
            updated: summary.updated,
            skipped: summary.skipped,
            errors: summary.errors.slice(0, 5),
            stats: summary.stats,
            settingsUpdated: summary.settingsUpdated,
          },
        },
        { includeScreenshot: false },
      );
      res.redirect("/admin/pages");
    } catch (err) {
      next(err);
    }
  },
);

function sanitizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

r.post("/uploads", upload.single("image"), async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (!req.file) {
      return res.status(400).json({ ok: false, message: "Aucun fichier reçu" });
    }
    const ext = path.extname(req.file.filename).toLowerCase();
    const id = path.basename(req.file.filename, ext);
    const displayName = normalizeDisplayName(req.body?.displayName);

    const filePath = path.join(uploadDir, req.file.filename);
    let finalSize = req.file.size;
    try {
      const optimizedSize = await optimizeUpload(
        filePath,
        req.file.mimetype,
        ext,
      );
      if (optimizedSize) {
        finalSize = optimizedSize;
      } else {
        const stat = await fs.stat(filePath);
        finalSize = stat.size;
      }
    } catch (optimizationError) {
      try {
        const stat = await fs.stat(filePath);
        finalSize = stat.size;
      } catch (_) {
        // ignore
      }
      console.warn(
        "Optimization error for upload %s: %s",
        id,
        optimizationError?.message || optimizationError,
      );
    }

    await recordUpload({
      id,
      originalName: req.file.originalname,
      displayName,
      extension: ext,
      size: finalSize,
    });
    await sendAdminEvent(
      "Fichier importé",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          uploadId: id,
          originalName: req.file.originalname,
          size: finalSize,
          mime: req.file.mimetype,
        },
      },
      { includeScreenshot: false },
    );
    res.json({
      ok: true,
      url: "/public/uploads/" + req.file.filename,
      id,
      name: req.file.filename,
      displayName: displayName || "",
      originalName: req.file.originalname,
      size: finalSize,
    });
  } catch (err) {
    next(err);
  }
});

r.use((err, req, res, next) => {
  if (req.path === "/uploads" && req.method === "POST") {
    let message = "Erreur lors de l'upload";
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        message = "Fichier trop volumineux (maximum 5 Mo).";
      } else {
        message = err.message || message;
      }
    } else if (err && typeof err.message === "string" && err.message.trim()) {
      message = err.message;
    }
    return res.status(400).json({ ok: false, message });
  }
  next(err);
});

r.get("/uploads", async (_req, res) => {
  const uploads = await listUploads();
  res.render("admin/uploads", { uploads });
});

r.post("/uploads/:id/name", async (req, res) => {
  const displayName = normalizeDisplayName(req.body?.displayName);
  await updateUploadName(req.params.id, displayName);
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Upload renommé",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        uploadId: req.params.id,
        displayName,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: "Nom du fichier mis à jour.",
  });
  res.redirect("/admin/uploads");
});

r.post("/uploads/:id/delete", async (req, res) => {
  const upload = await get(
    "SELECT id, original_name, display_name FROM uploads WHERE id=?",
    [req.params.id],
  );
  await removeUpload(req.params.id);
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Upload supprimé",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        uploadId: req.params.id,
        originalName: upload?.original_name || null,
        displayName: upload?.display_name || null,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: "Fichier supprimé.",
  });
  res.redirect("/admin/uploads");
});

// settings
r.get("/settings", async (_req, res) => {
  const s = await getSiteSettingsForForm();
  res.render("admin/settings", { s });
});
r.post("/settings", async (req, res) => {
  const updated = await updateSiteSettingsFromForm(req.body);
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Paramètres mis à jour",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        wikiName: updated.wikiName,
        logoUrl: updated.logoUrl,
        footerText: updated.footerText,
        adminWebhookConfigured: !!updated.adminWebhook,
        feedWebhookConfigured: !!updated.feedWebhook,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: "Paramètres enregistrés.",
  });
  res.redirect("/admin/settings");
});

// users
r.get("/users", async (_req, res) => {
  const users = await all(
    "SELECT id, username, is_admin FROM users ORDER BY id",
  );
  res.render("admin/users", { users });
});
r.post("/users", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    pushNotification(req, {
      type: "error",
      message: "Nom d'utilisateur et mot de passe requis.",
    });
    return res.redirect("/admin/users");
  }
  const hashed = await hashPassword(password);
  const result = await run(
    "INSERT INTO users(snowflake_id, username,password,is_admin) VALUES(?,?,?,1)",
    [generateSnowflake(), username, hashed],
  );
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Utilisateur créé",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        newUser: username,
        userId: result?.lastID || null,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: `Utilisateur ${username} créé.`,
  });
  res.redirect("/admin/users");
});
r.post("/users/:id/delete", async (req, res) => {
  const target = await get("SELECT id, username FROM users WHERE id=?", [
    req.params.id,
  ]);
  await run("DELETE FROM users WHERE id=?", [req.params.id]);
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Utilisateur supprimé",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: req.params.id,
        targetUsername: target?.username || null,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "info",
    message: target?.username
      ? `Utilisateur ${target.username} supprimé.`
      : "Utilisateur supprimé.",
  });
  res.redirect("/admin/users");
});

// likes table improved
r.get("/likes", async (req, res) => {
  const totalRow = await get("SELECT COUNT(*) AS total FROM likes");
  const totalLikes = Number(totalRow?.total ?? 0);
  const pagination = buildPagination(req, totalLikes);
  const offset = (pagination.page - 1) * pagination.perPage;

  const rows = await all(
    `
    SELECT l.id, l.ip, l.created_at, p.title, p.slug_id
    FROM likes l JOIN pages p ON p.id=l.page_id
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `,
    [pagination.perPage, offset],
  );

  res.render("admin/likes", { rows, pagination });
});
r.post("/likes/:id/delete", async (req, res) => {
  const like = await get(
    `SELECT l.id, l.ip, p.title, p.slug_id
     FROM likes l JOIN pages p ON p.id = l.page_id
     WHERE l.id=?`,
    [req.params.id],
  );
  await run("DELETE FROM likes WHERE id=?", [req.params.id]);
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Like supprimé par admin",
    {
      user: req.session.user?.username || null,
      page: like ? { title: like.title, slug_id: like.slug_id } : undefined,
      extra: {
        ip,
        likeId: req.params.id,
        likeIp: like?.ip || null,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "info",
    message: "Like supprimé.",
  });
  res.redirect("/admin/likes");
});

function buildPagination(req, totalItems) {
  const requestedPage = Number.parseInt(req.query.page, 10);
  let page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const requestedPerPage = Number.parseInt(req.query.perPage, 10);
  const perPage = PAGE_SIZE_OPTIONS.includes(requestedPerPage)
    ? requestedPerPage
    : DEFAULT_PAGE_SIZE;

  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

  if (page > totalPages) {
    page = totalPages;
  }

  return {
    page,
    perPage,
    totalItems,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    previousPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
    perPageOptions: PAGE_SIZE_OPTIONS,
  };
}

r.get("/events", async (req, res) => {
  const totalRow = await get("SELECT COUNT(*) AS total FROM event_logs");
  const totalEvents = Number(totalRow?.total ?? 0);
  const pagination = buildPagination(req, totalEvents);
  const offset = (pagination.page - 1) * pagination.perPage;
  const events = await all(
    "SELECT id, channel, type, payload, ip, username, created_at FROM event_logs ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [pagination.perPage, offset],
  );

  res.render("admin/events", {
    events,
    pagination,
  });
});

export default r;

function buildViewLeaderboardQuery(fromIso, fromDay, limit) {
  const rawWhere = fromIso ? "WHERE viewed_at >= ?" : "";
  const aggregatedWhere = fromDay ? "WHERE day >= ?" : "";
  const params = [];
  if (fromIso) params.push(fromIso);
  if (fromDay) params.push(fromDay);
  params.push(limit);
  const query = `
    WITH combined AS (
      SELECT page_id, COUNT(*) AS views FROM page_views ${rawWhere} GROUP BY page_id
      UNION ALL
      SELECT page_id, SUM(views) AS views FROM page_view_daily ${aggregatedWhere} GROUP BY page_id
    )
    SELECT p.id, p.title, p.slug_id, SUM(combined.views) AS views
    FROM combined
    JOIN pages p ON p.id = combined.page_id
    GROUP BY combined.page_id
    ORDER BY views DESC, p.title ASC
    LIMIT ?
  `;
  return { query, params };
}
