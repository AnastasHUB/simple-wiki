import { Router } from "express";
import {
  get,
  run,
  all,
  randId,
  incrementView,
  savePageFts,
  removePageFts,
} from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { slugify, linkifyInternal } from "../utils/linkify.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
import { listUploads } from "../utils/uploads.js";
import { getClientIp, getClientUserAgent } from "../utils/ip.js";
import { getActiveBans, isIpBanned } from "../utils/ipBans.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { pushNotification } from "../utils/notifications.js";
import { upsertTags, recordRevision } from "../utils/pageEditing.js";
import { createPageSubmission } from "../utils/pageSubmissionService.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import {
  getIpProfileByHash,
  hashIp,
  touchIpProfile,
  IP_PROFILE_COMMENT_PAGE_SIZES,
} from "../utils/ipProfiles.js";
import {
  fetchPaginatedPages,
  fetchPageWithStats,
  fetchPageTags,
  fetchPageComments,
  fetchPagesByTag,
  countPages,
  countPagesByTag,
} from "../utils/pageService.js";
import {
  validateCommentSubmission,
  validateCommentBody,
} from "../utils/commentValidation.js";
import {
  getRecaptchaConfig,
  verifyRecaptchaResponse,
} from "../utils/captcha.js";
import { buildPreviewHtml } from "../utils/htmlPreview.js";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  buildPagination,
  decoratePagination,
  buildPaginationView,
} from "../utils/pagination.js";
import {
  resolvePublicationState,
  formatPublishAtForInput,
  PAGE_STATUS_VALUES,
} from "../utils/publicationState.js";
import {
  createBanAppeal,
  hasPendingBanAppeal,
  hasRejectedBanAppeal,
} from "../utils/banAppeals.js";
import { buildPageMeta } from "../utils/meta.js";
import {
  fetchGitHubChangelog,
  CHANGELOG_PAGE_SIZES,
  DEFAULT_CHANGELOG_PAGE_SIZE,
  normalizeChangelogMode,
  GITHUB_CHANGELOG_MODES,
} from "../utils/githubService.js";
import {
  resolveHandleColors,
  getHandleColor,
} from "../utils/userHandles.js";
import {
  renderMarkdownDiff,
  hasMeaningfulDiff,
} from "../utils/diffRenderer.js";

const r = Router();
const commentRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  message:
    "Trop de commentaires ont été envoyés en peu de temps depuis votre adresse IP. Veuillez patienter avant de réessayer.",
});

const PAGE_STATUS_LABELS = {
  draft: "Brouillon",
  published: "Publié",
  scheduled: "Planifié",
};

function buildStatusOptions(selectedStatus = "published", { canSchedule = false } = {}) {
  const allowedStatuses = PAGE_STATUS_VALUES.filter(
    (status) => status !== "scheduled" || canSchedule,
  );
  const normalizedSelection = allowedStatuses.includes(selectedStatus)
    ? selectedStatus
    : allowedStatuses[0] || "published";
  return allowedStatuses.map((status) => ({
    value: status,
    label: PAGE_STATUS_LABELS[status] || status,
    selected: status === normalizedSelection,
  }));
}

function buildEditorRenderContext(baseContext = {}) {
  const {
    page = null,
    tags = "",
    uploads = [],
    submissionMode = false,
    allowUploads = false,
    authorName = "",
    canChooseStatus = false,
    canSchedule = false,
    formState = {},
    validationErrors = [],
  } = baseContext;

  const fallbackStatus = page?.status || "published";
  const selectedStatus =
    typeof formState.status === "string" && formState.status
      ? formState.status
      : fallbackStatus;
  const publishAtValue =
    typeof formState.publishAt === "string"
      ? formState.publishAt
      : formatPublishAtForInput(page?.publish_at || null);

  return {
    page,
    tags,
    uploads,
    submissionMode,
    allowUploads,
    authorName,
    canChooseStatus,
    canSchedule,
    formState,
    statusOptions: buildStatusOptions(selectedStatus, { canSchedule }),
    publishAtValue,
    validationErrors,
  };
}

r.use(
  asyncHandler(async (req, res, next) => {
    req.clientIp = getClientIp(req);
    req.clientUserAgent = getClientUserAgent(req);
    if (req.clientIp) {
      const ban = await isIpBanned(req.clientIp, { action: "view" });
      const isAppealRoute = req.path === "/ban-appeal";
      if (ban && ban.scope === "global" && !isAppealRoute) {
        return res.status(403).render("banned", { ban });
      }
    }
    next();
  }),
);

function appendNotification(res, notif) {
  if (!notif?.message) {
    return;
  }
  const existing = Array.isArray(res.locals.notifications)
    ? res.locals.notifications.slice()
    : [];
  existing.push({
    timeout: 5000,
    ...notif,
  });
  res.locals.notifications = existing;
}

r.get(
  "/api/pages/suggest",
  asyncHandler(async (req, res) => {
    const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
    const searchTerm = rawQuery.trim();
    if (!searchTerm) {
      return res.json({ ok: true, results: [] });
    }

    const sanitized = searchTerm.replace(/[%_]/g, "\\$&");
    const likeTerm = `%${sanitized}%`;

    const rows = await all(
      `
      SELECT title, slug_id
      FROM pages
      WHERE title LIKE ? ESCAPE '\\'
        AND status = 'published'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 8
    `,
      [likeTerm],
    );

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      results: rows.map((row) => ({ title: row.title, slug: row.slug_id })),
    });
  }),
);

