import express from "express";
import session from "express-session";
import methodOverride from "method-override";
import morgan from "morgan";
import path from "path";
import expressLayouts from "express-ejs-layouts";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { sessionConfig } from "./utils/config.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import accountRoutes from "./routes/account.js";
import pagesRoutes from "./routes/pages.js";
import searchRoutes from "./routes/search.js";
import chatbotRoutes from "./routes/chatbot.js";
import { getSiteSettings } from "./utils/settingsService.js";
import { consumeNotifications } from "./utils/notifications.js";
import { getClientIp, getClientUserAgent } from "./utils/ip.js";
import { getAdminActionCounts } from "./utils/adminTasks.js";
import { trackLiveVisitor } from "./utils/liveStats.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await initDb();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

// Allow larger rich-text form submissions (e.g. with embedded images).
const urlencodedBodyLimit = process.env.URLENCODED_BODY_LIMIT || "10mb";
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "2mb";
app.use(express.json({ limit: jsonBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: urlencodedBodyLimit }));
app.use(methodOverride("_method"));
app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "public")));

app.use(session(sessionConfig));

app.use((req, res, next) => {
  const originalUrl = req.originalUrl || req.url || "/";
  const isStatic =
    originalUrl.startsWith("/public/") ||
    originalUrl.startsWith("/docs/") ||
    originalUrl.startsWith("/scripts/") ||
    originalUrl.startsWith("/favicon");
  if (!isStatic && req.method !== "OPTIONS") {
    const ip = getClientIp(req);
    if (ip) {
      const userAgent = getClientUserAgent(req);
      trackLiveVisitor(ip, originalUrl, { userAgent });
    }
  }
  next();
});

// expose user + settings to views
app.use(async (req, res, next) => {
  try {
    res.locals.user = req.session.user || null;
    const settings = await getSiteSettings();
    res.locals.wikiName = settings.wikiName;
    res.locals.logoUrl = settings.logoUrl;
    res.locals.footerText = settings.footerText;
    res.locals.notifications = consumeNotifications(req);
    res.locals.canViewIpProfile = Boolean(getClientIp(req));
    if (res.locals.user?.is_admin) {
      try {
        const counts = await getAdminActionCounts();
        res.locals.adminActionCounts = {
          pendingComments: 0,
          pendingSubmissions: 0,
          suspiciousIps: 0,
          pendingBanAppeals: 0,
          ...counts,
        };
      } catch (actionErr) {
        console.error("Unable to load admin action counts", actionErr);
        res.locals.adminActionCounts = {
          pendingComments: 0,
          pendingSubmissions: 0,
          suspiciousIps: 0,
          pendingBanAppeals: 0,
        };
      }
    }
    next();
  } catch (err) {
    next(err);
  }
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
app.use("/account", accountRoutes);
app.use("/admin", adminRoutes);
app.use("/", searchRoutes);
app.use("/", chatbotRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).render("error", {
    message: "Une erreur inattendue est survenue.",
  });
});

app.use((req, res) => res.status(404).render("page404"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Wiki on http://localhost:" + port));
