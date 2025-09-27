import { Router } from "express";
import { get, run, all, randSlugId, incrementView } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { slugify, linkifyInternal } from "../utils/linkify.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
import { listUploads } from "../utils/uploads.js";

const r = Router();

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
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked
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
      (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked
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
  await upsertTags(result.lastID, tags);
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
    (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked
    FROM pages p WHERE slug_id=?`,
    [ip, req.params.slugid],
  );
  if (!page) return res.status(404).send("Page introuvable");
  await incrementView(page.id);
  const tlist = await all(
    "SELECT name FROM tags t JOIN page_tags pt ON t.id=pt.tag_id WHERE pt.page_id=? ORDER BY name",
    [page.id],
  );
  const html = linkifyInternal(page.content);
  res.render("page", { page, html, tags: tlist.map((t) => t.name) });
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
  const base = slugify(title);
  await run(
    "UPDATE pages SET title=?, content=?, slug_base=?, updated_at=CURRENT_TIMESTAMP WHERE slug_id=?",
    [title, content, base, req.params.slugid],
  );
  await run("DELETE FROM page_tags WHERE page_id=?", [p.id]);
  await upsertTags(p.id, tags);
  await sendAdminEvent("Page updated", {
    user: req.session.user?.username,
    page: { title, slug_id: req.params.slugid, slug_base: base },
    extra: { tags },
  });
  res.redirect("/wiki/" + req.params.slugid);
});
r.delete("/delete/:slugid", requireAdmin, async (req, res) => {
  const p = await get(
    "SELECT title, slug_id, slug_base FROM pages WHERE slug_id=?",
    [req.params.slugid],
  );
  await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
  await sendAdminEvent("Page deleted", {
    user: req.session.user?.username,
    page: p,
  });
  res.redirect("/");
});
r.post("/delete/:slugid", requireAdmin, async (req, res) => {
  const p = await get(
    "SELECT title, slug_id, slug_base FROM pages WHERE slug_id=?",
    [req.params.slugid],
  );
  await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
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
           (SELECT COUNT(*) FROM likes WHERE page_id=p.id AND ip=?) AS userLiked
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

async function upsertTags(pageId, csv = "") {
  const names = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  for (const n of names) {
    await run("INSERT OR IGNORE INTO tags(name) VALUES(?)", [n]);
    const tag = await get("SELECT id FROM tags WHERE name=?", [n]);
    await run("INSERT OR IGNORE INTO page_tags(page_id, tag_id) VALUES(?,?)", [
      pageId,
      tag.id,
    ]);
  }
}

export default r;