async function resolveAppealContext(
  req,
  { requestedScope = null, requestedValue = null } = {},
) {
  const ip = req.clientIp || getClientIp(req);
  const bans = ip ? await getActiveBans(ip) : [];
  let ban = null;
  if (requestedScope) {
    ban =
      bans.find(
        (b) =>
          b.scope === requestedScope &&
          (b.value || "") === (requestedValue || ""),
      ) || null;
  }
  if (!ban && bans.length) {
    [ban] = bans;
  }

  const sessionLock = req.session.banAppealLock || null;
  const pendingFromDb = ip ? await hasPendingBanAppeal(ip) : false;
  const rejectedFromDb = ip ? await hasRejectedBanAppeal(ip) : false;

  return {
    ip,
    ban,
    bans,
    sessionLock,
    pendingFromDb,
    rejectedFromDb,
  };
}

function buildAppealUrl({ scope, value } = {}) {
  const params = new URLSearchParams();
  if (scope) {
    params.set("scope", scope);
  }
  if (value) {
    params.set("value", value);
  }
  const qs = params.toString();
  return qs ? `/ban-appeal?${qs}` : "/ban-appeal";
}

const CHANGELOG_PAGE_PARAM = "page";
const CHANGELOG_PER_PAGE_PARAM = "perPage";

function resolveChangelogPage(rawPage) {
  const parsed = Number.parseInt(rawPage, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 1;
}

function resolveChangelogPageSize(rawValue) {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isInteger(parsed) && CHANGELOG_PAGE_SIZES.includes(parsed)) {
    return parsed;
  }
  return DEFAULT_CHANGELOG_PAGE_SIZE;
}

function buildChangelogPagination(req, { page, perPage, hasNext }) {
  const hasPrevious = page > 1;
  const baseParams = new URLSearchParams();
  if (req?.query) {
    for (const [key, rawValue] of Object.entries(req.query)) {
      if (key === CHANGELOG_PAGE_PARAM || key === CHANGELOG_PER_PAGE_PARAM)
        continue;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value === undefined || value === null || value === "") continue;
        baseParams.append(key, String(value));
      }
    }
  }

  const buildUrl = (pageValue) => {
    const params = new URLSearchParams(baseParams.toString());
    params.set(CHANGELOG_PAGE_PARAM, String(pageValue));
    params.set(CHANGELOG_PER_PAGE_PARAM, String(perPage));
    return `?${params.toString()}`;
  };

  const perPageOptionLinks = CHANGELOG_PAGE_SIZES.map((size) => {
    const params = new URLSearchParams(baseParams.toString());
    params.set(CHANGELOG_PAGE_PARAM, "1");
    params.set(CHANGELOG_PER_PAGE_PARAM, String(size));
    return {
      value: size,
      selected: size === perPage,
      url: `?${params.toString()}`,
    };
  });

  return {
    page,
    perPage,
    hasPrevious,
    hasNext,
    previousUrl: hasPrevious ? buildUrl(page - 1) : null,
    nextUrl: hasNext ? buildUrl(page + 1) : null,
    perPageOptionLinks,
  };
}

function buildChangelogModeOptions(selectedMode) {
  const normalized = normalizeChangelogMode(selectedMode);
  return [
    {
      value: GITHUB_CHANGELOG_MODES.COMMITS,
      label: "Commits",
      selected: normalized === GITHUB_CHANGELOG_MODES.COMMITS,
    },
    {
      value: GITHUB_CHANGELOG_MODES.PULLS,
      label: "Pull requests",
      selected: normalized === GITHUB_CHANGELOG_MODES.PULLS,
    },
  ];
}

r.get(
  "/",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;

    const total = await countPages();
    const paginationOptions = {
      pageParam: "page",
      perPageParam: "size",
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
    };
    const pagination = buildPaginationView(req, total, paginationOptions);
    const offset = (pagination.page - 1) * pagination.perPage;

    const mapPreview = (row) => ({
      ...row,
      excerpt: buildPreviewHtml(row.excerpt),
    });

    const rowsRaw = await fetchPaginatedPages({
      ip,
      limit: pagination.perPage,
      offset,
    });
    const rows = rowsRaw.map(mapPreview);

    res.render("index", {
      rows,
      total,
      pagination,
    });
  }),
);

