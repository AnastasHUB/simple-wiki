import express from "express";
import session from "express-session";
import methodOverride from "method-override";
import morgan from "morgan";
import path from "path";
import expressLayouts from "express-ejs-layouts";
import { fileURLToPath } from "url";
import { initDb, get, run } from "./db.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import pagesRoutes from "./routes/pages.js";
import searchRoutes from "./routes/search.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await initDb();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "change-me",
    resave: false,
    saveUninitialized: false,
  }),
);

// expose user + settings to views
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  const settings = await get(
    "SELECT wiki_name AS wikiName, logo_url AS logoUrl, admin_webhook_url AS adminWebhook, feed_webhook_url AS feedWebhook, footer_text AS footerText FROM settings LIMIT 1",
  );
  res.locals.wikiName = settings?.wikiName || "Wiki";
  res.locals.logoUrl = settings?.logoUrl || "";
  res.locals.footerText = settings?.footerText || "";
  next();
});

app.get("/rss.xml", async (req, res) => {
  const rows = await (
    await import("./db.js")
  ).all(`
    SELECT id, title, slug_id, substr(content,1,500) AS excerpt, datetime(created_at) as pubDate
    FROM pages ORDER BY created_at DESC LIMIT 50
  `);
  const base = req.protocol + "://" + req.get("host");
  const title = res.locals.wikiName + " · RSS";
  const items = rows
    .map(
      (r) => `
    <item>
      <title><![CDATA[${r.title}]]></title>
      <link>${base}/wiki/${r.slug_id}</link>
      <guid isPermaLink="false">${r.slug_id}</guid>
      <pubDate>${r.pubDate}</pubDate>
      <description><![CDATA[${r.excerpt}]]></description>
    </item>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${title}</title>
  <link>${base}/</link>
  <description>${title}</description>
  ${items}
</channel></rss>`;
  res.type("application/rss+xml").send(xml);
});

app.use("/", pagesRoutes);
app.use("/", authRoutes);
app.use("/admin", adminRoutes);
app.use("/", searchRoutes);

app.use((req, res) => res.status(404).render("page404"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Wiki on http://localhost:" + port));
