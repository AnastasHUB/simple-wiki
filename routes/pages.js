import { Router } from "express";
import path from "path";
import { promises as fs } from "fs";
import multer from "multer";
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
import { slugify } from "../utils/linkify.js";
import { renderMarkdown } from "../utils/markdownRenderer.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
import { listUploads } from "../utils/uploads.js";
import { getClientIp, getClientUserAgent } from "../utils/ip.js";
import { getActiveBans } from "../utils/ipBans.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { pushNotification } from "../utils/notifications.js";
import { upsertTags, recordRevision } from "../utils/pageEditing.js";
import { evaluateUserAchievements } from "../utils/achievementService.js";
import { createPageSubmission } from "../utils/pageSubmissionService.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import {
  getIpProfileByHash,
  hashIp,
  touchIpProfile,
  IP_PROFILE_COMMENT_PAGE_SIZES,
  claimIpProfile,
  getIpProfileClaim,
  formatIpProfileLabel,
} from "../utils/ipProfiles.js";
import { hashPassword } from "../utils/passwords.js";
import {
  ROLE_FLAG_FIELDS,
  buildSessionUser,
  deriveRoleFlags,
} from "../utils/roleFlags.js";
import {
  assignRoleToUser,
  getDefaultUserRole,
  getRolesForUser,
  listRoles,
} from "../utils/roleService.js";
import { validateRegistrationSubmission } from "../utils/registrationValidation.js";
import {
  fetchPaginatedPages,
  fetchPageWithStats,
  fetchPageTags,
  fetchPageComments,
  fetchPagesByTag,
  countPages,
  countPagesByTag,
  buildPublishedFilter,
  listPageVisibilityRoles,
  setPageVisibilityRoles,
  listTagVisibilityRoles,
  setTagVisibilityRoles,
} from "../utils/pageService.js";
import {
  collectAccessibleRoleSnowflakes,
  normalizeRoleSelectionInput,
  normalizeRoleSnowflake,
} from "../utils/roleVisibility.js";
import {
  validateCommentSubmission,
  validateCommentBody,
} from "../utils/commentValidation.js";
import {
  createCaptchaChallenge,
  describeCaptcha,
  verifyCaptchaResponse,
} from "../utils/captcha.js";
import { buildPreviewHtml } from "../utils/htmlPreview.js";
import {
  COMMENT_ATTACHMENT_UPLOAD_DIR,
  ensureCommentAttachmentDir,
  purgeCommentAttachments,
} from "../utils/commentAttachments.js";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  buildPagination,
  decoratePagination,
  buildPaginationView,
} from "../utils/pagination.js";
import { listBadgesForUserId } from "../utils/badgeService.js";
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
import { resolveAccessBan } from "../utils/accessBans.js";
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
  getHandleProfile,
} from "../utils/userHandles.js";
import {
  renderMarkdownDiff,
  hasMeaningfulDiff,
} from "../utils/diffRenderer.js";
import {
  listAvailableReactions,
  combineReactionState,
  getPageReactionState,
  getCommentReactionStates,
  getCommentReactionState,
  resolveReactionOption,
  togglePageReaction,
  toggleCommentReaction,
} from "../utils/reactionService.js";
import { broadcastLikeUpdate, broadcastReactionUpdate } from "../utils/reactionWebsocket.js";

const r = Router();
const commentRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  message:
    "Trop de commentaires ont été envoyés en peu de temps depuis votre adresse IP. Veuillez patienter avant de réessayer.",
});

export const COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
];
const COMMENT_ATTACHMENT_ALLOWED_MIME_SET = new Set(
  COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES,
);
export const COMMENT_ATTACHMENT_MAX_SIZE = 5 * 1024 * 1024;
export const COMMENT_ATTACHMENT_MAX_FILES = 5;
const COMMENT_ATTACHMENT_MAX_SIZE_MB = Math.round(
  COMMENT_ATTACHMENT_MAX_SIZE / (1024 * 1024),
);
function sanitizeOriginalName(name) {
  if (typeof name !== "string") {
    return "Pièce jointe";
  }
  return name.replace(/\0/g, "").slice(0, 255) || "Pièce jointe";
}

function buildStoredFilename(originalName = "") {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = /^[.a-z0-9_-]{0,16}$/i.test(ext) ? ext : "";
  return `${Date.now()}-${generateSnowflake()}${safeExt}`;
}

async function removeUploadedFiles(files) {
  if (!Array.isArray(files) || !files.length) {
    return;
  }
  await Promise.all(
    files.map(async (file) => {
      const filePath = file?.path;
      if (!filePath) {
        return;
      }
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn("Impossible de supprimer un fichier de commentaire", {
            filePath,
            error,
          });
        }
      }
    }),
  );
}

const commentAttachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureCommentAttachmentDir()
      .then(() => cb(null, COMMENT_ATTACHMENT_UPLOAD_DIR))
      .catch((error) => cb(error));
  },
  filename: (req, file, cb) => {
    const storedName = buildStoredFilename(file?.originalname || "");
    cb(null, storedName);
  },
});

const commentAttachmentUpload = multer({
  storage: commentAttachmentStorage,
  limits: {
    fileSize: COMMENT_ATTACHMENT_MAX_SIZE,
  },
  fileFilter: (req, file, cb) => {
    const mime = typeof file?.mimetype === "string" ? file.mimetype : "";
    if (COMMENT_ATTACHMENT_ALLOWED_MIME_SET.has(mime)) {
      cb(null, true);
      return;
    }
    const error = new Error("UNSUPPORTED_COMMENT_ATTACHMENT_TYPE");
    error.code = "UNSUPPORTED_COMMENT_ATTACHMENT_TYPE";
    cb(error);
  },
});

const handleCommentAttachmentUpload = commentAttachmentUpload.array(
  "attachments",
  COMMENT_ATTACHMENT_MAX_FILES,
);

function commentUploadMiddleware(req, res, next) {
  handleCommentAttachmentUpload(req, res, (err) => {
    if (err) {
      req.commentUploadError = err;
      const files = Array.isArray(req.files) ? req.files : [];
      removeUploadedFiles(files).finally(() => {
        req.files = [];
        next();
      });
      return;
    }
    next();
  });
}

const USER_ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const USER_ROLE_FLAG_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");
const ROLE_FIELD_SELECT = ROLE_FLAG_FIELDS.map(
  (field) => `r.${field} AS role_${field}`,
).join(", ");

const MAX_COMMENT_DEPTH = 4;

const PAGE_STATUS_LABELS = {
  draft: "Brouillon",
  published: "Publié",
  scheduled: "Planifié",
};