r.get(
  "/changelog",
  asyncHandler(async (req, res) => {
    const repoFromSettings =
      req.changelogSettings?.repo || res.locals.changelogRepo || "";
    if (!repoFromSettings) {
      return res.status(404).render("page404");
    }

    const defaultMode = req.changelogSettings?.mode || res.locals.changelogMode;
    const requestedMode = req.query.mode || defaultMode;
    const mode = normalizeChangelogMode(requestedMode);
    const page = resolveChangelogPage(req.query[CHANGELOG_PAGE_PARAM]);
    const perPage = resolveChangelogPageSize(
      req.query[CHANGELOG_PER_PAGE_PARAM],
    );

    let entries = [];
    let fetchError = null;
    let hasNext = false;
    let rateLimit = null;

    try {
      const result = await fetchGitHubChangelog({
        repo: repoFromSettings,
        mode,
        perPage,
        page,
      });
      entries = result.entries;
      hasNext = result.hasNext;
      rateLimit = result.rateLimit;
    } catch (err) {
      fetchError = err;
    }

    const pagination = buildChangelogPagination(req, {
      page,
      perPage,
      hasNext,
    });
    const modeOptions = buildChangelogModeOptions(mode);

    res.status(fetchError ? 502 : 200).render("changelog", {
      title: "Changelog",
      repo: repoFromSettings,
      mode,
      entries,
      pagination,
      modeOptions,
      error: fetchError ? fetchError.message : null,
      rateLimit,
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
    const permissions = req.permissionFlags || {};
    if (!permissions.can_submit_pages) {
      return res.status(403).render("error", {
        message: "Vous n'avez pas la permission de contribuer pour le moment.",
      });
    }
    const canPublishDirectly = Boolean(
      permissions.is_admin || permissions.is_contributor,
    );
    const canSchedulePages = Boolean(permissions.can_schedule_pages);
    if (!permissions.is_admin) {
      const ban = await isIpBanned(req.clientIp, { action: "contribute" });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const uploads = permissions.is_admin ? await listUploads() : [];
    const defaultAuthor = getUserDisplayName(req.session.user) || "";
    res.render(
      "edit",
      buildEditorRenderContext({
        page: null,
        tags: "",
        uploads,
        submissionMode: !canPublishDirectly,
        allowUploads: permissions.is_admin,
        authorName: defaultAuthor,
        canChooseStatus: canPublishDirectly,
        canSchedule: canPublishDirectly && canSchedulePages,
      }),
    );
  }),
);

r.post(
  "/new",
  asyncHandler(async (req, res) => {
    const permissions = req.permissionFlags || {};
    if (!permissions.can_submit_pages) {
      return res.status(403).render("error", {
        message: "Vous n'êtes pas autorisé à soumettre de contenu.",
      });
    }
    const { title, content, tags } = req.body;
    const rawAuthorInput =
      typeof req.body.author === "string" ? req.body.author : "";
    const trimmedAuthorInput = rawAuthorInput.trim().slice(0, 80);
    const sessionAuthorName = getUserDisplayName(req.session.user);
    const authorToPersist = trimmedAuthorInput || sessionAuthorName || null;
    const canPublishDirectly = Boolean(
      permissions.is_admin || permissions.is_contributor,
    );
    const canSchedulePages = Boolean(permissions.can_schedule_pages);
    if (!permissions.is_admin) {
      const ban = await isIpBanned(req.clientIp, { action: "contribute" });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    if (!canPublishDirectly) {
      const submissionId = await createPageSubmission({
        type: "create",
        title,
        content,
        tags,
        ip: req.clientIp,
        submittedBy: req.session.user?.username || null,
        authorName: authorToPersist,
      });
      await touchIpProfile(req.clientIp, {
        userAgent: req.clientUserAgent,
      });
      const followAction = req.session.user
        ? { href: "/account/submissions", label: "Suivre mes contributions" }
        : { href: "/profiles/ip/me", label: "Suivre mes contributions" };
      pushNotification(req, {
        type: "success",
        message:
          "Merci ! Votre proposition sera examinée par un administrateur.",
        timeout: 6000,
        action: followAction,
      });
      await sendAdminEvent("Soumission de nouvelle page", {
        page: { title },
        user: req.session.user?.username || null,
        extra: {
          ip: req.clientIp || null,
          submission: submissionId,
          status: "pending",
          author: authorToPersist,
        },
      });
      return res.redirect("/");
    }

    const publication = resolvePublicationState({
      statusInput: req.body.status,
      publishAtInput: req.body.publish_at,
      canSchedule: canSchedulePages,
    });
    if (!publication.isValid) {
      const uploads = permissions.is_admin ? await listUploads() : [];
      const formState = {
        title,
        content,
        tags,
        author: trimmedAuthorInput,
        status: req.body.status || "published",
        publishAt: publication.rawPublishAt,
      };
      return res.status(400).render(
        "edit",
        buildEditorRenderContext({
          page: null,
          tags,
          uploads,
          submissionMode: false,
          allowUploads: permissions.is_admin,
          authorName: authorToPersist || "",
          canChooseStatus: true,
          canSchedule: canPublishDirectly && canSchedulePages,
          formState,
          validationErrors: publication.errors.map((error) => error.message),
        }),
      );
    }

    const base = slugify(title);
    const slug_id = randId();
    const pageSnowflake = generateSnowflake();
    const result = await run(
      "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        pageSnowflake,
        base,
        slug_id,
        title,
        content,
        authorToPersist,
        publication.status,
        publication.publishAt,
      ],
    );
    const tagNames = await upsertTags(result.lastID, tags);
    await recordRevision(
      result.lastID,
      title,
      content,
      req.session.user?.id || null,
    );
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
      extra: {
        tags,
        author: authorToPersist,
        status: publication.status,
        publish_at: publication.publishAt,
      },
    });
    if (publication.status === "published") {
      await sendFeedEvent(
        "Nouvel article",
        {
          page: { title, slug_id, snowflake_id: pageSnowflake },
          author: authorToPersist || "Anonyme",
          url: req.protocol + "://" + req.get("host") + "/wiki/" + slug_id,
          tags,
        },
        { articleContent: content },
      );
    }
    const scheduledLabel = publication.publishAt
      ? new Date(publication.publishAt).toLocaleString("fr-FR")
      : "la date programmée";
    const baseMessage =
      publication.status === "draft"
        ? `"${title}" a été enregistré en brouillon.`
        : publication.status === "scheduled"
          ? `"${title}" est planifié pour publication le ${scheduledLabel}.`
          : `"${title}" a été créé avec succès !`;
    pushNotification(req, {
      type: "success",
      message: baseMessage,
    });
    res.redirect("/wiki/" + slug_id);
  }),
);

r.get(
  "/wiki/:slugid",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const permissions = req.permissionFlags || {};
    const page = await fetchPageWithStats(req.params.slugid, ip, {
      includeUnpublished: Boolean(permissions.is_admin),
    });
    if (!page) return res.status(404).send("Page introuvable");

    const tagNames = await fetchPageTags(page.id);
    const tagBan = await isIpBanned(ip, { action: "view", tags: tagNames });
    if (tagBan) {
      return res.status(403).render("banned", { ban: tagBan });
    }

    await incrementView(page.id, ip);
    page.views = Number(page.views || 0) + 1;
    await touchIpProfile(ip, { userAgent: req.clientUserAgent });

    const totalComments = Number(page.comment_count || 0);
    const commentPaginationOptions = {
      pageParam: "commentsPage",
      perPageParam: "commentsPerPage",
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: [...IP_PROFILE_COMMENT_PAGE_SIZES],
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
    const host = req.get("host") || "localhost";
    const baseUrl = `${req.protocol}://${host}`;
    const meta = buildPageMeta({
      page,
      baseUrl,
      siteName: res.locals.wikiName,
      logoUrl: res.locals.logoUrl,
      tags: tagNames,
      protocol: req.protocol,
    });

    const captchaConfig = getRecaptchaConfig();

    res.render("page", {
      page,
      html,
      tags: tagNames,
      comments,
      commentPagination,
      commentFeedback,
      ownCommentTokens,
      meta,
      captchaConfig,
    });
  }),
);

