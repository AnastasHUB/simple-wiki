import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { all, get, run, randSlugId } from "../db.js";
import { slugify } from "../utils/linkify.js";
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
  };
  res.send(JSON.stringify(payload, null, 2));
});

r.post(
  "/pages/import",
  jsonUpload.single("archive"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        req.session.importResult = { errors: ["Aucun fichier importé."] };
        return res.redirect("/admin/pages");
      }

      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString("utf8"));
      } catch (err) {
        req.session.importResult = {
          errors: ["Le fichier JSON est invalide: " + (err?.message || err)],
        };
        return res.redirect("/admin/pages");
      }

      const pages = Array.isArray(parsed) ? parsed : parsed?.pages;
      if (!Array.isArray(pages)) {
        req.session.importResult = {
          errors: ['Structure inattendue: un tableau "pages" est requis.'],
        };
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

      req.session.importResult = summary;
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
    return res
      .status(400)
      .json({ ok: false, message: err.message || "Erreur lors de l'upload" });
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
  res.redirect("/admin/uploads");
});

r.post("/uploads/:id/delete", async (req, res) => {
  await removeUpload(req.params.id);
  res.redirect("/admin/uploads");
});

// settings
r.get("/settings", async (_req, res) => {
  const s = await get("SELECT * FROM settings WHERE id=1");
  res.render("admin/settings", { s });
});
r.post("/settings", async (req, res) => {
  const {
    wiki_name,
    logo_url,
    admin_webhook_url,
    feed_webhook_url,
    footer_text,
  } = req.body;
  await run(
    "UPDATE settings SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=? WHERE id=1",
    [wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text],
  );
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
  if (!username || !password) return res.redirect("/admin/users");
  await run("INSERT INTO users(username,password,is_admin) VALUES(?,?,1)", [
    username,
    password,
  ]);
  res.redirect("/admin/users");
});
r.post("/users/:id/delete", async (req, res) => {
  await run("DELETE FROM users WHERE id=?", [req.params.id]);
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
  await run("DELETE FROM likes WHERE id=?", [req.params.id]);
  res.redirect("/admin/likes");
});

export default r;