async function safeSendAdminEvent(req, eventName, payload) {
  const sendAdminEventImpl =
    req?.app?.locals?.sendAdminEvent || sendAdminEvent;
  try {
    await sendAdminEventImpl(eventName, payload);
  } catch (error) {
    const logger =
      req?.app?.locals?.logger || req?.app?.locals?.log || console;
    if (typeof logger?.error === "function") {
      logger.error(`Failed to send admin event: ${eventName}`, error);
    } else {
      console.error(`Failed to send admin event: ${eventName}`, error);
    }
  }
}

const CLAIMED_PROFILE_LOGIN_NOTICE =
  "Ce profil IP a été converti en compte utilisateur. Connectez-vous pour continuer.";

function getSessionUserId(req) {
  if (!req?.session?.user) {
    return null;
  }
  const rawId = req.session.user.id;
  if (typeof rawId === "number" && Number.isInteger(rawId)) {
    return rawId;
  }
  if (typeof rawId === "string" && rawId.trim()) {
    const parsed = Number.parseInt(rawId, 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function shouldForceLoginForClaimedProfile(req, profile, isOwner) {
  if (!profile?.isClaimed || !isOwner) {
    return false;
  }
  const claimedUserId =
    typeof profile?.claim?.userId === "number"
      ? profile.claim.userId
      : profile?.claim?.userId
        ? Number.parseInt(profile.claim.userId, 10)
        : null;
  const sessionUserId = getSessionUserId(req);
  if (!Number.isInteger(sessionUserId)) {
    return true;
  }
  if (Number.isInteger(claimedUserId) && claimedUserId !== sessionUserId) {
    return true;
  }
  return false;
}

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

function buildRoleVisibilityOptions(availableRoles = [], selectedValues = []) {
  const normalizedSelection = new Set(normalizeRoleSelectionInput(selectedValues));
  return availableRoles
    .map((role) => {
      const snowflake = normalizeRoleSnowflake(role?.snowflake_id ?? role?.id ?? null);
      if (!snowflake) {
        return null;
      }
      const label = role?.name || snowflake;
      return {
        value: snowflake,
        label,
        selected: normalizedSelection.has(snowflake),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.label.localeCompare(b.label, "fr", { sensitivity: "base" }));
}

function collectRequestRoleSnowflakes(
  req,
  { bypassForAdmin = true } = {},
) {
  const isAdmin = Boolean(
    req?.permissionFlags?.is_admin || req?.session?.user?.is_admin,
  );
  if (bypassForAdmin && isAdmin) {
    return null;
  }
  return collectAccessibleRoleSnowflakes(req?.session?.user || null);
}

function filterValidRoleSelection(input, availableRoles = []) {
  const normalized = normalizeRoleSelectionInput(input);
  if (!normalized.length) {
    return [];
  }
  const allowed = new Set(
    availableRoles
      .map((role) => normalizeRoleSnowflake(role?.snowflake_id ?? role?.id ?? null))
      .filter(Boolean),
  );
  return normalized.filter((value) => allowed.has(value));
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
    availableVisibilityRoles = [],
    selectedVisibilityRoles = [],
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
  const combinedVisibilitySelection = [
    ...normalizeRoleSelectionInput(selectedVisibilityRoles),
    ...normalizeRoleSelectionInput(formState.visibleRoles),
  ];
  const roleVisibilityOptions = buildRoleVisibilityOptions(
    availableVisibilityRoles,
    combinedVisibilitySelection,
  );
  const selectedRoleLabels = roleVisibilityOptions
    .filter((option) => option.selected)
    .map((option) => option.label);

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
    roleVisibility: {
      enabled: roleVisibilityOptions.length > 0,
      options: roleVisibilityOptions,
      selectedLabels: selectedRoleLabels,
      hasSelection: selectedRoleLabels.length > 0,
    },
  };
}

function requestWantsJson(req) {
  return (
    req.get("X-Requested-With") === "XMLHttpRequest" ||
    (req.headers.accept || "").includes("application/json")
  );
}

function collectCommentIds(comments = [], output = []) {
  if (!Array.isArray(comments) || !comments.length) {
    return output;
  }
  for (const comment of comments) {
    if (comment && typeof comment.snowflake_id === "string") {
      output.push(comment.snowflake_id);
    }
    if (comment?.children && comment.children.length) {
      collectCommentIds(comment.children, output);
    }
  }
  return output;
}

function decorateCommentsWithReactions(comments, reactionOptions, reactionStates) {
  if (!Array.isArray(comments) || !comments.length) {
    return;
  }
  for (const comment of comments) {
    const state = reactionStates.get(comment.snowflake_id) || {
      totals: new Map(),
      userSelections: new Set(),
    };
    comment.reactions = combineReactionState(reactionOptions, state);
    if (Array.isArray(comment.children) && comment.children.length) {
      decorateCommentsWithReactions(comment.children, reactionOptions, reactionStates);
    }
  }
}

r.use(
  asyncHandler(async (req, res, next) => {
    req.clientIp = getClientIp(req);
    req.clientUserAgent = getClientUserAgent(req);
    const sessionUserId = getSessionUserId(req);
    const ban = await resolveAccessBan({
      ip: req.clientIp,
      userId: sessionUserId,
      action: "view",
    });
    const isAppealRoute = req.path === "/ban-appeal";
    if (ban && !isAppealRoute) {
      const scope = ban.scope || "";
      const value = ban.value || "";
      const restrictsView =
        scope === "global" || (scope === "action" && value === "view");
      if (restrictsView) {
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

    const visibility = buildPublishedFilter({ alias: "p" });
    const params = [likeTerm];
    if (visibility.params.length) {
      params.push(...visibility.params);
    }

    const rows = await all(
      `
      SELECT p.title, p.slug_id
      FROM pages p
      WHERE p.title LIKE ? ESCAPE '\\'
        AND ${visibility.clause}
      ORDER BY p.updated_at DESC, p.created_at DESC
      LIMIT 8
    `,
      params,
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

function buildBanFeedback(ban) {
  const scope = ban?.scope || "";
  const baseText = scope === "global" ? "Accès interdit" : "Action interdite";
  const reasonText = ban?.reason
    ? `${baseText} : ${ban.reason}`
    : `${baseText}.`;
  const subject = ban?.subject || "ip";
  const canAppeal = subject === "ip";
  let appealMessage = null;
  let appealUrl = null;
  if (canAppeal) {
    appealUrl = buildAppealUrl(ban);
    appealMessage = reasonText.endsWith(".")
      ? `${reasonText} Vous pouvez envoyer une demande de déban.`
      : `${reasonText}. Vous pouvez envoyer une demande de déban.`;
  }
  return { reasonText, appealMessage, appealUrl, canAppeal };
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
    const allowedRoleSnowflakes = collectRequestRoleSnowflakes(req);

    const total = await countPages({ allowedRoleSnowflakes });
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
      allowedRoleSnowflakes,
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
    const availableRoles = permissions.is_admin ? await listRoles() : [];
    const selectedVisibilityRoles = permissions.is_admin
      ? filterValidRoleSelection(req.body.visible_roles, availableRoles)
      : [];
    if (!permissions.is_admin) {
      const ban = await resolveAccessBan({
        ip: req.clientIp,
        userId: getSessionUserId(req),
        action: "contribute",
      });
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
        availableVisibilityRoles: availableRoles,
        selectedVisibilityRoles: [],
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
    const availableRoles = permissions.is_admin ? await listRoles() : [];
    const selectedVisibilityRoles = permissions.is_admin
      ? filterValidRoleSelection(req.body.visible_roles, availableRoles)
      : [];
    if (!permissions.is_admin) {
      const ban = await resolveAccessBan({
        ip: req.clientIp,
        userId: getSessionUserId(req),
        action: "contribute",
      });
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
        visibleRoles: selectedVisibilityRoles,
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
          availableVisibilityRoles: availableRoles,
          selectedVisibilityRoles,
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
    if (permissions.is_admin) {
      await setPageVisibilityRoles(result.lastID, selectedVisibilityRoles);
    }
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
    if (req.session.user?.id) {
      await evaluateUserAchievements(req.session.user.id);
    }
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
    const allowedRoleSnowflakes = collectRequestRoleSnowflakes(req);
    const page = await fetchPageWithStats(req.params.slugid, ip, {
      includeUnpublished: Boolean(permissions.is_admin),
      allowedRoleSnowflakes,
    });
    if (!page) return res.status(404).send("Page introuvable");

    const tagNames = await fetchPageTags(page.id);
    const tagBan = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "view",
      tags: tagNames,
    });
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
    const reactionOptions = await listAvailableReactions();
    const pageReactionState = await getPageReactionState(page.id, ip);
    const pageReactions = combineReactionState(reactionOptions, pageReactionState);
    const commentIds = collectCommentIds(comments, []);
    const commentReactionStates = commentIds.length
      ? await getCommentReactionStates(commentIds, ip)
      : new Map();
    decorateCommentsWithReactions(comments, reactionOptions, commentReactionStates);
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
    const html = renderMarkdown(page.content);
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

    const captchaConfig = createCaptchaChallenge(req);

    res.render("page", {
      page,
      html,
      tags: tagNames,
      comments,
      pageReactions,
      commentPagination,
      commentFeedback,
      ownCommentTokens,
      maxCommentDepth: MAX_COMMENT_DEPTH,
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
  commentUploadMiddleware,
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
    const captchaToken =
      typeof req.body.captchaToken === "string" ? req.body.captchaToken : "";
    const captchaAnswer =
      typeof req.body.captcha === "string" ? req.body.captcha : "";
    const adminDisplayName = permissions.is_admin
      ? getUserDisplayName(req.session.user)
      : null;
    const trimmedAuthorInput = (req.body.author || "").trim().slice(0, 80);
    const trimmedBodyInput = (req.body.body || "").trim();
    const rawParentId =
      typeof req.body.parentId === "string" ? req.body.parentId.trim() : "";
    const tagNames = await fetchPageTags(page.id);
    const ban = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "comment",
      tags: tagNames,
    });
    if (ban) {
      req.session.commentFeedback = {
        slug: page.slug_id,
        values: {
          author: adminDisplayName || trimmedAuthorInput,
          body: trimmedBodyInput,
          parentId: rawParentId,
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

    if (validation.errors.length === 0) {
      const captchaResult = verifyCaptchaResponse(req, {
        token: captchaToken,
        answer: captchaAnswer,
      });
      if (!captchaResult.success) {
        validation.errors.push(
          "Merci de répondre correctement à la question anti-spam.",
        );
      }
    }

    const authorToUse = adminDisplayName || validation.author;
    let parentSnowflake = null;
    if (rawParentId) {
      const parentComment = await get(
        `SELECT snowflake_id, page_id, status FROM comments WHERE snowflake_id = ?`,
        [rawParentId],
      );
      if (!parentComment || parentComment.page_id !== page.id) {
        validation.errors.push(
          "Le commentaire auquel vous répondez est introuvable ou n'est plus disponible.",
        );
      } else if (parentComment.status !== "approved") {
        validation.errors.push(
          "Vous ne pouvez répondre qu'à des commentaires publiés.",
        );
      } else {
        const parentDepth = await getCommentDepth(parentComment.snowflake_id);
        if (parentDepth + 1 >= MAX_COMMENT_DEPTH) {
          validation.errors.push(
            "La profondeur maximale des réponses est atteinte pour ce fil de discussion.",
          );
        } else {
          parentSnowflake = parentComment.snowflake_id;
        }
      }
    }

    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    const attachmentErrors = [];
    const attachmentsToPersist = [];
    if (req.commentUploadError) {
      const uploadErrorCode = req.commentUploadError.code;
      switch (uploadErrorCode) {
        case "LIMIT_FILE_SIZE":
          attachmentErrors.push(
            `Chaque fichier doit faire moins de ${COMMENT_ATTACHMENT_MAX_SIZE_MB} Mo.`,
          );
          break;
        case "UNSUPPORTED_COMMENT_ATTACHMENT_TYPE":
          attachmentErrors.push(
            "Ce type de fichier n'est pas autorisé pour les commentaires.",
          );
          break;
        case "LIMIT_UNEXPECTED_FILE":
          attachmentErrors.push(
            `Vous ne pouvez joindre que ${COMMENT_ATTACHMENT_MAX_FILES} fichiers par commentaire.`,
          );
          break;
        default:
          attachmentErrors.push(
            "Une erreur est survenue lors du téléversement de vos fichiers.",
          );
          break;
      }
    }

    if (uploadedFiles.length > COMMENT_ATTACHMENT_MAX_FILES) {
      attachmentErrors.push(
        `Vous ne pouvez joindre que ${COMMENT_ATTACHMENT_MAX_FILES} fichiers par commentaire.`,
      );
    }

    for (const file of uploadedFiles) {
      if (!file) {
        continue;
      }
      const mimeType = typeof file.mimetype === "string" ? file.mimetype : "";
      const size = Number.isFinite(file.size) ? Number(file.size) : 0;
      const storedName =
        typeof file.filename === "string" && file.filename
          ? file.filename
          : file.path
          ? path.basename(file.path)
          : null;
      const fileErrors = [];

      if (!storedName) {
        fileErrors.push(
          "Impossible d'enregistrer cette pièce jointe. Merci de réessayer.",
        );
      }

      if (!COMMENT_ATTACHMENT_ALLOWED_MIME_SET.has(mimeType)) {
        fileErrors.push(
          "Ce type de fichier n'est pas autorisé pour les commentaires.",
        );
      }

      if (size > COMMENT_ATTACHMENT_MAX_SIZE) {
        fileErrors.push(
          `Chaque fichier doit faire moins de ${COMMENT_ATTACHMENT_MAX_SIZE_MB} Mo.`,
        );
      } else if (size < 0) {
        fileErrors.push(
          "La taille du fichier est invalide. Merci de réessayer.",
        );
      }

      if (fileErrors.length) {
        attachmentErrors.push(...fileErrors);
        continue;
      }

      const relativePath = `uploads/comments/${storedName.replace(/\\/g, "/")}`;
      const safeRelativePath = relativePath.replace(/^[\\/]+/, "");
      attachmentsToPersist.push({
        relativePath: safeRelativePath,
        mimeType,
        size,
        originalName: sanitizeOriginalName(file.originalname),
      });
    }

    if (attachmentErrors.length) {
      validation.errors.push(...attachmentErrors);
      await removeUploadedFiles(uploadedFiles);
    }

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
      req.session.commentFeedback.values.parentId = parentSnowflake || rawParentId;
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
         parent_snowflake_id,
         ip,
         edit_token,
         author_is_admin,
         status
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        commentSnowflake,
        page.id,
        authorToUse || null,
        validation.body,
        parentSnowflake,
        ip || null,
        token,
        permissions.is_admin ? 1 : 0,
        commentStatus,
      ],
    );

    if (attachmentsToPersist.length) {
      for (const attachment of attachmentsToPersist) {
        await run(
          `INSERT INTO comment_attachments(
             snowflake_id,
             comment_snowflake_id,
             file_path,
             mime_type,
             file_size,
             original_name
           ) VALUES(?,?,?,?,?,?)`,
          [
            generateSnowflake(),
            commentSnowflake,
            attachment.relativePath,
            attachment.mimeType,
            attachment.size,
            attachment.originalName,
          ],
        );
      }
    }

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

    const sendAdminEventImpl =
      req?.app?.locals?.sendAdminEvent || sendAdminEvent;

    try {
      await sendAdminEventImpl("Nouveau commentaire", {
        page,
        comment: {
          id: commentSnowflake,
          author: authorToUse || "Anonyme",
          preview: validation.body.slice(0, 200),
          parentId: parentSnowflake,
        },
        user: req.session.user?.username || null,
        extra: {
          ip,
          status: commentStatus,
        },
      });
    } catch (error) {
      console.error("Failed to send admin event for new comment", error);
    }

    res.redirect(`/wiki/${page.slug_id}#comments`);
  }),
);

r.get(
  "/wiki/:slugid/comments/:commentId/edit",
  asyncHandler(async (req, res) => {
    const comment = await get(
      `SELECT c.id AS legacy_id, c.snowflake_id, c.author, c.body, c.status, c.edit_token, c.parent_snowflake_id, p.slug_id, p.title
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
      `SELECT c.id AS legacy_id, c.snowflake_id, c.page_id, c.author, c.body, c.status, c.edit_token, c.parent_snowflake_id, c.ip, p.slug_id, p.title, p.snowflake_id AS page_snowflake_id
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
    const rawParentId =
      typeof req.body.parentId === "string" ? req.body.parentId.trim() : "";
    const errors = bodyValidation.errors.slice();
    let parentSnowflake = rawParentId || null;

    if (parentSnowflake) {
      if (parentSnowflake === comment.snowflake_id) {
        errors.push("Un commentaire ne peut pas répondre à lui-même.");
      } else {
        const parentComment = await get(
          `SELECT snowflake_id, page_id, status, parent_snowflake_id
             FROM comments
            WHERE snowflake_id = ?`,
          [parentSnowflake],
        );
        if (!parentComment || parentComment.page_id !== comment.page_id) {
          errors.push(
            "Le commentaire parent sélectionné est introuvable ou n'appartient pas à cette page.",
          );
        } else if (parentComment.status !== "approved") {
          errors.push("Seuls les commentaires publiés peuvent recevoir une réponse.");
        } else {
          const parentCandidate = parentComment
            ? {
                snowflake_id: parentComment.snowflake_id,
                parent_snowflake_id: parentComment.parent_snowflake_id,
              }
            : null;
          const createsCycle = await isCommentDescendant(
            comment.snowflake_id,
            parentCandidate,
          );
          if (createsCycle) {
            errors.push(
              "Impossible de déplacer ce commentaire sous l'un de ses propres descendants.",
            );
          } else {
            const depth = await getCommentDepth(parentComment.snowflake_id);
            if (depth + 1 >= MAX_COMMENT_DEPTH) {
              errors.push(
                "La profondeur maximale des réponses est atteinte pour ce fil de discussion.",
              );
            } else {
              parentSnowflake = parentComment.snowflake_id;
            }
          }
        }
      }
    }

    if (errors.length) {
      const inlineNotifications = errors.map((message) => ({
        id: generateSnowflake(),
        type: "error",
        message,
        timeout: 6000,
      }));
      return res.render("comment_edit", {
        comment: {
          ...comment,
          author,
          body: bodyValidation.body,
          parent_snowflake_id: rawParentId || comment.parent_snowflake_id || null,
        },
        pageSlug: req.params.slugid,
        notifications: inlineNotifications,
      });
    }

    await run(
      `UPDATE comments
          SET author=?, body=?, parent_snowflake_id=?, status='pending', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`,
      [author || null, bodyValidation.body, parentSnowflake, comment.legacy_id],
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
        parentId: parentSnowflake,
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
    const deleteResult = await run("DELETE FROM comments WHERE id=?", [
      comment.legacy_id,
    ]);
    if (deleteResult?.changes) {
      await purgeCommentAttachments(comment.snowflake_id);
    }
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

r.get(
  "/members/:username",
  asyncHandler(async (req, res) => {
    const rawUsername =
      typeof req.params.username === "string" ? req.params.username.trim() : "";
    if (!rawUsername) {
      return res.status(404).send("Profil introuvable");
    }

    const user = await get(
      `SELECT u.id,
              u.username,
              u.display_name,
              u.avatar_url,
              u.banner_url,
              u.bio,
              u.profile_show_badges,
              u.profile_show_recent_pages,
              u.profile_show_ip_profiles,
              u.profile_show_bio,
              u.profile_show_stats,
              u.is_banned,
              u.ban_reason,
              u.banned_at,
              r.name AS role_name,
              r.color AS role_color
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE LOWER(u.username) = LOWER(?)`,
      [rawUsername],
    );

    if (!user) {
      return res.status(404).send("Profil introuvable");
    }

    const handleMap = await resolveHandleColors(
      [user.username, user.display_name].filter(Boolean),
    );
    const handleProfile =
      getHandleProfile(user.display_name, handleMap) ||
      getHandleProfile(user.username, handleMap);
    const roleAssignments = await getRolesForUser(user.id);
    const resolvedRoles = roleAssignments
      .map((role) => {
        if (!role?.name) {
          return null;
        }
        return {
          name: role.name,
          color: role.colorPresentation || null,
        };
      })
      .filter(Boolean);
    const primaryRole = resolvedRoles[0] || null;
    const heroRoleColor = handleProfile?.color || primaryRole?.color || null;

    const authorHandles = [user.username];
    const trimmedDisplayName =
      typeof user.display_name === "string" ? user.display_name.trim() : "";
    if (trimmedDisplayName && trimmedDisplayName.toLowerCase() !== user.username.toLowerCase()) {
      authorHandles.push(trimmedDisplayName);
    }

    const showBadges = user.profile_show_badges !== 0;
    const showRecentPages = user.profile_show_recent_pages !== 0;
    const showIpProfiles = user.profile_show_ip_profiles !== 0;
    const showBio = user.profile_show_bio !== 0;
    const showStats = user.profile_show_stats !== 0;

    const placeholders = authorHandles.map(() => "?").join(", ");
    const recentPages = showRecentPages
      ? await all(
          `SELECT title, slug_id, created_at
             FROM pages
            WHERE author IN (${placeholders})
            ORDER BY created_at DESC
            LIMIT 5`,
          authorHandles,
        )
      : [];

    const totalPagesRow = showStats
      ? await get(
          `SELECT COUNT(*) AS total FROM pages WHERE author IN (${placeholders})`,
          authorHandles,
        )
      : null;
    const badges = showBadges ? await listBadgesForUserId(user.id) : [];
    const ipProfileRows = showIpProfiles
      ? await all(
          `SELECT hash, claimed_at
             FROM ip_profiles
            WHERE claimed_user_id=?
            ORDER BY claimed_at DESC`,
          [user.id],
        )
      : [];
    const ipProfiles = ipProfileRows.map((row) => ({
      hash: row.hash,
      shortHash: formatIpProfileLabel(row.hash),
      claimedAt: row.claimed_at || null,
    }));

    res.render("member_profile", {
      profile: {
        username: user.username,
        displayName: trimmedDisplayName,
        avatarUrl: user.avatar_url || "",
        bannerUrl: user.banner_url || "",
        bio: user.bio || "",
        roleName: primaryRole?.name || user.role_name || null,
        roleColor: heroRoleColor,
        roles: resolvedRoles,
        totalPages: showStats ? Number(totalPagesRow?.total || 0) : 0,
        recentPages,
        badges,
        showBadges,
        showRecentPages,
        showIpProfiles,
        showBio,
        showStats,
        ipProfiles,
        isBanned: Boolean(user.is_banned),
        banReason: user.ban_reason || null,
        bannedAt: user.banned_at || null,
      },
    });
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
    const ban = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "like",
      tags: tagNames,
    });
    if (ban) {
      const { reasonText, appealMessage, appealUrl } = buildBanFeedback(ban);
      const notificationMessage = appealMessage || reasonText;
      if (wantsJson) {
        const payload = {
          ok: false,
          message: reasonText,
          ban,
          notifications: [
            {
              type: "error",
              message: notificationMessage,
              timeout: 6000,
            },
          ],
        };
        if (appealUrl) {
          payload.redirect = appealUrl;
        }
        return res.status(403).json(payload);
      }
      appendNotification(res, {
        type: "error",
        message: notificationMessage,
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
      await safeSendAdminEvent(req, "Like removed", {
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
      await safeSendAdminEvent(req, "Like added", {
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

    broadcastLikeUpdate({
      slug: page.slug_id,
      likes: likeCount,
    });

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

r.post(
  "/wiki/:slugid/reactions",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const wantsJson = requestWantsJson(req);
    const rawReaction = typeof req.body?.reaction === "string" ? req.body.reaction : "";

    const page = await get(
      "SELECT id, snowflake_id, slug_id, title FROM pages WHERE slug_id=?",
      [req.params.slugid],
    );
    if (!page) {
      if (wantsJson) {
        return res.status(404).json({ ok: false, message: "Page introuvable" });
      }
      return res.status(404).send("Page introuvable");
    }

    const option = await resolveReactionOption(rawReaction);
    if (!option) {
      const message = "Réaction introuvable.";
      if (wantsJson) {
        return res.status(400).json({ ok: false, message });
      }
      pushNotification(req, {
        type: "error",
        message,
        timeout: 4000,
      });
      return res.redirect(`/wiki/${page.slug_id}`);
    }

    if (!ip) {
      const message = "Impossible d'enregistrer votre réaction pour le moment.";
      if (wantsJson) {
        return res.status(400).json({ ok: false, message });
      }
      pushNotification(req, {
        type: "error",
        message,
        timeout: 4000,
      });
      return res.redirect(`/wiki/${page.slug_id}`);
    }

    const tagNames = await fetchPageTags(page.id);
    const ban = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "react",
      tags: tagNames,
    });
    if (ban) {
      const { reasonText, appealMessage, appealUrl } = buildBanFeedback(ban);
      const notificationMessage = appealMessage || reasonText;
      if (wantsJson) {
        const payload = {
          ok: false,
          message: reasonText,
          ban,
          notifications: [
            { type: "error", message: notificationMessage, timeout: 6000 },
          ],
        };
        if (appealUrl) {
          payload.redirect = appealUrl;
        }
        return res.status(403).json(payload);
      }
      appendNotification(res, {
        type: "error",
        message: notificationMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", { ban });
    }

    const result = await togglePageReaction({
      pageId: page.id,
      reactionKey: option.id,
      ip,
    });

    await touchIpProfile(ip, { userAgent: req.clientUserAgent });

    const reactions = combineReactionState(
      await listAvailableReactions(),
      await getPageReactionState(page.id, ip),
    );

    const payload = {
      ok: true,
      target: "page",
      slug: page.slug_id,
      reaction: option.id,
      added: Boolean(result?.added),
      reactions,
      notifications: [],
    };

    const notification = {
      type: result?.added ? "success" : "info",
      message: result?.added
        ? `Réaction “${option.label}” ajoutée.`
        : `Réaction “${option.label}” retirée.`,
      timeout: 3000,
    };

    payload.notifications = [notification];

    broadcastReactionUpdate({
      target: "page",
      slug: page.slug_id,
      reactions,
    });

    await safeSendAdminEvent(
      req,
      result?.added ? "Reaction added" : "Reaction removed",
      {
        user: req.session.user?.username || null,
        page,
        extra: {
          ip,
          reaction: option.id,
          target: "page",
        },
      },
    );

    if (wantsJson) {
      return res.json(payload);
    }

    pushNotification(req, notification);
    return res.redirect(`/wiki/${page.slug_id}`);
  }),
);

r.post(
  "/wiki/:slugid/comments/:commentId/reactions",
  asyncHandler(async (req, res) => {
    const ip = req.clientIp;
    const wantsJson = requestWantsJson(req);
    const rawReaction = typeof req.body?.reaction === "string" ? req.body.reaction : "";

    const comment = await get(
      `SELECT c.snowflake_id,
              c.status,
              c.page_id,
              p.slug_id,
              p.title,
              p.id AS page_internal_id
         FROM comments c
         JOIN pages p ON p.id = c.page_id
        WHERE p.slug_id = ?
          AND c.snowflake_id = ?
          AND c.status = 'approved'`,
      [req.params.slugid, req.params.commentId],
    );

    if (!comment) {
      if (wantsJson) {
        return res.status(404).json({ ok: false, message: "Commentaire introuvable" });
      }
      pushNotification(req, {
        type: "error",
        message: "Commentaire introuvable ou indisponible.",
        timeout: 4000,
      });
      return res.redirect(`/wiki/${req.params.slugid}#comments`);
    }

    const option = await resolveReactionOption(rawReaction);
    if (!option) {
      const message = "Réaction introuvable.";
      if (wantsJson) {
        return res.status(400).json({ ok: false, message });
      }
      pushNotification(req, {
        type: "error",
        message,
        timeout: 4000,
      });
      return res.redirect(`/wiki/${comment.slug_id}#comment-${comment.snowflake_id}`);
    }

    if (!ip) {
      const message = "Impossible d'enregistrer votre réaction pour le moment.";
      if (wantsJson) {
        return res.status(400).json({ ok: false, message });
      }
      pushNotification(req, {
        type: "error",
        message,
        timeout: 4000,
      });
      return res.redirect(`/wiki/${comment.slug_id}#comment-${comment.snowflake_id}`);
    }

    const tagNames = await fetchPageTags(comment.page_internal_id);
    const ban = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "react",
      tags: tagNames,
    });
    if (ban) {
      const { reasonText, appealMessage, appealUrl } = buildBanFeedback(ban);
      const notificationMessage = appealMessage || reasonText;
      if (wantsJson) {
        const payload = {
          ok: false,
          message: reasonText,
          ban,
          notifications: [
            { type: "error", message: notificationMessage, timeout: 6000 },
          ],
        };
        if (appealUrl) {
          payload.redirect = appealUrl;
        }
        return res.status(403).json(payload);
      }
      appendNotification(res, {
        type: "error",
        message: notificationMessage,
        timeout: 6000,
      });
      return res.status(403).render("banned", { ban });
    }

    const result = await toggleCommentReaction({
      commentSnowflakeId: comment.snowflake_id,
      reactionKey: option.id,
      ip,
    });

    await touchIpProfile(ip, { userAgent: req.clientUserAgent });

    const reactions = combineReactionState(
      await listAvailableReactions(),
      await getCommentReactionState(comment.snowflake_id, ip),
    );

    const payload = {
      ok: true,
      target: "comment",
      slug: comment.slug_id,
      commentId: comment.snowflake_id,
      reaction: option.id,
      added: Boolean(result?.added),
      reactions,
      notifications: [],
    };

    const notification = {
      type: result?.added ? "success" : "info",
      message: result?.added
        ? `Réaction “${option.label}” ajoutée sur le commentaire.`
        : `Réaction “${option.label}” retirée du commentaire.`,
      timeout: 3000,
    };

    payload.notifications = [notification];

    broadcastReactionUpdate({
      target: "comment",
      slug: comment.slug_id,
      commentId: comment.snowflake_id,
      reactions,
    });

    await sendAdminEvent(
      result?.added ? "Comment reaction added" : "Comment reaction removed",
      {
        user: req.session.user?.username || null,
        page: {
          id: comment.page_internal_id,
          slug_id: comment.slug_id,
          title: comment.title,
        },
        extra: {
          ip,
          reaction: option.id,
          target: "comment",
          comment: comment.snowflake_id,
        },
      },
    );

    if (wantsJson) {
      return res.json(payload);
    }

    pushNotification(req, notification);
    return res.redirect(`/wiki/${comment.slug_id}#comment-${comment.snowflake_id}`);
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
      const ban = await resolveAccessBan({
        ip: req.clientIp,
        userId: getSessionUserId(req),
        action: "contribute",
        tags: tagNames,
      });
      if (ban) {
        return res.status(403).render("banned", { ban });
      }
    }
    const uploads = permissions.is_admin ? await listUploads() : [];
    const availableRoles = permissions.is_admin ? await listRoles() : [];
    const selectedVisibilityRoles = permissions.is_admin
      ? await listPageVisibilityRoles(page.id)
      : [];
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
        availableVisibilityRoles: availableRoles,
        selectedVisibilityRoles,
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
    const availableRoles = permissions.is_admin ? await listRoles() : [];
    const selectedVisibilityRoles = permissions.is_admin
      ? filterValidRoleSelection(req.body.visible_roles, availableRoles)
      : await listPageVisibilityRoles(page.id);
    if (!permissions.is_admin) {
      const tagNames = await fetchPageTags(page.id);
      const ban = await resolveAccessBan({
        ip: req.clientIp,
        userId: getSessionUserId(req),
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
        visibleRoles: selectedVisibilityRoles,
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
          availableVisibilityRoles: availableRoles,
          selectedVisibilityRoles,
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
    if (permissions.is_admin) {
      await setPageVisibilityRoles(page.id, selectedVisibilityRoles);
    }
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
    const permissions = req.permissionFlags || {};
    const requestedTag = req.params.name;
    const tagName = requestedTag.toLowerCase();
    const allowedRoleSnowflakes = collectRequestRoleSnowflakes(req);
    const tagRow = await get(
      "SELECT id, name FROM tags WHERE LOWER(name)=LOWER(?)",
      [requestedTag],
    );
    const resolvedTagName = tagRow?.name || requestedTag;
    const tagVisibilityRoles = tagRow
      ? await listTagVisibilityRoles(tagRow.id)
      : [];
    const hasTagRestriction =
      tagVisibilityRoles.length > 0 &&
      allowedRoleSnowflakes !== null &&
      tagVisibilityRoles.every((role) => !allowedRoleSnowflakes.includes(role));
    if (tagRow && hasTagRestriction) {
      return res.status(403).render("error", {
        message: "Vous n'avez pas accès à ce tag.",
      });
    }
    const tagBan = await resolveAccessBan({
      ip,
      userId: getSessionUserId(req),
      action: "view",
      tags: [tagName],
    });
    if (tagBan) {
      return res.status(403).render("banned", { ban: tagBan });
    }
    const total = await countPagesByTag(resolvedTagName, {
      allowedRoleSnowflakes,
    });
    const paginationOptions = {
      pageParam: "page",
      perPageParam: "size",
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: PAGE_SIZE_OPTIONS,
    };
    const pagination = buildPaginationView(req, total, paginationOptions);
    const offset = (pagination.page - 1) * pagination.perPage;
    const availableRoles = permissions.is_admin ? await listRoles() : [];
    const tagVisibilityOptions = permissions.is_admin
      ? buildRoleVisibilityOptions(availableRoles, tagVisibilityRoles)
      : [];
    const tagVisibilityContext = permissions.is_admin
      ? {
          enabled: true,
          options: tagVisibilityOptions,
          selectedLabels: tagVisibilityOptions
            .filter((option) => option.selected)
            .map((option) => option.label),
          hasSelection: tagVisibilityOptions.some((option) => option.selected),
        }
      : {
          enabled: false,
          options: [],
          selectedLabels: [],
          hasSelection: false,
        };
    const pagesRaw =
      total > 0
        ? await fetchPagesByTag({
            tagName: resolvedTagName,
            ip,
            limit: pagination.perPage,
            offset,
            allowedRoleSnowflakes,
          })
        : [];
    const pages = pagesRaw.map((page) => ({
      ...page,
      excerpt: buildPreviewHtml(page.excerpt),
    }));
    res.render("tags", {
      tag: resolvedTagName,
      pages,
      pagination,
      total,
      tagVisibility: tagVisibilityContext,
      availableVisibilityRoles: permissions.is_admin ? availableRoles : [],
      tagVisibilityRoles,
    });
  }),
);

r.post(
  "/tags/:name/visibility",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const requestedTag = req.params.name;
    const tagRow = await get(
      "SELECT id, name FROM tags WHERE LOWER(name)=LOWER(?)",
      [requestedTag],
    );
    if (!tagRow) {
      pushNotification(req, {
        type: "error",
        message: "Tag introuvable.",
      });
      return res.redirect(`/tags/${encodeURIComponent(requestedTag)}`);
    }
    const availableRoles = await listRoles();
    const selectedVisibilityRoles = filterValidRoleSelection(
      req.body.visible_roles,
      availableRoles,
    );
    await setTagVisibilityRoles(tagRow.id, selectedVisibilityRoles);
    const message = selectedVisibilityRoles.length
      ? `Le tag « ${tagRow.name} » est désormais limité à ${selectedVisibilityRoles.length > 1 ? "ces rôles" : "ce rôle"}.`
      : `Le tag « ${tagRow.name} » est désormais accessible à tous les rôles.`;
    pushNotification(req, {
      type: "success",
      message,
    });
    return res.redirect(`/tags/${encodeURIComponent(tagRow.name)}`);
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

    const html = renderMarkdown(revision.content);
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
    const isOwner = viewerHash ? viewerHash === profile.hash : false;
    if (shouldForceLoginForClaimedProfile(req, profile, isOwner)) {
      pushNotification(req, {
        type: "info",
        message: CLAIMED_PROFILE_LOGIN_NOTICE,
        action: { href: "/login", label: "Se connecter" },
      });
      return res.redirect("/login");
    }
    res.render("ip_profile", {
      profile,
      isOwner,
      claimContext: null,
    });
  }),
);

r.get(
  "/profiles/ip/:hash/claim",
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
    const isOwner = viewerHash ? viewerHash === profile.hash : false;
    if (shouldForceLoginForClaimedProfile(req, profile, isOwner)) {
      pushNotification(req, {
        type: "info",
        message: CLAIMED_PROFILE_LOGIN_NOTICE,
        action: { href: "/login", label: "Se connecter" },
      });
      return res.redirect("/login");
    }
    if (!isOwner) {
      return res.status(403).render("error", {
        message:
          "Vous devez consulter ce profil depuis l'adresse IP correspondante pour le convertir en compte.",
      });
    }
    if (profile.isClaimed) {
      return res.status(409).render("ip_profile", {
        profile,
        isOwner,
        claimContext: {
          showForm: false,
          errors: [
            "Ce profil IP a déjà été converti en compte utilisateur.",
          ],
        },
      });
    }

    const sessionUserId = getSessionUserId(req);
    if (Number.isInteger(sessionUserId)) {
      const sessionUser = req.session.user || {};
      return res.render("ip_profile", {
        profile,
        isOwner,
        claimContext: {
          mode: "link",
          showLink: true,
          errors: [],
          linkUser: {
            username: sessionUser.username || null,
            displayName:
              sessionUser.displayName ||
              sessionUser.display_name ||
              sessionUser.username ||
              null,
          },
        },
      });
    }
    const captchaConfig = createCaptchaChallenge(req);
    if (!captchaConfig) {
      return res.status(503).render("ip_profile", {
        profile,
        isOwner,
        claimContext: {
          mode: "register",
          showForm: true,
          disabled: true,
          captcha: null,
          values: { username: "" },
          errors: [
            "La conversion en compte est temporairement indisponible car aucun captcha n'est configuré.",
          ],
        },
      });
    }
    return res.render("ip_profile", {
      profile,
      isOwner,
      claimContext: {
        mode: "register",
        showForm: true,
        captcha: captchaConfig,
        values: { username: "" },
        errors: [],
      },
    });
  }),
);

r.post(
  "/profiles/ip/:hash/claim",
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
    const isOwner = viewerHash ? viewerHash === profile.hash : false;
    if (!isOwner) {
      return res.status(403).render("error", {
        message:
          "Vous devez consulter ce profil depuis l'adresse IP correspondante pour le convertir en compte.",
      });
    }

    const claimState = await getIpProfileClaim(profile.hash);
    if (claimState?.claimed) {
      return res.status(409).render("ip_profile", {
        profile,
        isOwner,
        claimContext: {
          showForm: false,
          errors: [
            "Ce profil IP a déjà été converti en compte utilisateur.",
          ],
        },
      });
    }

    const sessionUserId = getSessionUserId(req);
    const sessionUser = Number.isInteger(sessionUserId)
      ? req.session.user || { id: sessionUserId }
      : null;
    const requestMode =
      typeof req.body.mode === "string"
        ? req.body.mode.trim().toLowerCase()
        : null;

    const buildLinkContext = (overrides = {}) => ({
      profile,
      isOwner,
      claimContext: {
        mode: "link",
        showLink: true,
        errors: overrides.errors || [],
        linkUser: {
          username: sessionUser?.username || null,
          displayName:
            sessionUser?.displayName ||
            sessionUser?.display_name ||
            sessionUser?.username ||
            null,
        },
        disabled: overrides.disabled || false,
      },
    });

    if (sessionUser && requestMode === "link") {
      const claimResult = await claimIpProfile(profile.hash, sessionUserId);
      if (!claimResult.updated) {
        const refreshed = await getIpProfileByHash(profile.hash);
        const linkContext = buildLinkContext({
          errors: [
            "Ce profil IP a déjà été converti en compte utilisateur.",
          ],
        });
        return res.status(409).render("ip_profile", {
          profile: refreshed || profile,
          isOwner,
          claimContext: linkContext.claimContext,
        });
      }

      pushNotification(req, {
        type: "success",
        message:
          "Ce profil IP est désormais associé à votre compte utilisateur.",
      });

      await sendAdminEvent(
        "Association de profil IP",
        {
          user: sessionUser?.username || `#${sessionUserId}`,
          extra: {
            ip: req.clientIp,
            profileHash: profile.hash,
            mode: "link",
          },
        },
        { includeScreenshot: false },
      );

      return res.redirect(`/profiles/ip/${profile.hash}`);
    }

    const captchaToken =
      typeof req.body.captchaToken === "string" ? req.body.captchaToken : "";
    const captchaAnswer =
      typeof req.body.captcha === "string" ? req.body.captcha : "";
    const validation = await validateRegistrationSubmission({
      req,
      username: req.body.username,
      password: req.body.password,
      captchaToken,
      captchaAnswer,
    });

    const buildFormContext = (overrides = {}) => ({
      profile,
      isOwner,
      claimContext: {
        mode: "register",
        showForm: true,
        captcha: validation.captcha,
        values: { username: validation.sanitizedUsername },
        errors: overrides.errors || [],
        disabled: overrides.disabled || false,
      },
    });

    if (validation.captchaMissing) {
      return res.status(503).render(
        "ip_profile",
        buildFormContext({
          disabled: true,
          errors: [
            "La conversion en compte est temporairement indisponible car aucun captcha n'est configuré.",
          ],
        }),
      );
    }

    if (validation.errors.length) {
      return res
        .status(400)
        .render("ip_profile", buildFormContext({ errors: validation.errors }));
    }

    const sanitizedUsername = validation.sanitizedUsername;
    const passwordValue = validation.passwordValue;
    const captchaConfig = validation.captcha;

    const userRole = await getDefaultUserRole();
    const roleId = userRole?.numeric_id || null;
    const roleFlagValues = ROLE_FLAG_FIELDS.map((field) =>
      userRole && userRole[field] ? 1 : 0,
    );

    const hashedPassword = await hashPassword(passwordValue);
    const insertResult = await run(
      `INSERT INTO users(snowflake_id, username, password, display_name, role_id, ${USER_ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?,?,?,${USER_ROLE_FLAG_PLACEHOLDERS})`,
      [
        generateSnowflake(),
        sanitizedUsername,
        hashedPassword,
        sanitizedUsername,
        roleId,
        ...roleFlagValues,
      ],
    );

    await assignRoleToUser(insertResult.lastID, userRole ? [userRole] : []);

    const createdUser = await get(
      `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id=?`,
      [insertResult.lastID],
    );

    const claimResult = await claimIpProfile(profile.hash, createdUser.id);
    if (!claimResult.updated) {
      await run("DELETE FROM users WHERE id=?", [createdUser.id]);
      const refreshed = await getIpProfileByHash(profile.hash);
      return res.status(409).render("ip_profile", {
        profile: refreshed || profile,
        isOwner,
        claimContext: {
          showForm: false,
          errors: [
            "Ce profil IP a déjà été converti en compte utilisateur.",
          ],
        },
      });
    }

    const flags = deriveRoleFlags(createdUser);
    const assignedRoles = await getRolesForUser(createdUser.id);
    req.session.user = buildSessionUser({ ...createdUser, roles: assignedRoles }, flags);

    const providerDescription = describeCaptcha();
    await sendAdminEvent(
      "Conversion de profil IP",
      {
        user: sanitizedUsername,
        extra: {
          ip: req.clientIp,
          profileHash: profile.hash,
          captchaProvider: providerDescription?.id || captchaConfig?.id,
          captchaLabel: providerDescription?.label || captchaConfig?.label,
        },
      },
      { includeScreenshot: false },
    );

    pushNotification(req, {
      type: "success",
      message: "Félicitations ! Votre profil IP a été converti en compte utilisateur.",
    });

    return res.redirect("/");
  }),
);

function canManageComment(req, comment) {
  if (req.session.user?.is_admin) return true;
  if (req.session.user?.is_moderator) return true;
  const permissions = req.permissionFlags || {};
  if (
    permissions.is_admin ||
    permissions.is_moderator ||
    permissions.can_moderate_comments ||
    permissions.can_delete_comments ||
    permissions.can_approve_comments ||
    permissions.can_reject_comments
  ) {
    return true;
  }
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
  if (!tokens || !Array.isArray(comments)) {
    return ownTokens;
  }

  const visit = (nodes) => {
    for (const comment of nodes) {
      if (!comment?.snowflake_id) {
        if (Array.isArray(comment?.children) && comment.children.length) {
          visit(comment.children);
        }
        continue;
      }
      if (tokens[comment.snowflake_id]) {
        ownTokens[comment.snowflake_id] = tokens[comment.snowflake_id];
      } else if (comment?.legacy_id && tokens[comment.legacy_id]) {
        const token = tokens[comment.legacy_id];
        ownTokens[comment.snowflake_id] = token;
        tokens[comment.snowflake_id] = token;
        delete tokens[comment.legacy_id];
      }
      if (Array.isArray(comment?.children) && comment.children.length) {
        visit(comment.children);
      }
    }
  };

  visit(comments);
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

async function getCommentDepth(commentSnowflakeId) {
  if (!commentSnowflakeId) {
    return 0;
  }
  const row = await get(
    `WITH RECURSIVE ancestors(snowflake_id, parent_snowflake_id, depth) AS (
       SELECT snowflake_id, parent_snowflake_id, 0
         FROM comments
        WHERE snowflake_id = ?
       UNION
       SELECT c.snowflake_id, c.parent_snowflake_id, ancestors.depth + 1
         FROM comments c
         JOIN ancestors ON c.snowflake_id = ancestors.parent_snowflake_id
        WHERE ancestors.depth < 24
     )
     SELECT MAX(depth) AS depth FROM ancestors`,
    [commentSnowflakeId],
  );
  return Number.isInteger(row?.depth) ? Number(row.depth) : 0;
}

async function isCommentDescendant(rootSnowflakeId, initialParent) {
  if (!rootSnowflakeId || !initialParent) {
    return false;
  }
  let current = initialParent;
  if (
    current &&
    typeof current === "object" &&
    current.snowflake_id &&
    !Object.prototype.hasOwnProperty.call(current, "parent_snowflake_id")
  ) {
    current = await get(
      `SELECT snowflake_id, parent_snowflake_id FROM comments WHERE snowflake_id = ?`,
      [current.snowflake_id],
    );
  }
  const visited = new Set();
  while (current) {
    if (current.snowflake_id === rootSnowflakeId) {
      return true;
    }
    const parentId =
      typeof current.parent_snowflake_id === "string"
        ? current.parent_snowflake_id.trim()
        : null;
    if (!parentId || visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    if (parentId === rootSnowflakeId) {
      return true;
    }
    current = await get(
      `SELECT snowflake_id, parent_snowflake_id FROM comments WHERE snowflake_id = ?`,
      [parentId],
    );
  }
  return false;
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