r.post(
  "/wiki/:slugid/comments/preview",
  commentRateLimiter,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    if (!page) {
      return res.status(404).json({ ok: false, error: "Page introuvable." });
    }

    const permissions = req.permissionFlags || {};
    if (!permissions.can_comment) {
      return res
        .status(403)
        .json({ ok: false, error: "Les commentaires sont désactivés pour votre rôle." });
    }

    const bodyInput = typeof req.body?.body === "string" ? req.body.body : "";
    const validation = validateCommentBody(bodyInput);
    if (validation.errors.length) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }

    const previewHtml = buildPreviewHtml(validation.body);
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, html: previewHtml });
  }),
);

r.post(
  "/wiki/:slugid/comments",
  commentRateLimiter,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, snowflake_id, title, slug_id FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    if (!page) return res.status(404).send("Page introuvable");

    const permissions = req.permissionFlags || {};
    if (!permissions.can_comment) {
      pushNotification(req, {
        type: "error",
        message: "Vous n'êtes pas autorisé à publier des commentaires.",
        timeout: 6000,
      });
      return res.redirect(`/wiki/${req.params.slugid}#comments`);
    }

    const ip = req.clientIp;
    const captchaConfig = getRecaptchaConfig();
    const captchaToken =
      typeof req.body.captchaToken === "string" ? req.body.captchaToken : "";
    const adminDisplayName = permissions.is_admin
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

    const validation = validateCommentSubmission(
      {
        authorInput: req.body.author,
        bodyInput: req.body.body,
        captchaInput: req.body.captcha,
        honeypotInput: req.body.website,
      },
      { skipCaptchaQuestion: Boolean(captchaConfig) },
    );

    if (captchaConfig && validation.errors.length === 0) {
      const captchaResult = await verifyRecaptchaResponse(captchaToken, {
        remoteIp: ip,
      });
      if (!captchaResult.success) {
        validation.errors.push(
          "Merci de répondre correctement à la question anti-spam (3 + 4).",
        );
      }
    }

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

    const token = generateSnowflake();
    const commentSnowflake = generateSnowflake();
    const privilegedCommenter = Boolean(
      permissions.is_admin ||
        permissions.is_moderator ||
        permissions.is_contributor ||
        permissions.is_helper,
    );
    const commentStatus = privilegedCommenter ? "approved" : "pending";
    const insertResult = await run(
      `INSERT INTO comments(
         snowflake_id,
         page_id,
         author,
         body,
         ip,
         edit_token,
         author_is_admin,
         status
       ) VALUES(?,?,?,?,?,?,?,?)`,
      [
        commentSnowflake,
        page.id,
        authorToUse || null,
        validation.body,
        ip || null,
        token,
        permissions.is_admin ? 1 : 0,
        commentStatus,
      ],
    );

    await touchIpProfile(ip, { userAgent: req.clientUserAgent });

    req.session.commentTokens = req.session.commentTokens || {};
    req.session.commentTokens[commentSnowflake] = token;
    if (insertResult?.lastID) {
      req.session.commentTokens[insertResult.lastID] = token;
    }

    delete req.session.commentFeedback;
    const successMessage = privilegedCommenter
      ? "Merci ! Votre commentaire a été publié immédiatement."
      : "Merci ! Votre commentaire a été enregistré et sera publié après validation.";
    pushNotification(req, {
      type: "success",
      message: successMessage,
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
        status: commentStatus,
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
        id: generateSnowflake(),
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
      const reasonText = ban?.reason
        ? `Action interdite : ${ban.reason}`
        : "Action interdite.";
      const appealMessage = reasonText.endsWith(".")
        ? `${reasonText} Vous pouvez envoyer une demande de déban.`
        : `${reasonText}. Vous pouvez envoyer une demande de déban.`;
      const appealUrl = buildAppealUrl(ban);
      if (wantsJson) {
        return res.status(403).json({
          ok: false,
          message: reasonText,
          ban,
          notifications: [
            {
              type: "error",
              message: appealMessage,
              timeout: 6000,
            },
          ],
          redirect: appealUrl,
        });
      }
      appendNotification(res, {
        type: "error",
        message: appealMessage,
        timeout: 6000,
      });
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

    await touchIpProfile(ip, { userAgent: req.clientUserAgent });

    const total = await get(
      "SELECT COUNT(*) AS totalLikes FROM likes WHERE page_id=?",
      [page.id],
    );
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
    const permissions = req.permissionFlags || {};
    if (!permissions.can_submit_pages) {
      return res.status(403).render("error", {
        message: "Vous n'avez pas la permission de proposer des modifications.",
      });
    }
    const canPublishDirectly = Boolean(
      permissions.is_admin || permissions.is_contributor,
    );
    const canSchedulePages = Boolean(permissions.can_schedule_pages);
    if (!permissions.is_admin) {
      const ban = await isIpBanned(req.clientIp, {
        action: "contribute",
        tags: tagNames,
      });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const uploads = permissions.is_admin ? await listUploads() : [];
    const defaultAuthor =
      page.author || getUserDisplayName(req.session.user) || "";
    res.render(
      "edit",
      buildEditorRenderContext({
        page,
        tags: tagNames.join(", "),
        uploads,
        submissionMode: !canPublishDirectly,
        allowUploads: permissions.is_admin,
        authorName: defaultAuthor,
        canChooseStatus: canPublishDirectly,
        canSchedule: canPublishDirectly && canSchedulePages,
      }),
    );
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

    const permissions = req.permissionFlags || {};
    if (!permissions.can_submit_pages) {
      return res.status(403).render("error", {
        message: "Vous n'avez pas la permission de modifier cet article.",
      });
    }
    const canPublishDirectly = Boolean(
      permissions.is_admin || permissions.is_contributor,
    );
    const canSchedulePages = Boolean(permissions.can_schedule_pages);
    if (!permissions.is_admin) {
      const tagNames = await fetchPageTags(page.id);
      const ban = await isIpBanned(req.clientIp, {
        action: "contribute",
        tags: tagNames,
      });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const rawAuthorInput =
      typeof req.body.author === "string" ? req.body.author : "";
    const trimmedAuthorInput = rawAuthorInput.trim().slice(0, 80);
    const sessionAuthorName = getUserDisplayName(req.session.user);
    const authorToPersist =
      trimmedAuthorInput || page.author || sessionAuthorName || null;
    if (!canPublishDirectly) {
      const submissionId = await createPageSubmission({
        type: "edit",
        pageId: page.id,
        title,
        content,
        tags,
        ip: req.clientIp,
        submittedBy: req.session.user?.username || null,
        targetSlugId: page.slug_id,
        authorName: authorToPersist,
      });
      await touchIpProfile(req.clientIp, {
        userAgent: req.clientUserAgent,
      });
      const followAction = req.session.user
        ? { href: "/account/submissions", label: "Suivre mes contributions" }
        : { href: "/profiles/ip/me", label: "Suivre mes contributions" };
      pushNotification(req, {
        type: "success",
        message:
          "Merci ! Votre proposition de mise à jour sera vérifiée avant publication.",
        timeout: 6000,
        action: followAction,
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
          author: authorToPersist,
        },
      });
      return res.redirect("/wiki/" + page.slug_id);
    }

    const publication = resolvePublicationState({
      statusInput: req.body.status ?? page.status,
      publishAtInput: req.body.publish_at ?? formatPublishAtForInput(page.publish_at),
      canSchedule: canSchedulePages,
    });
    if (!publication.isValid) {
      const uploads = permissions.is_admin ? await listUploads() : [];
      const formState = {
        title,
        content,
        tags,
        author: trimmedAuthorInput,
        status: req.body.status ?? page.status,
        publishAt: publication.rawPublishAt || formatPublishAtForInput(page.publish_at),
      };
      return res.status(400).render(
        "edit",
        buildEditorRenderContext({
          page,
          tags: tagNames.join(", "),
          uploads,
          submissionMode: false,
          allowUploads: permissions.is_admin,
          authorName: authorToPersist || "",
          canChooseStatus: true,
          canSchedule: canPublishDirectly && canSchedulePages,
          formState,
          validationErrors: publication.errors.map((error) => error.message),
        }),
      );
    }

    await recordRevision(
      page.id,
      page.title,
      page.content,
      req.session.user?.id || null,
    );
    const base = slugify(title);
    await run(
      "UPDATE pages SET title=?, content=?, slug_base=?, author=?, status=?, publish_at=?, updated_at=CURRENT_TIMESTAMP WHERE slug_id=?",
      [
        title,
        content,
        base,
        authorToPersist,
        publication.status,
        publication.publishAt,
        req.params.slugid,
      ],
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
      extra: {
        tags,
        author: authorToPersist,
        status: publication.status,
        publish_at: publication.publishAt,
      },
    });
    const scheduledLabel = publication.publishAt
      ? new Date(publication.publishAt).toLocaleString("fr-FR")
      : "la date programmée";
    pushNotification(req, {
      type: "success",
      message:
        publication.status === "draft"
          ? `"${title}" a été enregistré comme brouillon.`
          : publication.status === "scheduled"
            ? `"${title}" est planifié pour publication le ${scheduledLabel}.`
            : `"${title}" a été mis à jour !`,
    });
    res.redirect("/wiki/" + req.params.slugid);
  }),
);

