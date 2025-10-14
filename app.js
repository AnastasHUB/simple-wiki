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
import { consumeNotifications } from "./utils/notifications.js";
import { getClientIp, getClientUserAgent } from "./utils/ip.js";
import { getAdminActionCounts } from "./utils/adminTasks.js";
import { trackLiveVisitor } from "./utils/liveStats.js";
import { getEveryoneRole } from "./utils/roleService.js";
import {
  ADMIN_ACTION_FLAGS,
  DEFAULT_ROLE_FLAGS,
  mergeRoleFlags,
} from "./utils/roleFlags.js";
import { getSiteSettings } from "./utils/settingsService.js";
import { setupLiveStatsWebSocket } from "./utils/liveStatsWebsocket.js";
import { getRecaptchaConfig } from "./utils/captcha.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import { csrfProtection } from "./middleware/csrf.js";
import { startScheduledPublicationJob } from "./utils/pageScheduler.js";
import { buildFeedExcerpt, buildFeedMarkdown, buildRssFeed } from "./utils/rssFeed.js";

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
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: urlencodedBodyLimit }));
app.use(methodOverride("_method"));
app.use(morgan("dev"));
app.use("/public", express.static(path.join(__dirname, "public")));

const globalRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  limit: 300,
  message:
    "Trop de requêtes ont été détectées depuis votre adresse IP. Veuillez patienter avant de réessayer.",
});
app.use(globalRateLimiter);

const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);
app.use(csrfProtection());

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
    const currentUser = req.session.user || null;
    const everyoneRole = await getEveryoneRole();
    const basePermissions = everyoneRole
      ? mergeRoleFlags(DEFAULT_ROLE_FLAGS, everyoneRole)
      : { ...DEFAULT_ROLE_FLAGS };
    let effectivePermissions = { ...basePermissions };
    let normalizedUser = currentUser;
    if (currentUser) {
      effectivePermissions = mergeRoleFlags(basePermissions, currentUser);
      normalizedUser = { ...currentUser, ...effectivePermissions };
      req.session.user = normalizedUser;
    }
    req.permissionFlags = effectivePermissions;
    res.locals.permissions = effectivePermissions;
    res.locals.user = normalizedUser;
    const settings = await getSiteSettings();
    res.locals.wikiName = settings.wikiName;
    res.locals.logoUrl = settings.logoUrl;
    res.locals.footerText = settings.footerText;
    res.locals.changelogRepo = settings.githubRepo;
    res.locals.changelogMode = settings.changelogMode;
    res.locals.hasChangelog = Boolean(settings.githubRepo);
    req.changelogSettings = {
      repo: settings.githubRepo,
      mode: settings.changelogMode,
    };
    res.locals.notifications = consumeNotifications(req);
    res.locals.canViewIpProfile = Boolean(getClientIp(req));
    const captchaConfig = getRecaptchaConfig();
    res.locals.registrationEnabled = Boolean(captchaConfig);
    const hasAdminActionPermission = currentUser
      ? ADMIN_ACTION_FLAGS.some((flag) => currentUser[flag])
      : false;
    const isStaff = Boolean(
      currentUser?.is_admin ||
        currentUser?.is_moderator ||
        hasAdminActionPermission,
    );
    if (isStaff) {
      try {
        const counts = await getAdminActionCounts();
        res.locals.adminActionCounts = {
          pendingComments: 0,
          pendingSubmissions: 0,
          suspiciousIps: 0,
          pendingBanAppeals: 0,
          scheduledPages: 0,
          ...counts,
        };
      } catch (actionErr) {
        console.error("Unable to load admin action counts", actionErr);
        res.locals.adminActionCounts = {
          pendingComments: 0,
          pendingSubmissions: 0,
          suspiciousIps: 0,
          pendingBanAppeals: 0,
          scheduledPages: 0,
        };
      }
    }
    next();
  } catch (err) {
    next(err);
  }
});

app.get("/rss.xml", async (req, res) => {
  const { all } = await import("./db.js");
  const rows = await all(`
    SELECT
      p.id,
      p.title,
      p.slug_id,
      p.content,
      p.author,
      p.created_at AS createdAt,
      COALESCE(p.updated_at, p.created_at) AS updatedAt,
      GROUP_CONCAT(t.name, ',') AS tags
    FROM pages p
    LEFT JOIN page_tags pt ON pt.page_id = p.id
    LEFT JOIN tags t ON t.id = pt.tag_id
    WHERE p.status = 'published'
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 50
  `);

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const wikiName = res.locals.wikiName || "Wiki";
  const siteTitle = `${wikiName} · RSS`;
  const siteDescription = `${wikiName} — Dernières publications`;

  const items = rows.map((row) => {
    const pageUrl = `${baseUrl}/wiki/${row.slug_id}`;
    const discordMarkdown = buildFeedMarkdown(row.content);
    const excerpt = buildFeedExcerpt(discordMarkdown, 320);
    const categories = row.tags
      ? Array.from(
          new Set(
            row.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        )
      : [];

    return {
      title: row.title,
      link: pageUrl,
      guid: pageUrl,
      pubDate: row.createdAt,
      updated: row.updatedAt,
      author: row.author || undefined,
      description: excerpt,
      content: discordMarkdown,
      categories,
    };
  });

  const xml = buildRssFeed({
    siteTitle,
    siteLink: `${baseUrl}/`,
    siteDescription,
    language: "fr-FR",
    atomLink: `${baseUrl}/rss.xml`,
    items,
  });

  res.type("application/rss+xml").send(xml);
});

app.use("/", pagesRoutes);
app.use("/", authRoutes);
app.use("/account", accountRoutes);
app.use("/admin", adminRoutes);
app.use("/", searchRoutes);

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
const server = app.listen(port, () =>
  console.log("Wiki on http://localhost:" + port),
);

setupLiveStatsWebSocket(server, sessionMiddleware);
startScheduledPublicationJob();
