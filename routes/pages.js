import { Router } from "express";
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

const r = Router();

const viewCountSelect =
  "COALESCE((SELECT SUM(views) FROM page_view_daily WHERE page_id=p.id),0) + COALESCE((SELECT COUNT(*) FROM page_views WHERE page_id=p.id),0)";

// Home
r.get("/", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const recent = await all(
    `
    SELECT p.id, p.title, p.slug_id, substr(p.content,1,900) AS excerpt, p.created_at,
      (SELECT GROUP_CONCAT(t.name, ',') FROM tags t JOIN page_tags pt ON pt.tag_id=t.id WHERE pt.page_id=p.id) AS tagsCsv,
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id) AS likes,
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked,
      ${viewCountSelect} AS views
    FROM pages p WHERE p.created_at >= ? ORDER BY p.created_at DESC LIMIT 3
  `,
    [ip, weekAgo],
  );

  const allowedSizes = [5, 10, 50, 100, 500];
  const requestedSize = parseInt(req.query.size || "50", 10);
  const size = allowedSizes.includes(requestedSize) ? requestedSize : 50;
  const countRow = await get("SELECT COUNT(*) c FROM pages");
  const total = countRow.c;
  const totalPages = Math.max(1, Math.ceil(total / size));
  let page = parseInt(req.query.page || "1", 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  const offset = (page - 1) * size;
  const rows = await all(
    `
    SELECT p.id, p.title, p.slug_id, substr(p.content,1,1200) AS excerpt, p.created_at,
      (SELECT GROUP_CONCAT(t.name, ',') FROM tags t JOIN page_tags pt ON pt.tag_id=t.id WHERE pt.page_id=p.id) AS tagsCsv,
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id) AS likes,
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked,
      ${viewCountSelect} AS views
    FROM pages p ORDER BY p.created_at DESC LIMIT ? OFFSET ?
  `,
    [ip, size, offset],
  );

  res.render("index", {
    recent,
    rows,
    total,
    page,
    totalPages,
    size,
    sizeOptions: allowedSizes,
  });
});

// Lookup by base
r.get("/lookup/:base", async (req, res) => {
  const row = await get(
    "SELECT slug_id FROM pages WHERE slug_base=? ORDER BY updated_at DESC LIMIT 1",
    [req.params.base],
  );
  if (!row) return res.status(404).send("Page introuvable");
  res.redirect("/wiki/" + row.slug_id);
});

// Create
r.get("/new", requireAdmin, async (req, res) => {
  const uploads = await listUploads();
  res.render("edit", { page: null, tags: "", uploads });
});
r.post("/new", requireAdmin, async (req, res) => {
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
});

// Read
r.get("/wiki/:slugid", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  const page = await get(
    `SELECT p.*,
    (SELECT COUNT(*) FROM likes WHERE page_id=p.id) AS likes,
    (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked,
    ${viewCountSelect} AS views
    FROM pages p WHERE slug_id=?`,
    [ip, req.params.slugid],
  );
  if (!page) return res.status(404).send("Page introuvable");
  await incrementView(page.id, ip);
  page.views = Number(page.views || 0) + 1;
  const tlist = await all(
    "SELECT name FROM tags t JOIN page_tags pt ON t.id=pt.tag_id WHERE pt.page_id=? ORDER BY name",
    [page.id],
  );
  const comments = await all(
    `SELECT id, author, body, created_at
     FROM comments
     WHERE page_id=? AND status='approved'
     ORDER BY created_at ASC`,
    [page.id],
  );
  let commentFeedback = null;
  if (req.session.commentFeedback?.slug === page.slug_id) {
    commentFeedback = req.session.commentFeedback;
    delete req.session.commentFeedback;
  }
  const html = linkifyInternal(page.content);
  res.render("page", {
    page,
    html,
    tags: tlist.map((t) => t.name),
    comments,
    commentFeedback,
  });
});

const COMMENT_COOLDOWN_MS = 60 * 1000;

r.post("/wiki/:slugid/comments", async (req, res) => {
  const page = await get("SELECT id, title, slug_id FROM pages WHERE slug_id=?", [
    req.params.slugid,
  ]);
  if (!page) return res.status(404).send("Page introuvable");

  const author = (req.body.author || "").trim().slice(0, 80);
  const body = (req.body.body || "").trim();
  const captcha = (req.body.captcha || "").trim();
  const honeypot = (req.body.website || "").trim();
  const errors = [];

  if (honeypot) {
    errors.push("Soumission invalide.");
  }
  if (!body) {
    errors.push("Le message est requis.");
  } else if (body.length < 10) {
    errors.push("Le message doit contenir au moins 10 caractères.");
  } else if (body.length > 2000) {
    errors.push("Le message est trop long (2000 caractères max).");
  }
  if (captcha !== "7") {
    errors.push("Merci de répondre correctement à la question anti-spam (3 + 4).");
  }

  const now = Date.now();
  if (req.session.lastCommentAt && now - req.session.lastCommentAt < COMMENT_COOLDOWN_MS) {
    const wait = Math.ceil((COMMENT_COOLDOWN_MS - (now - req.session.lastCommentAt)) / 1000);
    errors.push(`Merci de patienter ${wait} seconde(s) avant de publier un nouveau commentaire.`);
  }

  if (errors.length) {
    req.session.commentFeedback = {
      slug: page.slug_id,
      errors,
      values: { author, body },
    };
    return res.redirect(`/wiki/${page.slug_id}#comments`);
  }

  await run(
    "INSERT INTO comments(page_id, author, body) VALUES(?,?,?)",
    [page.id, author || null, body],
  );

  req.session.lastCommentAt = now;
  req.session.commentFeedback = {
    slug: page.slug_id,
    success: true,
  };

  await sendAdminEvent("Nouveau commentaire", {
    page,
    comment: {
      author: author || "Anonyme",
      preview: body.slice(0, 200),
    },
  });

  res.redirect(`/wiki/${page.slug_id}#comments`);
});