async function handlePageDeletion(req, res) {
  const page = await get(
    `SELECT id, snowflake_id, title, content, author, slug_id, slug_base, created_at, updated_at
       FROM pages
      WHERE slug_id=?`,
    [req.params.slugid],
  );

  if (!page) {
    pushNotification(req, {
      type: "error",
      message: "Page introuvable ou déjà supprimée.",
    });
    return res.redirect("/");
  }

  const tags = await fetchPageTags(page.id);
  const [
    existingComments,
    existingLikes,
    existingViewEvents,
    existingViewDaily,
  ] = await Promise.all([
    all(
      `SELECT author, body, created_at, updated_at, ip, edit_token, status, author_is_admin
           FROM comments
          WHERE page_id=?
          ORDER BY id`,
      [page.id],
    ),
    all(
      `SELECT snowflake_id, ip, created_at
           FROM likes
          WHERE page_id=?
          ORDER BY created_at`,
      [page.id],
    ),
    all(
      `SELECT snowflake_id, ip, viewed_at
           FROM page_views
          WHERE page_id=?
          ORDER BY viewed_at`,
      [page.id],
    ),
    all(
      `SELECT snowflake_id, day, views
           FROM page_view_daily
          WHERE page_id=?
          ORDER BY day`,
      [page.id],
    ),
  ]);
  const serializedComments = existingComments.map((comment) => ({
    author: comment.author || null,
    body: comment.body || "",
    created_at: comment.created_at || null,
    updated_at: comment.updated_at || null,
    ip: comment.ip || null,
    edit_token: comment.edit_token || null,
    status: comment.status || "pending",
    author_is_admin: comment.author_is_admin ? 1 : 0,
  }));
  const serializedStats = {
    likes: existingLikes.map((like) => ({
      snowflake_id: like.snowflake_id || null,
      ip: like.ip || null,
      created_at: like.created_at || null,
    })),
    viewEvents: existingViewEvents.map((view) => ({
      snowflake_id: view.snowflake_id || null,
      ip: view.ip || null,
      viewed_at: view.viewed_at || null,
    })),
    viewDaily: existingViewDaily.map((view) => ({
      snowflake_id: view.snowflake_id || null,
      day: view.day,
      views: Math.max(0, Number.isFinite(view.views) ? Number(view.views) : 0),
    })),
  };
  const tagsJson = JSON.stringify(tags || []);
  const commentsJson = serializedComments.length
    ? JSON.stringify(serializedComments)
    : null;
  const hasStats =
    serializedStats.likes.length ||
    serializedStats.viewEvents.length ||
    serializedStats.viewDaily.length;
  const statsJson = hasStats ? JSON.stringify(serializedStats) : null;
  const trashSnowflake = generateSnowflake();
  const pageTitle = page.title || "Cette page";

  await run("BEGIN");
  try {
    await run(
      `INSERT INTO deleted_pages(
         snowflake_id,
         original_page_id,
         page_snowflake_id,
         slug_id,
         slug_base,
         title,
         content,
         author,
         status,
         publish_at,
         tags_json,
         created_at,
         updated_at,
         deleted_by,
         comments_json,
         stats_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trashSnowflake,
        page.id,
        page.snowflake_id,
        page.slug_id,
        page.slug_base,
        page.title,
        page.content,
        page.author || null,
        page.status || "published",
        page.publish_at || null,
        tagsJson,
        page.created_at,
        page.updated_at,
        req.session.user?.username || null,
        commentsJson,
        statsJson,
      ],
    );
    await run("DELETE FROM pages WHERE slug_id=?", [req.params.slugid]);
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    console.error("Failed to move page to trash", error);
    pushNotification(req, {
      type: "error",
      message: "La suppression de la page a échoué. Merci de réessayer.",
    });
    return res.redirect(`/wiki/${req.params.slugid}`);
  }

  await removePageFts(page.id);

  await sendAdminEvent("Page deleted", {
    user: req.session.user?.username,
    page: {
      title: page.title,
      slug_id: page.slug_id,
      snowflake_id: page.snowflake_id,
    },
    extra: {
      trash_id: trashSnowflake,
      tags,
    },
  });

  pushNotification(req, {
    type: "info",
    message: page.title
      ? `« ${pageTitle} » a été déplacée dans la corbeille.`
      : "La page a été déplacée dans la corbeille.",
  });

  res.redirect("/");
}

r.delete("/delete/:slugid", requireAdmin, asyncHandler(handlePageDeletion));
r.post("/delete/:slugid", requireAdmin, asyncHandler(handlePageDeletion));

r.get(
  "/tags/:name",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const requestedTag = req.params.name;
    const tagName = requestedTag.toLowerCase();
    const tagBan = await isIpBanned(ip, {
      action: "view",
      tags: [tagName],
    });
    if (tagBan) {
      return res.status(403).render("banned", { ban: tagBan });
    }
    const total = await countPagesByTag(requestedTag);
    const paginationOptions = {
      pageParam: "page",
      perPageParam: "size",
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
    };
    const pagination = buildPaginationView(req, total, paginationOptions);
    const offset = (pagination.page - 1) * pagination.perPage;
    const pagesRaw =
      total > 0
        ? await fetchPagesByTag({
            tagName: requestedTag,
            ip,
            limit: pagination.perPage,
            offset,
          })
        : [];
    const pages = pagesRaw.map((page) => ({
      ...page,
      excerpt: buildPreviewHtml(page.excerpt),
    }));
    res.render("tags", { tag: requestedTag, pages, pagination, total });
  }),
);

r.get(
  "/wiki/:slugid/history",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = await get(
      "SELECT id, title, slug_id FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    if (!page) return res.status(404).send("Page introuvable");
    const totalRow = await get(
      `SELECT COUNT(*) AS total FROM page_revisions WHERE page_id = ?`,
      [page.id],
    );
    const total = Number(totalRow?.total ?? 0);
    const paginationOptions = {
      pageParam: "page",
      perPageParam: "size",
      defaultPageSize: 20,
      pageSizeOptions: [10, 20, 50, 100],
    };
    const paginationBase = buildPagination(req, total, paginationOptions);
    const offset = (paginationBase.page - 1) * paginationBase.perPage;
    const revisions =
      total > 0
        ? await all(
            `
        SELECT pr.revision, pr.title, pr.created_at, u.username AS author
          FROM page_revisions pr
          LEFT JOIN users u ON u.id = pr.author_id
         WHERE pr.page_id=?
         ORDER BY pr.revision DESC
         LIMIT ? OFFSET ?
      `,
            [page.id, paginationBase.perPage, offset],
          )
        : [];
    const revisionHandleMap = await resolveHandleColors(
      revisions.map((rev) => rev.author),
    );
    const normalizedRevisions = revisions.map((rev) => ({
      ...rev,
      authorRole: getHandleColor(rev.author, revisionHandleMap),
    }));
    const pagination = decoratePagination(
      req,
      paginationBase,
      paginationOptions,
    );
    res.render("history", { page, revisions: normalizedRevisions, pagination, total });
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
    if (Number.isNaN(revNumber))
      return res.status(400).send("Révision invalide");
    const revision = await get(
      `SELECT pr.*, u.username AS author
       FROM page_revisions pr
       LEFT JOIN users u ON u.id = pr.author_id
      WHERE pr.page_id=? AND pr.revision=?`,
      [page.id, revNumber],
    );
    if (!revision) return res.status(404).send("Révision introuvable");
    const revisionsList = await all(
      `SELECT revision, title, created_at
         FROM page_revisions
        WHERE page_id = ?
        ORDER BY revision DESC`,
      [page.id],
    );

    const rawCompareParam =
      typeof req.query.compare === "string" ? req.query.compare.trim() : "";
    const isExplicitCompare = rawCompareParam !== "";
    let compareRevisionNumber = null;
    if (isExplicitCompare) {
      const parsedCompare = Number.parseInt(rawCompareParam, 10);
      if (!Number.isInteger(parsedCompare)) {
        return res.status(400).send("Révision de comparaison invalide");
      }
      if (parsedCompare === revNumber) {
        return res
          .status(400)
          .send("La révision de comparaison doit être différente de la révision consultée");
      }
      compareRevisionNumber = parsedCompare;
    } else {
      const previous = revisionsList.find((rev) => rev.revision < revNumber);
      if (previous) {
        compareRevisionNumber = previous.revision;
      }
    }

    let compareRevision = null;
    if (compareRevisionNumber !== null) {
      compareRevision = await get(
        `SELECT pr.*, u.username AS author
           FROM page_revisions pr
           LEFT JOIN users u ON u.id = pr.author_id
          WHERE pr.page_id=? AND pr.revision=?`,
        [page.id, compareRevisionNumber],
      );
      if (!compareRevision && isExplicitCompare) {
        return res.status(404).send("Révision de comparaison introuvable");
      }
    }

    const handlesToResolve = [revision.author];
    if (compareRevision?.author) {
      handlesToResolve.push(compareRevision.author);
    }
    const revisionHandleMap = await resolveHandleColors(handlesToResolve);
    const revisionAuthorRole = getHandleColor(
      revision.author,
      revisionHandleMap,
    );
    const compareRevisionAuthorRole = compareRevision
      ? getHandleColor(compareRevision.author, revisionHandleMap)
      : null;

    const html = linkifyInternal(revision.content);
    const diffHtml =
      compareRevision && hasMeaningfulDiff(compareRevision.content, revision.content)
        ? renderMarkdownDiff({
            oldContent: compareRevision.content,
            newContent: revision.content,
            oldLabel: `Révision ${compareRevision.revision}`,
            newLabel: `Révision ${revision.revision}`,
          })
        : null;

    const compareOptions = revisionsList
      .filter((rev) => rev.revision !== revision.revision)
      .map((rev) => ({
        ...rev,
        isSelected: compareRevision
          ? rev.revision === compareRevision.revision
          : compareRevisionNumber !== null && rev.revision === compareRevisionNumber,
      }));

    res.render("revision", {
      page,
      revision: { ...revision, authorRole: revisionAuthorRole },
      html,
      rawContent: revision.content,
      compareRevision: compareRevision
        ? { ...compareRevision, authorRole: compareRevisionAuthorRole }
        : null,
      compareOptions,
      diffHtml,
    });
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
    const profile = await touchIpProfile(ip, {
      userAgent: req.clientUserAgent,
    });
    if (!profile?.hash) {
      return res.status(500).render("error", {
        message:
          "Profil IP actuellement indisponible. Veuillez réessayer plus tard.",
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

r.get(
  "/ban-appeal",
  asyncHandler(async (req, res) => {
    const requestedScope = req.query.scope || null;
    const requestedValue = req.query.value || null;
    const { ban, sessionLock, pendingFromDb, rejectedFromDb } =
      await resolveAppealContext(req, { requestedScope, requestedValue });

    if (!ban) {
      pushNotification(req, {
        type: "error",
        message: "Aucun bannissement actif n'a été trouvé pour cette adresse.",
      });
      return res.redirect(req.get("referer") || "/");
    }

    if (sessionLock === "rejected" || rejectedFromDb) {
      req.session.banAppealLock = "rejected";
      const errorMessage =
        "Votre précédente demande a été refusée. Vous ne pouvez plus soumettre de nouvelle demande.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: "",
      });
    }

    if (sessionLock === "pending" || pendingFromDb) {
      req.session.banAppealLock = "pending";
      const errorMessage =
        "Une demande est déjà en cours de traitement. Veuillez patienter.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: "",
      });
    }

    return res.status(403).render("banned", {
      ban,
      appealMessage: "",
    });
  }),
);

r.post(
  "/ban-appeal",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp || getClientIp(req);
    const message = (req.body.message || "").trim();
    const requestedScope = req.body.scope || null;
    const requestedValue = req.body.value || null;

    const { ban, sessionLock, pendingFromDb, rejectedFromDb } =
      await resolveAppealContext(req, { requestedScope, requestedValue });

    if (!ban) {
      const errorMessage =
        "Aucun bannissement actif correspondant n'a été trouvé pour cette action.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban: null,
        appealError: errorMessage,
        appealMessage: message,
      });
    }

    if (sessionLock === "rejected" || rejectedFromDb) {
      req.session.banAppealLock = "rejected";
      const errorMessage =
        "Votre précédente demande a été refusée. Vous ne pouvez plus soumettre de nouvelle demande.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: "",
      });
    }

    if (sessionLock === "pending" || pendingFromDb) {
      req.session.banAppealLock = "pending";
      const errorMessage =
        "Une demande est déjà en cours de traitement. Veuillez patienter.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: message,
      });
    }

    if (!message) {
      const errorMessage =
        "Veuillez expliquer pourquoi votre adresse devrait être débannie.";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: message,
      });
    }
    if (message.length > 2000) {
      const errorMessage =
        "Votre message est trop long (2000 caractères maximum).";
      appendNotification(res, {
        type: "error",
        message: errorMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", {
        ban,
        appealError: errorMessage,
        appealMessage: message,
      });
    }

    const appealId = await createBanAppeal({
      ip,
      scope: ban?.scope || requestedScope,
      value: ban?.value || requestedValue,
      reason: ban?.reason || null,
      message,
    });

    req.session.banAppealLock = "pending";

    appendNotification(res, {
      type: "success",
      message:
        "Votre demande de débannissement a bien été envoyée. Un administrateur la traitera prochainement.",
      timeout: 6000,
    });

    await sendAdminEvent(
      "Demande de débannissement",
      {
        user: req.session.user?.username || null,
        extra: {
          ip: ip || null,
          scope: ban?.scope || requestedScope || null,
          value: ban?.value || requestedValue || null,
          reason: ban?.reason || null,
          message,
          appeal: appealId,
        },
      },
      { includeScreenshot: false },
    );

    return res.status(403).render("banned", {
      ban,
      appealSuccess: true,
    });
  }),
);
export default r;
