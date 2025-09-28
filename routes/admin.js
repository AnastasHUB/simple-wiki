import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { all, get, run, randSlugId } from "../db.js";
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
} from "../utils/settingsService.js";
import { pushNotification } from "../utils/notifications.js";

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
  const bans = await all(
    `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      ORDER BY created_at DESC
      LIMIT 200`,
  );
  res.render("admin/ip_bans", {
    bans,
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
  const rows = await all(`
    SELECT p.slug_base, p.slug_id, p.title, p.content, p.created_at, p.updated_at,
      (SELECT GROUP_CONCAT(t.name, ',') FROM tags t
        JOIN page_tags pt ON pt.tag_id = t.id
       WHERE pt.page_id = p.id) AS tagsCsv
    FROM pages p
    ORDER BY p.created_at ASC
  `);
  const pages = rows.map((r) => ({
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
  const likes = await all(`
    SELECT l.id, l.page_id, p.slug_id, l.ip, l.created_at
      FROM likes l
      JOIN pages p ON p.id = l.page_id
     ORDER BY l.created_at ASC`);
  const comments = await all(`
    SELECT c.snowflake_id AS id, c.page_id, p.slug_id, c.author, c.body, c.status, c.created_at, c.updated_at, c.ip
      FROM comments c
      JOIN pages p ON p.id = c.page_id
     ORDER BY c.created_at ASC`);
  const viewEvents = await all(`
    SELECT pv.page_id, p.slug_id, pv.ip, pv.viewed_at
      FROM page_views pv
      JOIN pages p ON p.id = pv.page_id
     ORDER BY pv.viewed_at ASC`);
  const aggregatedViews = await all(`
    SELECT page_id, day, views FROM page_view_daily ORDER BY day ASC`);
  const ipBans = await all(
    "SELECT snowflake_id AS id, ip, scope, value, reason, created_at, lifted_at FROM ip_bans ORDER BY created_at ASC",
  );
  const events = await all(
    "SELECT id, channel, type, payload, ip, username, created_at FROM event_logs ORDER BY created_at ASC",
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const date = new Date().toISOString().split("T")[0];
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="wiki-pages-${date}.json"`,
  );
  const payload = {
    exported_at: new Date().toISOString(),
    count: pages.length,
    pages,
    likes,
    comments,
    views: {
      events: viewEvents,
      daily: aggregatedViews,
    },
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

      const tagCache = new Map();
      const summary = { created: 0, updated: 0, skipped: 0, errors: [] };

      for (let idx = 0; idx < pages.length; idx++) {
        const item = pages[idx] || {};
        const title = typeof item.title === "string" ? item.title.trim() : "";
        const content = typeof item.content === "string" ? item.content : "";
        if (!title || !content) {
          summary.errors.push(`Entrée #${idx + 1}: titre ou contenu manquant.`);
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
          const result = await run(
            "INSERT INTO pages(slug_base, slug_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?)",
            [slugBase, slugId, title, content, createdAt, updatedAt],
          );
          pageId = result.lastID;
          summary.created++;
        }

        await run("DELETE FROM page_tags WHERE page_id=?", [pageId]);
        for (const tagName of tags) {
          let tagId = tagCache.get(tagName);
          if (!tagId) {
            await run("INSERT OR IGNORE INTO tags(name) VALUES(?)", [tagName]);
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
              "INSERT OR IGNORE INTO page_tags(page_id, tag_id) VALUES(?,?)",
              [pageId, tagId],
            );
          }
        }
      }

      if (summary.errors.length) {
        req.session.importResult = summary;
      } else {
        delete req.session.importResult;
      }
      const baseSummaryMessage =
        `${summary.created} article(s) créé(s), ${summary.updated} article(s) mis à jour, ${summary.skipped} article(s) ignoré(s).`;
      const importSummaryMessage = summary.errors.length
        ? `Import terminé : ${baseSummaryMessage} ${summary.errors.length} erreur(s) à consulter.`
        : `Import terminé avec succès : ${baseSummaryMessage}`;
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
    "INSERT INTO users(username,password,is_admin) VALUES(?,?,1)",
    [username, hashed],
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
r.get("/likes", async (_req, res) => {
  const rows = await all(`
    SELECT l.id, l.ip, l.created_at, p.title, p.slug_id
    FROM likes l JOIN pages p ON p.id=l.page_id
    ORDER BY l.created_at DESC LIMIT 500
  `);
  res.render("admin/likes", { rows });
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

r.get("/events", async (req, res) => {
  const pageSize = 50;
  const requestedPage = Number.parseInt(req.query.page, 10);
  let page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const totalRow = await get("SELECT COUNT(*) AS total FROM event_logs");
  const totalEvents = Number(totalRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalEvents / pageSize));

  if (page > totalPages) {
    page = totalPages;
  }

  const offset = (page - 1) * pageSize;
  const events = await all(
    "SELECT id, channel, type, payload, ip, username, created_at FROM event_logs ORDER BY created_at DESC LIMIT ? OFFSET ?",
    [pageSize, offset],
  );

  res.render("admin/events", {
    events,
    pagination: {
      page,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      previousPage: page > 1 ? page - 1 : null,
      nextPage: page < totalPages ? page + 1 : null,
    },
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