// Like toggle
r.post("/wiki/:slugid/like", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  const page = await get(
    "SELECT id, slug_id, title, slug_base FROM pages WHERE slug_id=?",
    [req.params.slugid],
  );
  if (!page) return res.status(404).send("Page introuvable");
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
});

// Edit/Delete
r.get("/edit/:slugid", requireAdmin, async (req, res) => {
  const p = await get("SELECT * FROM pages WHERE slug_id=?", [
    req.params.slugid,
  ]);
  if (!p) return res.status(404).send("Page introuvable");
  const tlist = await all(
    "SELECT name FROM tags t JOIN page_tags pt ON t.id=pt.tag_id WHERE pt.page_id=?",
    [p.id],
  );
  const uploads = await listUploads();
  res.render("edit", {
    page: p,
    tags: tlist.map((t) => t.name).join(", "),
    uploads,
  });
});
r.post("/edit/:slugid", requireAdmin, async (req, res) => {
  const { title, content, tags } = req.body;
  const p = await get("SELECT * FROM pages WHERE slug_id=?", [
    req.params.slugid,
  ]);
  if (!p) return res.status(404).send("Page introuvable");
  await recordRevision(p.id, p.title, p.content, req.session.user?.id || null);
  const base = slugify(title);
  await run(
    "UPDATE pages SET title=?, content=?, slug_base=?, updated_at=CURRENT_TIMESTAMP WHERE slug_id=?",
    [title, content, base, req.params.slugid],
  );
  await run("DELETE FROM page_tags WHERE page_id=?", [p.id]);
  const tagNames = await upsertTags(p.id, tags);
  await recordRevision(p.id, title, content, req.session.user?.id || null);
  await savePageFts({
    id: p.id,
    title,
    content,
    slug_id: p.slug_id,
    tags: tagNames.join(" "),
  });
  await sendAdminEvent("Page updated", {
    user: req.session.user?.username,
    page: { title, slug_id: req.params.slugid, slug_base: base },
    extra: { tags },
  });
  res.redirect("/wiki/" + req.params.slugid);
});
r.delete("/delete/:slugid", requireAdmin, async (req, res) => {
  const p = await get(
    "SELECT id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
    [req.params.slugid],
  );
  await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
  if (p?.id) {
    await removePageFts(p.id);
  }
  await sendAdminEvent("Page deleted", {
    user: req.session.user?.username,
    page: p,
  });
  res.redirect("/");
});
r.post("/delete/:slugid", requireAdmin, async (req, res) => {
  const p = await get(
    "SELECT id, title, slug_id, slug_base FROM pages WHERE slug_id=?",
    [req.params.slugid],
  );
  await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
  if (p?.id) {
    await removePageFts(p.id);
  }
  await sendAdminEvent("Page deleted", {
    user: req.session.user?.username,
    page: p,
  });
  res.redirect("/");
});

// Tag listing with like state
r.get("/tags/:name", async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  const pages = await all(
    `
    SELECT p.id, p.title, p.slug_id, substr(p.content,1,1200) AS excerpt, p.created_at,
           (SELECT GROUP_CONCAT(t2.name, ',') FROM tags t2 JOIN page_tags pt2 ON pt2.tag_id=t2.id WHERE pt2.page_id=p.id) AS tagsCsv,
           (SELECT COUNT(*) FROM likes WHERE page_id=p.id) AS likes,
           (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked,
           ${viewCountSelect} AS views
      FROM pages p
      JOIN page_tags pt ON p.id=pt.page_id
      JOIN tags t ON t.id=pt.tag_id
     WHERE t.name=?
     ORDER BY p.updated_at DESC
  `,
    [ip, req.params.name],
  );
  res.render("tags", { tag: req.params.name, pages });
});

// Revisions
r.get("/wiki/:slugid/history", requireAdmin, async (req, res) => {
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
});

r.get("/wiki/:slugid/revisions/:revisionId", requireAdmin, async (req, res) => {
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
});

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

export default r;
