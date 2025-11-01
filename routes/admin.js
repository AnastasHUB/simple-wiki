import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { all, get, run, randId, savePageFts } from "../db.js";
import { purgeCommentAttachments } from "../utils/commentAttachments.js";
import {
  generateSnowflake,
  decomposeSnowflake,
  SNOWFLAKE_EPOCH_MS,
  SNOWFLAKE_STRUCTURE,
} from "../utils/snowflake.js";
import { slugify } from "../utils/linkify.js";
import { renderMarkdown } from "../utils/markdownRenderer.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
import { hashPassword } from "../utils/passwords.js";
import {
  uploadDir,
  ensureUploadDir,
  recordUpload,
  listUploads,
  listProfileUploads,
  removeUpload,
  updateUploadName,
  optimizeUpload,
  normalizeDisplayName,
} from "../utils/uploads.js";
import { banIp, liftBan, getBan, deleteBan } from "../utils/ipBans.js";
import {
  banUserAction,
  deleteUserActionBan,
  getActiveUserActionBan,
  getUserActionBanWithUser,
  liftUserActionBan,
} from "../utils/userActionBans.js";
import {
  countIpProfiles,
  fetchIpProfiles,
  countIpProfilesForReview,
  listIpProfilesForReview,
  countClearedIpProfiles,
  fetchRecentlyClearedProfiles,
  countIpReputationHistoryEntries,
  fetchRecentIpReputationChecks,
  markIpProfileSafe,
  markIpProfileBanned,
  refreshIpReputationByHash,
  getRawIpProfileByHash,
  clearIpProfileOverride,
  IP_REPUTATION_REFRESH_INTERVAL_MS,
  formatIpProfileLabel,
  touchIpProfile,
  triggerIpReputationRefresh,
  deleteIpProfileByHash,
  linkIpProfileToUser,
  unlinkIpProfile,
} from "../utils/ipProfiles.js";
import { getClientIp } from "../utils/ip.js";
import {
  formatDateTimeLocalized,
  formatRelativeDurationMs,
} from "../utils/time.js";
import {
  buildPagination,
  decoratePagination,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
} from "../utils/pagination.js";
import {
  countPageSubmissions,
  fetchPageSubmissions,
  getPageSubmissionById,
  mapSubmissionTags,
  updatePageSubmissionStatus,
} from "../utils/pageSubmissionService.js";
import { fetchPageTags } from "../utils/pageService.js";
import { upsertTags, recordRevision } from "../utils/pageEditing.js";
import {
  getSiteSettingsForForm,
  updateSiteSettingsFromForm,
} from "../utils/settingsService.js";
import { pushNotification } from "../utils/notifications.js";
import {
  resolveHandleColors,
  getHandleColor,
} from "../utils/userHandles.js";
import {
  listReactionOptions,
  createReactionOption,
  updateReactionOption,
  deleteReactionOption,
  moveReactionOption,
} from "../utils/reactionOptions.js";
import {
  listBadgesWithAssignments,
  createBadge,
  updateBadge,
  deleteBadge,
  assignBadgeToUser,
  revokeBadgeFromUser,
  getBadgeBySnowflake,
} from "../utils/badgeService.js";
import {
  getAchievementDefinitions,
  createAchievementBadge,
  updateAchievementBadge,
  deleteAchievementBadge,
} from "../utils/achievementService.js";
import {
  listRoles,
  listRolesWithUsage,
  getRoleById,
  createRole,
  updateRolePermissions,
  assignRoleToUser,
  deleteRole,
  reassignUsersToRole,
  getEveryoneRole,
  updateRoleOrdering,
  listRolesForUsers,
} from "../utils/roleService.js";
import { ADMINISTRATOR_ROLE_SNOWFLAKE } from "../utils/defaultRoles.js";
import {
  ADMIN_ACTION_FLAGS,
  buildSessionUser,
  ROLE_FLAG_FIELDS,
  DEFAULT_ROLE_FLAGS,
  mergeRoleFlags,
} from "../utils/roleFlags.js";
import { PERMISSION_CATEGORIES } from "../utils/permissionDefinitions.js";
import {
  buildRoleColorPresentation,
  extractRoleColorFromBody,
  parseStoredRoleColor,
} from "../utils/roleColors.js";
import {
  countBanAppeals,
  fetchBanAppeals,
  getBanAppealBySnowflake,
  resolveBanAppeal,
  deleteBanAppeal,
} from "../utils/banAppeals.js";
import {
  ACTIVE_VISITOR_TTL_MS,
  LIVE_VISITOR_PAGINATION_OPTIONS,
  getLiveVisitorsSnapshot,
} from "../utils/liveStats.js";
import {
  listPremiumCodes,
  createPremiumCode,
  deletePremiumCode,
  PremiumCodeError,
} from "../utils/premiumService.js";

await ensureUploadDir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = generateSnowflake();
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

const r = Router();

const USER_RESTRICTION_LABELS = new Map([
  ["view", "consulter des pages"],
  ["comment", "publier des commentaires"],
  ["like", "ajouter aux favoris"],
  ["react", "réagir aux contenus"],
  ["contribute", "soumettre du contenu"],
  ["edit", "modifier des pages"],
  ["delete", "supprimer des pages"],
  ["manual_publish", "publier manuellement des pages"],
  ["cancel_schedule", "annuler des publications programmées"],
  ["revert_revision", "restaurer des versions"],
  ["permanent_delete", "supprimer définitivement du contenu"],
]);

const ALLOWED_USER_RESTRICTION_TYPES = new Set([
  "global",
  ...USER_RESTRICTION_LABELS.keys(),
  "tag",
]);

const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_FLAG_VALUE_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");

function sortRolesForAssignment(roles = []) {
  return [...roles].sort((a, b) => {
    const positionA = Number.isFinite(a?.position) ? a.position : 0;
    const positionB = Number.isFinite(b?.position) ? b.position : 0;
    if (positionA !== positionB) {
      return positionA - positionB;
    }
    const nameA = a?.name || "";
    const nameB = b?.name || "";
    return nameA.localeCompare(nameB, "fr", { sensitivity: "base" });
  });
}

r.use((req, res, next) => {
  const permissions = req.permissionFlags || {};
  const hasAdminAccess =
    permissions.is_admin ||
    permissions.is_moderator ||
    ADMIN_ACTION_FLAGS.some((flag) => permissions[flag]);
  if (!hasAdminAccess) {
    return res.redirect("/login");
  }
  res.locals.isModeratorUser = Boolean(
    permissions.is_moderator || permissions.can_moderate_comments,
  );
  return next();
});

function normalizeRequiredFlags(flags) {
  const collected = [];
  for (const flag of flags) {
    if (!flag) {
      continue;
    }
    if (Array.isArray(flag)) {
      collected.push(...flag.filter((value) => typeof value === "string"));
    } else if (typeof flag === "string") {
      collected.push(flag);
    }
  }
  return [...new Set(collected)];
}

function requirePermission(...flags) {
  const requiredFlags = normalizeRequiredFlags(flags);
  return (req, res, next) => {
    const permissions = req.permissionFlags || req.session.user || {};
    if (
      permissions.is_admin ||
      requiredFlags.some((flag) => permissions[flag])
    ) {
      return next();
    }
    const preferredType = req.accepts(["html", "json"]);
    if (preferredType === "json") {
      return res.status(403).json({
        error: "forbidden",
        message: req.t('errors.forbiddenAction'),
      });
    }
    return res.status(403).render("error", {
      message: req.t('errors.forbiddenPage'),
    });
  };
}

function extractPermissionsFromBody(body = {}) {
  const permissions = {};
  for (const field of ROLE_FLAG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      permissions[field] = body[field];
    }
  }
  return permissions;
}

function buildPermissionSnapshot(role = {}) {
  return ROLE_FLAG_FIELDS.reduce((acc, field) => {
    acc[field] = Boolean(role[field]);
    return acc;
  }, {});
}

function serializeLiveVisitors(now = Date.now()) {
  return getLiveVisitorsSnapshot(now).visitors;
}

const VIEW_TRENDS_ALLOWED_RANGES = new Set([7, 14, 30]);
const VIEW_TRENDS_DEFAULT_RANGE = 14;

function normalizeTrendRangeInput(value) {
  const parsed = Number.parseInt(value, 10);
  if (VIEW_TRENDS_ALLOWED_RANGES.has(parsed)) {
    return parsed;
  }
  return VIEW_TRENDS_DEFAULT_RANGE;
}

function getTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchViewTrendsSeries(rangeDays = VIEW_TRENDS_DEFAULT_RANGE) {
  const safeRange = normalizeTrendRangeInput(rangeDays);
  const offsetArg = safeRange > 1 ? `-${safeRange - 1} day` : "0 day";
  const rows = await all(
    `SELECT day, SUM(views) AS views
       FROM (
         SELECT day, SUM(views) AS views
           FROM page_view_daily
          WHERE day >= date('now', ?)
          GROUP BY day
         UNION ALL
         SELECT substr(viewed_at, 1, 10) AS day, COUNT(*) AS views
           FROM page_views
          WHERE viewed_at >= datetime('now', ?)
          GROUP BY substr(viewed_at, 1, 10)
       )
      GROUP BY day
      ORDER BY day ASC`,
    [offsetArg, offsetArg],
  );

  const endDate = getTodayUtc();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - (safeRange - 1));

  const totalsByDay = new Map();
  for (const row of rows) {
    if (!row || !row.day) {
      continue;
    }
    const value = Number(row.views) || 0;
    totalsByDay.set(row.day, (totalsByDay.get(row.day) || 0) + value);
  }

  const points = [];
  let totalViews = 0;
  for (let index = 0; index < safeRange; index += 1) {
    const current = new Date(startDate);
    current.setUTCDate(startDate.getUTCDate() + index);
    const key = formatDateKey(current);
    const dayViews = totalsByDay.has(key)
      ? Number(totalsByDay.get(key)) || 0
      : 0;
    points.push({ date: key, views: dayViews });
    totalViews += dayViews;
  }

  return {
    rangeDays: safeRange,
    startDate: formatDateKey(startDate),
    endDate: formatDateKey(endDate),
    points,
    totalViews,
    generatedAt: new Date().toISOString(),
  };
}

const PREMIUM_DURATION_FORMATTER = new Intl.NumberFormat("fr-FR", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

function formatPremiumDurationLabel(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (safeSeconds <= 0) {
    return "Instantané";
  }
  const units = [
    { value: 86400, singular: "jour", plural: "jours" },
    { value: 3600, singular: "heure", plural: "heures" },
    { value: 60, singular: "minute", plural: "minutes" },
  ];
  for (const unit of units) {
    if (safeSeconds >= unit.value) {
      const amount = safeSeconds / unit.value;
      const formattedAmount = PREMIUM_DURATION_FORMATTER.format(amount);
      const label = amount > 1 ? unit.plural : unit.singular;
      return `${formattedAmount} ${label}`;
    }
  }
  const formattedSeconds = PREMIUM_DURATION_FORMATTER.format(safeSeconds);
  return `${formattedSeconds} seconde${safeSeconds > 1 ? "s" : ""}`;
}

function parseAdminDurationInput(value, unit, { allowZero = false } = {}) {
  if (value == null) {
    return null;
  }
  const raw = typeof value === "string" ? value.replace(",", ".") : value;
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (!allowZero && numeric <= 0) {
    return null;
  }
  if (allowZero && numeric <= 0) {
    return 0;
  }
  const normalizedUnit = typeof unit === "string" ? unit.trim().toLowerCase() : "";
  const multipliers = {
    minutes: 60 * 1000,
    minute: 60 * 1000,
    heures: 60 * 60 * 1000,
    heure: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    jours: 24 * 60 * 60 * 1000,
    jour: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    semaines: 7 * 24 * 60 * 60 * 1000,
    semaine: 7 * 24 * 60 * 60 * 1000,
  };
  const multiplier = multipliers[normalizedUnit] || multipliers.days;
  const milliseconds = Math.round(numeric * multiplier);
  if (!allowZero && milliseconds <= 0) {
    return null;
  }
  return milliseconds;
}

const PREMIUM_CODE_DURATION_UNITS = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Heures" },
  { value: "days", label: "Jours" },
  { value: "weeks", label: "Semaines" },
];

function redirectToComments(req, res) {
  const fallback = "/admin/comments";
  const referer = req.get("referer");
  if (referer) {
    try {
      const host = req.get("host");
      const baseUrl = `${req.protocol}://${host ?? "localhost"}`;
      const parsed = new URL(referer, baseUrl);
      if (parsed.host === host && parsed.pathname === fallback) {
        const search = parsed.search ?? "";
        return res.redirect(`${fallback}${search}`);
      }
    } catch {
      // Ignore malformed referers and fall back to the default location.
    }
  }
  return res.redirect(fallback);
}

r.get(
  "/comments",
  requirePermission(["can_moderate_comments", "can_view_comment_queue"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const like = searchTerm ? `%${searchTerm}%` : null;

  const buildFilters = (statusClause) => {
    const clauses = [statusClause];
    const params = [];
    if (like) {
      clauses.push(
        "(c.snowflake_id LIKE ? OR COALESCE(c.author,'') LIKE ? OR COALESCE(c.ip,'') LIKE ? OR COALESCE(p.slug_id,'') LIKE ? OR COALESCE(p.title,'') LIKE ?)",
      );
      params.push(like, like, like, like, like);
    }
    return { where: clauses.join(" AND "), params };
  };

  const pendingFilters = buildFilters("c.status='pending'");
  const pendingCountRow = await get(
    `SELECT COUNT(*) AS total
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE ${pendingFilters.where}`,
    pendingFilters.params,
  );
  const pendingBase = buildPagination(
    req,
    Number(pendingCountRow?.total ?? 0),
    { pageParam: "pendingPage", perPageParam: "pendingPerPage" },
  );
  const pendingOffset = (pendingBase.page - 1) * pendingBase.perPage;
  const pending = await all(
    `SELECT c.id, c.snowflake_id, c.author, c.body, c.created_at, c.updated_at, c.status, c.ip,
            p.title AS page_title, p.slug_id AS page_slug
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE ${pendingFilters.where}
      ORDER BY c.created_at ASC
      LIMIT ? OFFSET ?`,
    [...pendingFilters.params, pendingBase.perPage, pendingOffset],
  );
  const pendingPagination = decoratePagination(req, pendingBase, {
    pageParam: "pendingPage",
    perPageParam: "pendingPerPage",
  });

  const recentFilters = buildFilters("c.status<>'pending'");
  const recentCountRow = await get(
    `SELECT COUNT(*) AS total
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE ${recentFilters.where}`,
    recentFilters.params,
  );
  const recentBase = buildPagination(req, Number(recentCountRow?.total ?? 0), {
    pageParam: "recentPage",
    perPageParam: "recentPerPage",
  });
  const recentOffset = (recentBase.page - 1) * recentBase.perPage;
  const recent = await all(
    `SELECT c.id, c.snowflake_id, c.author, c.body, c.created_at, c.updated_at, c.status, c.ip,
            p.title AS page_title, p.slug_id AS page_slug
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE ${recentFilters.where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?`,
    [...recentFilters.params, recentBase.perPage, recentOffset],
  );
  const recentPagination = decoratePagination(req, recentBase, {
    pageParam: "recentPage",
    perPageParam: "recentPerPage",
  });

  res.render("admin/comments", {
    pending,
    recent,
    pendingPagination,
    recentPagination,
    searchTerm,
  });
});

r.post(
  "/comments/:id/approve",
  requirePermission(["can_moderate_comments", "can_approve_comments"]),
  async (req, res) => {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.notFound'),
    });
    return redirectToComments(req, res);
  }
  if (comment.status === "approved") {
    pushNotification(req, {
      type: "info",
      message: req.t('admin.comments.alreadyApproved'),
    });
    return redirectToComments(req, res);
  }
  const result = await run(
    "UPDATE comments SET status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [comment.id],
  );
  if (!result?.changes) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.errors.approveFailed'),
    });
    return redirectToComments(req, res);
  }
  comment.status = "approved";
  pushNotification(req, {
    type: "success",
    message: req.t('admin.comments.approved'),
  });
  await sendAdminEvent(req.t('admin.comments.eventApproved'), {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
  },
);

r.post(
  "/comments/:id/reject",
  requirePermission(["can_moderate_comments", "can_reject_comments"]),
  async (req, res) => {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.notFound'),
    });
    return redirectToComments(req, res);
  }
  if (comment.status === "rejected") {
    pushNotification(req, {
      type: "info",
      message: req.t('admin.comments.alreadyRejected'),
    });
    return redirectToComments(req, res);
  }
  const result = await run(
    "UPDATE comments SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?",
    [comment.id],
  );
  if (!result?.changes) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.errors.rejectFailed'),
    });
    return redirectToComments(req, res);
  }
  comment.status = "rejected";
  pushNotification(req, {
    type: "info",
    message: req.t('admin.comments.rejected'),
  });
  await sendAdminEvent(req.t('admin.comments.eventRejected'), {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
  },
);

async function handleCommentDeletion(req, res) {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.notFound'),
    });
    return redirectToComments(req, res);
  }
  const result = await run("DELETE FROM comments WHERE id=?", [comment.id]);
  if (!result?.changes) {
    pushNotification(req, {
      type: "error",
      message: req.t('admin.comments.errors.deleteFailed'),
    });
    return redirectToComments(req, res);
  }
  await purgeCommentAttachments(comment.snowflake_id);
  comment.status = "deleted";
  pushNotification(req, {
    type: "success",
    message: req.t('admin.comments.deleted'),
  });
  await sendAdminEvent(req.t('admin.comments.eventDeleted'), {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
}

r.delete(
  "/comments/:id",
  requirePermission(["can_moderate_comments", "can_delete_comments"]),
  handleCommentDeletion,
);
r.post(
  "/comments/:id/delete",
  requirePermission(["can_moderate_comments", "can_delete_comments"]),
  handleCommentDeletion,
);

async function fetchModeratableComment(rawId) {
  const identifier = typeof rawId === "string" ? rawId.trim() : "";
  if (!identifier) {
    return { comment: null };
  }

  const baseSelect = `SELECT c.id,
            c.snowflake_id,
            c.status,
            c.ip,
            p.title AS page_title,
            p.slug_id AS page_slug,
            p.snowflake_id AS page_snowflake_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE %WHERE%
      LIMIT 1`;

  let comment = null;

  const legacyMatch = identifier.match(/^legacy-(\d+)$/i);
  const numericIdentifier = legacyMatch
    ? Number.parseInt(legacyMatch[1], 10)
    : /^[0-9]+$/.test(identifier)
      ? Number.parseInt(identifier, 10)
      : null;

  if (!legacyMatch) {
    comment = await get(baseSelect.replace("%WHERE%", "c.snowflake_id=?"), [
      identifier,
    ]);
  }

  if (
    !comment &&
    numericIdentifier !== null &&
    Number.isSafeInteger(numericIdentifier)
  ) {
    comment = await get(baseSelect.replace("%WHERE%", "c.id=?"), [
      numericIdentifier,
    ]);
  }

  if (comment && !comment.snowflake_id) {
    const newSnowflake = generateSnowflake();
    await run("UPDATE comments SET snowflake_id=? WHERE id=?", [
      newSnowflake,
      comment.id,
    ]);
    comment.snowflake_id = newSnowflake;
  }

  return { comment };
}

function buildCommentPageSummary(comment = {}) {
  return {
    title: comment.page_title || comment.title || null,
    slug_id: comment.page_slug || comment.slug_id || null,
    snowflake_id: comment.page_snowflake_id || null,
  };
}

function buildCommentSummary(comment = {}) {
  return {
    id: comment.snowflake_id || null,
    status: comment.status || null,
  };
}

r.get(
  "/ban-appeals",
  requirePermission(["can_review_ban_appeals", "can_view_ban_appeals"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const requestedStatus = (req.query.status || "all").toLowerCase();
  const allowedStatuses = new Set(["pending", "accepted", "rejected"]);
  const statusFilter = allowedStatuses.has(requestedStatus)
    ? requestedStatus
    : "all";
  const countStatus = statusFilter === "all" ? null : statusFilter;
  const total = await countBanAppeals({
    search: searchTerm || null,
    status: countStatus,
  });
  const basePagination = buildPagination(req, total);
  const offset = (basePagination.page - 1) * basePagination.perPage;
  const appeals = await fetchBanAppeals({
    limit: basePagination.perPage,
    offset,
    search: searchTerm || null,
    status: countStatus,
  });
  const pagination = decoratePagination(req, basePagination);

  res.render("admin/banAppeals", {
    appeals,
    pagination,
    searchTerm,
    statusFilter,
  });
  },
);

r.post(
  "/ban-appeals/:id/accept",
  requirePermission(["can_review_ban_appeals", "can_accept_ban_appeals"]),
  async (req, res) => {
  const appealId = req.params.id;
  const appeal = await getBanAppealBySnowflake(appealId);
  if (!appeal) {
    pushNotification(req, {
      type: "error",
      message: "Demande introuvable.",
    });
    return res.redirect("/admin/ban-appeals");
  }
  if (appeal.status !== "pending") {
    pushNotification(req, {
      type: "error",
      message: "Cette demande a déjà été traitée.",
    });
    return res.redirect("/admin/ban-appeals");
  }

  try {
    const updated = await resolveBanAppeal({
      snowflakeId: appealId,
      status: "accepted",
      resolvedBy: req.session.user?.username || null,
    });
    if (updated) {
      pushNotification(req, {
        type: "success",
        message: "Demande acceptée.",
      });
      await sendAdminEvent("Demande de déban acceptée", {
        user: req.session.user?.username || null,
        extra: {
          appeal: appealId,
          ip: appeal.ip || null,
          scope: appeal.scope || null,
          value: appeal.value || null,
          reason: appeal.reason || null,
          status: "accepted",
        },
      });
    } else {
      pushNotification(req, {
        type: "error",
        message: "Impossible de mettre à jour la demande.",
      });
    }
  } catch (err) {
    console.error("Unable to accept ban appeal", err);
    pushNotification(req, {
      type: "error",
      message: "Une erreur est survenue lors de l'acceptation.",
    });
  }

  res.redirect("/admin/ban-appeals");
  },
);

r.post(
  "/ban-appeals/:id/reject",
  requirePermission(["can_review_ban_appeals", "can_reject_ban_appeals"]),
  async (req, res) => {
  const appealId = req.params.id;
  const appeal = await getBanAppealBySnowflake(appealId);
  if (!appeal) {
    pushNotification(req, {
      type: "error",
      message: "Demande introuvable.",
    });
    return res.redirect("/admin/ban-appeals");
  }
  if (appeal.status !== "pending") {
    pushNotification(req, {
      type: "error",
      message: "Cette demande a déjà été traitée.",
    });
    return res.redirect("/admin/ban-appeals");
  }

  try {
    const updated = await resolveBanAppeal({
      snowflakeId: appealId,
      status: "rejected",
      resolvedBy: req.session.user?.username || null,
    });
    if (updated) {
      pushNotification(req, {
        type: "success",
        message: "Demande refusée.",
      });
      await sendAdminEvent("Demande de déban refusée", {
        user: req.session.user?.username || null,
        extra: {
          appeal: appealId,
          ip: appeal.ip || null,
          scope: appeal.scope || null,
          value: appeal.value || null,
          reason: appeal.reason || null,
          status: "rejected",
        },
      });
    } else {
      pushNotification(req, {
        type: "error",
        message: "Impossible de mettre à jour la demande.",
      });
    }
  } catch (err) {
    console.error("Unable to reject ban appeal", err);
    pushNotification(req, {
      type: "error",
      message: "Une erreur est survenue lors du refus.",
    });
  }

  res.redirect("/admin/ban-appeals");
  },
);

r.post(
  "/ban-appeals/:id/delete",
  requirePermission(["can_review_ban_appeals", "can_delete_ban_appeals"]),
  async (req, res) => {
  const appealId = req.params.id;
  const appeal = await getBanAppealBySnowflake(appealId);
  if (!appeal) {
    pushNotification(req, {
      type: "error",
      message: "Demande introuvable.",
    });
    return res.redirect("/admin/ban-appeals");
  }
  if (appeal.status === "pending") {
    pushNotification(req, {
      type: "error",
      message: "Traitez la demande avant de la supprimer.",
    });
    return res.redirect("/admin/ban-appeals");
  }

  try {
    const deleted = await deleteBanAppeal(appealId);
    if (deleted) {
      pushNotification(req, {
        type: "success",
        message: "Demande supprimée.",
      });
      await sendAdminEvent("Demande de déban supprimée", {
        user: req.session.user?.username || null,
        extra: {
          appeal: appealId,
          ip: appeal.ip || null,
          scope: appeal.scope || null,
          value: appeal.value || null,
          reason: appeal.reason || null,
          status: appeal.status,
        },
      });
    } else {
      pushNotification(req, {
        type: "error",
        message: "Impossible de supprimer la demande.",
      });
    }
  } catch (err) {
    console.error("Unable to delete ban appeal", err);
    pushNotification(req, {
      type: "error",
      message: "Une erreur est survenue lors de la suppression.",
    });
  }

  res.redirect("/admin/ban-appeals");
  },
);

r.get(
  "/ip-bans",
  requirePermission(["can_manage_ip_bans", "can_view_ip_bans"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const like = searchTerm ? `%${searchTerm}%` : null;
  const permissions = req.permissionFlags || {};
  const canManageUserBans = Boolean(
    permissions.is_admin ||
      (permissions.can_manage_users && permissions.can_suspend_users),
  );

  const buildFilters = (clause) => {
    const filters = [clause];
    const params = [];
    if (like) {
      filters.push(
        "(snowflake_id LIKE ? OR ip LIKE ? OR scope LIKE ? OR COALESCE(value,'') LIKE ? OR COALESCE(reason,'') LIKE ?)",
      );
      params.push(like, like, like, like, like);
    }
    return { where: filters.join(" AND "), params };
  };

  const activeFilters = buildFilters("lifted_at IS NULL");
  const activeCountRow = await get(
    `SELECT COUNT(*) AS total FROM ip_bans WHERE ${activeFilters.where}`,
    activeFilters.params,
  );
  const activeBase = buildPagination(req, Number(activeCountRow?.total ?? 0), {
    pageParam: "activePage",
    perPageParam: "activePerPage",
  });
  const activeOffset = (activeBase.page - 1) * activeBase.perPage;
  const activeBans = await all(
    `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      WHERE ${activeFilters.where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [...activeFilters.params, activeBase.perPage, activeOffset],
  );
  const activePagination = decoratePagination(req, activeBase, {
    pageParam: "activePage",
    perPageParam: "activePerPage",
  });

  const liftedFilters = buildFilters("lifted_at IS NOT NULL");
  const liftedCountRow = await get(
    `SELECT COUNT(*) AS total FROM ip_bans WHERE ${liftedFilters.where}`,
    liftedFilters.params,
  );
  const liftedBase = buildPagination(req, Number(liftedCountRow?.total ?? 0), {
    pageParam: "liftedPage",
    perPageParam: "liftedPerPage",
  });
  const liftedOffset = (liftedBase.page - 1) * liftedBase.perPage;
  const liftedBans = await all(
    `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      WHERE ${liftedFilters.where}
      ORDER BY lifted_at DESC
      LIMIT ? OFFSET ?`,
    [...liftedFilters.params, liftedBase.perPage, liftedOffset],
  );
  const liftedPagination = decoratePagination(req, liftedBase, {
    pageParam: "liftedPage",
    perPageParam: "liftedPerPage",
  });

  let bannedUsers = [];
  let bannedUsersPagination = decoratePagination(
    req,
    buildPagination(req, 0, {
      pageParam: "userPage",
      perPageParam: "userPerPage",
    }),
    {
      pageParam: "userPage",
      perPageParam: "userPerPage",
    },
  );

  if (canManageUserBans) {
    const userFilters = ["is_banned = 1"];
    const userParams = [];
    if (like) {
      userFilters.push(
        "(CAST(id AS TEXT) LIKE ? OR LOWER(username) LIKE LOWER(?) OR LOWER(COALESCE(display_name,'')) LIKE LOWER(?) OR COALESCE(ban_reason,'') LIKE ? OR COALESCE(banned_by,'') LIKE ?)",
      );
      userParams.push(like, like, like, like, like);
    }

    const bannedUsersCountRow = await get(
      `SELECT COUNT(*) AS total FROM users WHERE ${userFilters.join(" AND ")}`,
      userParams,
    );

    const userBase = buildPagination(req, Number(bannedUsersCountRow?.total ?? 0), {
      pageParam: "userPage",
      perPageParam: "userPerPage",
    });
    const userOffset = (userBase.page - 1) * userBase.perPage;
    bannedUsers = await all(
      `SELECT id, username, display_name, ban_reason, banned_at, banned_by
         FROM users
        WHERE ${userFilters.join(" AND ")}
        ORDER BY banned_at DESC
        LIMIT ? OFFSET ?`,
      [...userParams, userBase.perPage, userOffset],
    );
    if (bannedUsers.length) {
      const bannedHandleMap = await resolveHandleColors(
        bannedUsers.map((user) => user.username),
      );
      bannedUsers = bannedUsers.map((user) => ({
        ...user,
        userRole: getHandleColor(user.username, bannedHandleMap),
      }));
    }
    bannedUsersPagination = decoratePagination(
      req,
      userBase,
      {
        pageParam: "userPage",
        perPageParam: "userPerPage",
      },
    );
  }

  let userActionBans = [];
  let userActionPagination = decoratePagination(
    req,
    buildPagination(req, 0, {
      pageParam: "userActionPage",
      perPageParam: "userActionPerPage",
    }),
    {
      pageParam: "userActionPage",
      perPageParam: "userActionPerPage",
    },
  );

  if (canManageUserBans) {
    const userBanFilters = ["uab.lifted_at IS NULL"];
    const userBanParams = [];
    if (like) {
      userBanFilters.push(
        "(uab.snowflake_id LIKE ? OR LOWER(COALESCE(u.username,'')) LIKE LOWER(?) OR uab.scope LIKE ? OR COALESCE(uab.value,'') LIKE ? OR COALESCE(uab.reason,'') LIKE ?)",
      );
      userBanParams.push(like, like, like, like, like);
    }

    const userBanCountRow = await get(
      `SELECT COUNT(*) AS total
         FROM user_action_bans uab
         LEFT JOIN users u ON u.id = uab.user_id
        WHERE ${userBanFilters.join(" AND ")}`,
      userBanParams,
    );

    const userBanBase = buildPagination(
      req,
      Number(userBanCountRow?.total ?? 0),
      {
        pageParam: "userActionPage",
        perPageParam: "userActionPerPage",
      },
    );
    const userBanOffset = (userBanBase.page - 1) * userBanBase.perPage;
    userActionBans = await all(
      `SELECT uab.snowflake_id, uab.scope, uab.value, uab.reason, uab.created_at,
              uab.lifted_at, u.username, u.display_name, u.id AS user_id
         FROM user_action_bans uab
         LEFT JOIN users u ON u.id = uab.user_id
        WHERE ${userBanFilters.join(" AND ")}
        ORDER BY uab.created_at DESC
        LIMIT ? OFFSET ?`,
      [...userBanParams, userBanBase.perPage, userBanOffset],
    );

    userActionPagination = decoratePagination(
      req,
      userBanBase,
      {
        pageParam: "userActionPage",
        perPageParam: "userActionPerPage",
      },
    );
  }

  res.render("admin/ip_bans", {
    activeBans,
    liftedBans,
    activePagination,
    liftedPagination,
    searchTerm,
    bannedUsers,
    bannedUsersPagination,
    userActionBans,
    userActionPagination,
    canManageUserBans,
  });
});

r.post(
  "/ip-bans",
  requirePermission(["can_manage_ip_bans", "can_create_ip_bans"]),
  async (req, res) => {
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
  },
);

r.post(
  "/ip-bans/users",
  requirePermission(["can_manage_users", "can_suspend_users"]),
  async (req, res) => {
  const rawIdentifier = typeof req.body.user === "string" ? req.body.user.trim() : "";
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";

  if (!rawIdentifier) {
    pushNotification(req, {
      type: "error",
      message: "Merci d'indiquer l'utilisateur à bannir (ID ou nom).",
    });
    return res.redirect("/admin/ip-bans");
  }

  let target = null;
  if (/^\d+$/.test(rawIdentifier)) {
    target = await get(
      "SELECT id, username, is_banned FROM users WHERE id=?",
      [rawIdentifier],
    );
  }

  if (!target) {
    target = await get(
      "SELECT id, username, is_banned FROM users WHERE LOWER(username)=LOWER(?)",
      [rawIdentifier],
    );
  }

  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }

  if (target.is_banned) {
    pushNotification(req, {
      type: "info",
      message: `${target.username} est déjà banni.`,
    });
    return res.redirect("/admin/ip-bans");
  }

  await run(
    `UPDATE users
        SET is_banned=1,
            ban_reason=?,
            banned_at=CURRENT_TIMESTAMP,
            banned_by=?
      WHERE id=?`,
    [reason || null, req.session.user?.username || null, target.id],
  );

  if (req.session.user?.id === target.id) {
    req.session.user = {
      ...req.session.user,
      is_banned: true,
      ban_reason: reason || null,
      banned_at: new Date().toISOString(),
      banned_by: req.session.user?.username || null,
    };
  }

  const ip = getClientIp(req);
  await sendAdminEvent(
    "Compte utilisateur banni",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        reason: reason || null,
      },
    },
    { includeScreenshot: false },
  );

  pushNotification(req, {
    type: "success",
    message: `${target.username} a été banni.`,
  });

  res.redirect("/admin/ip-bans");
  },
);

r.post(
  "/ip-bans/users/actions",
  requirePermission(["can_manage_users", "can_suspend_users"]),
  async (req, res) => {
  const rawIdentifier = typeof req.body.user === "string" ? req.body.user.trim() : "";
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
  const rawTagValue = typeof req.body.tag === "string" ? req.body.tag.trim().toLowerCase() : "";
  const rawActions = req.body.actions;
  const actionInputs = Array.isArray(rawActions)
    ? rawActions
    : typeof rawActions === "string"
      ? [rawActions]
      : [];
  const normalizedActions = Array.from(
    new Set(
      actionInputs
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
        .filter((value) => value && ALLOWED_USER_RESTRICTION_TYPES.has(value)),
    ),
  );

  if (!rawIdentifier) {
    pushNotification(req, {
      type: "error",
      message: "Merci d'indiquer l'utilisateur ciblé (ID ou nom).",
    });
    return res.redirect("/admin/ip-bans");
  }

  if (!normalizedActions.length) {
    pushNotification(req, {
      type: "error",
      message: "Veuillez sélectionner au moins une action à restreindre.",
    });
    return res.redirect("/admin/ip-bans");
  }

  let target = null;
  if (/^\d+$/.test(rawIdentifier)) {
    target = await get(
      "SELECT id, username FROM users WHERE id=?",
      [rawIdentifier],
    );
  }

  if (!target) {
    target = await get(
      "SELECT id, username FROM users WHERE LOWER(username)=LOWER(?)",
      [rawIdentifier],
    );
  }

  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }

  const actionsToCreate = [];
  for (const actionName of normalizedActions) {
    if (actionName === "tag") {
      if (!rawTagValue) {
        pushNotification(req, {
          type: "error",
          message: "Veuillez préciser le tag à restreindre.",
        });
        return res.redirect("/admin/ip-bans");
      }
      actionsToCreate.push({ scope: "tag", value: rawTagValue });
    } else if (actionName === "global") {
      actionsToCreate.push({ scope: "global", value: null });
    } else {
      actionsToCreate.push({ scope: "action", value: actionName });
    }
  }

  if (!actionsToCreate.length) {
    pushNotification(req, {
      type: "error",
      message: "Aucune restriction n'a pu être déterminée.",
    });
    return res.redirect("/admin/ip-bans");
  }

  const created = [];
  const skipped = [];
  for (const entry of actionsToCreate) {
    try {
      const existing = await getActiveUserActionBan({
        userId: target.id,
        scope: entry.scope,
        value: entry.value,
      });
      if (existing) {
        skipped.push(entry);
        continue;
      }
      const banId = await banUserAction({
        userId: target.id,
        scope: entry.scope,
        value: entry.value,
        reason: reason || null,
      });
      created.push({ ...entry, id: banId });
    } catch (err) {
      console.error("Unable to create user action ban", err);
      pushNotification(req, {
        type: "error",
        message: "Impossible d'enregistrer certaines restrictions.",
      });
    }
  }

  if (!created.length && !skipped.length) {
    return res.redirect("/admin/ip-bans");
  }

  if (created.length) {
    const actionList = created
      .map((entry) => {
        if (entry.scope === "global") {
          return "accéder au wiki entier";
        }
        if (entry.scope === "tag") {
          return `accéder au tag « ${entry.value} »`;
        }
        const label = USER_RESTRICTION_LABELS.get(entry.value);
        return label ? label : `effectuer l'action « ${entry.value} »`;
      })
      .join(", ");
    const baseMessage =
      created.length === 1
        ? `${target.username} ne peut plus ${actionList}.`
        : `Les restrictions suivantes ont été appliquées à ${target.username} : ${actionList}.`;
    pushNotification(req, {
      type: "success",
      message: baseMessage,
    });

    const ip = getClientIp(req);
    await sendAdminEvent("Restriction d'action utilisateur", {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        reason: reason || null,
        actions: created.map((entry) => ({
          scope: entry.scope,
          value: entry.value,
          id: entry.id,
        })),
      },
    });
  } else {
    pushNotification(req, {
      type: "info",
      message: "Aucune nouvelle restriction n'a été appliquée (elles existaient déjà).",
    });
  }

  if (skipped.length) {
    pushNotification(req, {
      type: "info",
      message: `${skipped.length} restriction(s) existante(s) ont été ignorées.`,
    });
  }

  res.redirect("/admin/ip-bans");
  },
);

r.post(
  "/ip-bans/:id/lift",
  requirePermission(["can_manage_ip_bans", "can_lift_ip_bans"]),
  async (req, res) => {
  const ban = await getBan(req.params.id);
  if (!ban) {
    pushNotification(req, {
      type: "error",
      message: "Blocage introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }
  await liftBan(req.params.id);
  pushNotification(req, {
    type: "success",
    message: "Blocage levé.",
  });
  await sendAdminEvent("IP débannie", {
    extra: {
      id: req.params.id,
      ip: ban.ip,
      scope: ban.scope,
      value: ban.value,
    },
    user: req.session.user?.username || null,
  });
  res.redirect("/admin/ip-bans");
  },
);

r.post(
  "/ip-bans/:id/delete",
  requirePermission(["can_manage_ip_bans", "can_delete_ip_bans"]),
  async (req, res) => {
  const ban = await getBan(req.params.id);
  if (!ban) {
    pushNotification(req, {
      type: "error",
      message: "Blocage introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }
  await deleteBan(req.params.id);
  pushNotification(req, {
    type: "success",
    message: "Blocage supprimé.",
  });
  await sendAdminEvent("Blocage IP supprimé", {
    extra: {
      id: req.params.id,
      ip: ban.ip,
      scope: ban.scope,
      value: ban.value,
      lifted: Boolean(ban.lifted_at),
    },
    user: req.session.user?.username || null,
  });
  res.redirect("/admin/ip-bans");
  },
);

r.post(
  "/ip-bans/users/actions/:id/lift",
  requirePermission(["can_manage_users", "can_suspend_users"]),
  async (req, res) => {
  const ban = await getUserActionBanWithUser(req.params.id);
  if (!ban) {
    pushNotification(req, {
      type: "error",
      message: "Restriction introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }

  if (ban.lifted_at) {
    pushNotification(req, {
      type: "info",
      message: "Cette restriction a déjà été levée.",
    });
    return res.redirect("/admin/ip-bans");
  }

  await liftUserActionBan(ban.snowflake_id);

  const targetLabel = ban.username || `Utilisateur #${ban.user_id ?? "?"}`;
  const banLabel =
    ban.scope === "tag"
      ? `tag « ${ban.value} »`
      : ban.value
        ? `action « ${ban.value} »`
        : "cette action";

  pushNotification(req, {
    type: "success",
    message: `La restriction (${banLabel}) pour ${targetLabel} a été levée.`,
  });

  const ip = getClientIp(req);
  await sendAdminEvent("Restriction d'action levée", {
    user: req.session.user?.username || null,
    extra: {
      ip,
      banId: ban.snowflake_id,
      scope: ban.scope,
      value: ban.value,
      targetId: ban.user_id || null,
      targetUsername: ban.username || null,
    },
  });

  res.redirect("/admin/ip-bans");
  },
);

r.post(
  "/ip-bans/users/actions/:id/delete",
  requirePermission(["can_manage_users", "can_suspend_users"]),
  async (req, res) => {
  const ban = await getUserActionBanWithUser(req.params.id);
  if (!ban) {
    pushNotification(req, {
      type: "error",
      message: "Restriction introuvable.",
    });
    return res.redirect("/admin/ip-bans");
  }

  await deleteUserActionBan(ban.snowflake_id);

  const targetLabel = ban.username || `Utilisateur #${ban.user_id ?? "?"}`;
  const banLabel =
    ban.scope === "tag"
      ? `tag « ${ban.value} »`
      : ban.value
        ? `action « ${ban.value} »`
        : "cette action";

  pushNotification(req, {
    type: "success",
    message: `La restriction (${banLabel}) pour ${targetLabel} a été supprimée.`,
  });

  const ip = getClientIp(req);
  await sendAdminEvent("Restriction d'action supprimée", {
    user: req.session.user?.username || null,
    extra: {
      ip,
      banId: ban.snowflake_id,
      scope: ban.scope,
      value: ban.value,
      targetId: ban.user_id || null,
      targetUsername: ban.username || null,
    },
  });

  res.redirect("/admin/ip-bans");
  },
);

r.get(
  "/ip-reputation",
  requirePermission(["can_manage_ip_reputation", "can_view_ip_reputation"]),
  async (req, res) => {
  const [reviewTotal, clearedTotal, historyTotal] = await Promise.all([
    countIpProfilesForReview(),
    countClearedIpProfiles(),
    countIpReputationHistoryEntries(),
  ]);

  const reviewBase = buildPagination(req, reviewTotal, {
    pageParam: "reviewPage",
    perPageParam: "reviewPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  });
  const clearedBase = buildPagination(req, clearedTotal, {
    pageParam: "clearedPage",
    perPageParam: "clearedPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  });
  const historyBase = buildPagination(req, historyTotal, {
    pageParam: "historyPage",
    perPageParam: "historyPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  });

  const reviewOffset = (reviewBase.page - 1) * reviewBase.perPage;
  const clearedOffset = (clearedBase.page - 1) * clearedBase.perPage;
  const historyOffset = (historyBase.page - 1) * historyBase.perPage;

  const [suspicious, cleared, history] = await Promise.all([
    listIpProfilesForReview({
      limit: reviewBase.perPage,
      offset: reviewOffset,
    }),
    fetchRecentlyClearedProfiles({
      limit: clearedBase.perPage,
      offset: clearedOffset,
    }),
    fetchRecentIpReputationChecks({
      limit: historyBase.perPage,
      offset: historyOffset,
    }),
  ]);

  const reviewPagination = decoratePagination(req, reviewBase, {
    pageParam: "reviewPage",
    perPageParam: "reviewPerPage",
  });
  const clearedPagination = decoratePagination(req, clearedBase, {
    pageParam: "clearedPage",
    perPageParam: "clearedPerPage",
  });
  const historyPagination = decoratePagination(req, historyBase, {
    pageParam: "historyPage",
    perPageParam: "historyPerPage",
  });

  const refreshIntervalHours =
    Math.round((IP_REPUTATION_REFRESH_INTERVAL_MS / (60 * 60 * 1000)) * 10) /
    10;
  res.render("admin/ip_reputation", {
    suspicious,
    cleared,
    history,
    reviewPagination,
    clearedPagination,
    historyPagination,
    refreshIntervalHours,
    providerName: "ipapi.is",
  });
  },
);

r.post(
  "/ip-reputation/manual-check",
  requirePermission(["can_manage_ip_reputation", "can_view_ip_reputation"]),
  async (req, res) => {
  const rawIp = typeof req.body?.ip === "string" ? req.body.ip.trim() : "";
  if (!rawIp) {
    pushNotification(req, {
      type: "error",
      message: "Veuillez indiquer une adresse IP à analyser.",
    });
    return res.redirect("/admin/ip-reputation");
  }

  try {
    const profile = await touchIpProfile(rawIp, { skipRefresh: true });
    if (!profile?.hash) {
      pushNotification(req, {
        type: "error",
        message: "Adresse IP invalide ou non prise en charge.",
      });
      return res.redirect("/admin/ip-reputation");
    }

    pushNotification(req, {
      type: "success",
      message: `Analyse lancée pour le profil #${formatIpProfileLabel(profile.hash)}.`,
    });
    triggerIpReputationRefresh(rawIp, { force: true });
    await sendAdminEvent("Analyse IP manuelle", {
      extra: { ip: rawIp, hash: profile.hash },
      user: req.session.user?.username || null,
    });
  } catch (err) {
    console.error("Unable to start manual IP reputation check", err);
    pushNotification(req, {
      type: "error",
      message: "Impossible de lancer l'analyse pour cette adresse IP.",
    });
  }

  res.redirect("/admin/ip-reputation");
  },
);

r.post(
  "/ip-reputation/:hash/mark-safe",
  requirePermission(["can_manage_ip_reputation", "can_tag_ip_reputation"]),
  async (req, res) => {
  const hash = (req.params.hash || "").trim();
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.hash) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/ip-reputation");
  }
  if (profile.reputation_override === "safe") {
    pushNotification(req, {
      type: "success",
      message: `Profil #${formatIpProfileLabel(profile.hash)} déjà validé`,
    });
    return res.redirect("/admin/ip-reputation");
  }
  const success = await markIpProfileSafe(hash);
  pushNotification(req, {
    type: success ? "success" : "error",
    message: success
      ? `Profil #${formatIpProfileLabel(profile.hash)} marqué comme sûr`
      : "Impossible de marquer ce profil comme sûr.",
  });
  res.redirect("/admin/ip-reputation");
  },
);

r.post(
  "/ip-reputation/:hash/clear-safe",
  requirePermission(["can_manage_ip_reputation", "can_clear_ip_reputation"]),
  async (req, res) => {
  const hash = (req.params.hash || "").trim();
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.hash) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/ip-reputation");
  }
  const success = await clearIpProfileOverride(hash);
  pushNotification(req, {
    type: success ? "success" : "error",
    message: success
      ? `Profil #${formatIpProfileLabel(profile.hash)} retiré des validations récentes`
      : "Impossible de retirer cette validation.",
  });
  res.redirect("/admin/ip-reputation");
  },
);

r.post(
  "/ip-reputation/:hash/recheck",
  requirePermission(["can_manage_ip_reputation", "can_import_ip_reputation"]),
  async (req, res) => {
  const hash = (req.params.hash || "").trim();
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.ip) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/ip-reputation");
  }
  try {
    await refreshIpReputationByHash(hash, { force: true });
    pushNotification(req, {
      type: "success",
      message: `Profil #${formatIpProfileLabel(profile.hash)} revérifié`,
    });
  } catch (err) {
    console.error("Unable to refresh IP reputation", err);
    pushNotification(req, {
      type: "error",
      message: "La vérification automatique a échoué.",
    });
  }
  res.redirect("/admin/ip-reputation");
  },
);

r.post(
  "/ip-reputation/:hash/ban",
  requirePermission(["can_manage_ip_reputation", "can_tag_ip_reputation"]),
  async (req, res) => {
  const hash = (req.params.hash || "").trim();
  const profile = await getRawIpProfileByHash(hash);
  if (!profile?.ip) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/ip-reputation");
  }
  const reasonBase = profile.reputation_summary
    ? `Suspicion VPN/Proxy : ${profile.reputation_summary}`
    : "Suspicion d'utilisation VPN/Proxy";
  const reason = (req.body.reason || reasonBase || "")
    .toString()
    .trim()
    .slice(0, 500);
  try {
    await banIp({ ip: profile.ip, scope: "global", reason });
    await markIpProfileBanned(hash);
    pushNotification(req, {
      type: "success",
      message: `Adresse ${profile.ip} bannie (profil #${formatIpProfileLabel(profile.hash)})`,
    });
    await sendAdminEvent("IP bannie", {
      extra: { ip: profile.ip, scope: "global", reason },
      user: req.session.user?.username || null,
    });
  } catch (err) {
    console.error("Unable to ban suspicious IP", err);
    pushNotification(req, {
      type: "error",
      message: "Impossible de bannir cette adresse IP.",
    });
  }
  res.redirect("/admin/ip-reputation");
  },
);

r.get(
  "/ip-profiles",
  requirePermission(["can_manage_ip_profiles", "can_view_ip_profiles"]),
  async (req, res) => {
  const searchTerm =
    typeof req.query.search === "string" ? req.query.search.trim() : "";
  const paginationOptions = {
    pageParam: "page",
    perPageParam: "perPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };

  const total = await countIpProfiles({
    search: searchTerm || null,
  });
  const paginationBase = buildPagination(req, total, paginationOptions);
  const offset = (paginationBase.page - 1) * paginationBase.perPage;

  const profiles = await fetchIpProfiles({
    search: searchTerm || null,
    limit: paginationBase.perPage,
    offset,
  });
  const pagination = decoratePagination(req, paginationBase, paginationOptions);

  res.render("admin/ip_profiles", {
    profiles,
    searchTerm,
    pagination,
  });
  },
);

async function handleIpProfileDeletion(req, res) {
  const deleted = await deleteIpProfileByHash(req.params.hash);
  if (!deleted) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/ip-profiles");
  }

  const label = formatIpProfileLabel(deleted.hash);
  const profileName = label ? "#" + label : deleted.ip;
  pushNotification(req, {
    type: "success",
    message: "Profil " + (profileName || "IP") + " supprimé.",
  });

  await sendAdminEvent("Profil IP supprimé", {
    extra: { ip: deleted.ip, hash: deleted.hash, profile: label },
    user: req.session.user?.username || null,
  });

  res.redirect("/admin/ip-profiles");
}

r.delete("/ip-profiles/:hash", handleIpProfileDeletion);
r.post(
  "/ip-profiles/:hash/delete",
  requirePermission(["can_manage_ip_profiles", "can_delete_ip_profiles"]),
  handleIpProfileDeletion,
);

r.get(
  "/submissions",
  requirePermission(["can_review_submissions", "can_view_submission_queue"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const search = searchTerm || null;

  const pendingTotal = await countPageSubmissions({
    status: "pending",
    search,
  });
  const pendingBase = buildPagination(req, pendingTotal, {
    pageParam: "pendingPage",
    perPageParam: "pendingPerPage",
  });
  const pendingOffset = (pendingBase.page - 1) * pendingBase.perPage;
  const pendingRows = await fetchPageSubmissions({
    status: "pending",
    limit: pendingBase.perPage,
    offset: pendingOffset,
    orderBy: "created_at",
    direction: "ASC",
    search,
  });
  const pending = pendingRows.map((item) => ({
    ...item,
    tag_list: mapSubmissionTags(item),
  }));
  const pendingPagination = decoratePagination(req, pendingBase, {
    pageParam: "pendingPage",
    perPageParam: "pendingPerPage",
  });

  const recentTotal = await countPageSubmissions({
    status: ["approved", "rejected"],
    search,
  });
  const recentBase = buildPagination(req, recentTotal, {
    pageParam: "recentPage",
    perPageParam: "recentPerPage",
  });
  const recentOffset = (recentBase.page - 1) * recentBase.perPage;
  const recentRows = await fetchPageSubmissions({
    status: ["approved", "rejected"],
    limit: recentBase.perPage,
    offset: recentOffset,
    orderBy: "reviewed_at",
    direction: "DESC",
    search,
  });
  const recent = recentRows.map((item) => ({
    ...item,
    tag_list: mapSubmissionTags(item),
  }));
  const recentPagination = decoratePagination(req, recentBase, {
    pageParam: "recentPage",
    perPageParam: "recentPerPage",
  });

  res.render("admin/submissions", {
    pending,
    recent,
    pendingPagination,
    recentPagination,
    searchTerm,
  });
  },
);

r.get(
  "/submissions/:id",
  requirePermission(["can_review_submissions", "can_view_submission_queue"]),
  async (req, res) => {
  const submission = await getPageSubmissionById(req.params.id);
  if (!submission) {
    pushNotification(req, {
      type: "error",
      message: "Contribution introuvable.",
    });
    return res.redirect("/admin/submissions");
  }

  let targetPage = null;
  if (submission.page_id) {
    targetPage = await get("SELECT id, title, content FROM pages WHERE id=?", [
      submission.page_id,
    ]);
  }
  if (!targetPage && submission.current_slug) {
    targetPage = await get(
      "SELECT id, title, content FROM pages WHERE slug_id=?",
      [submission.current_slug],
    );
  }

  const proposedTags = mapSubmissionTags(submission);
  const currentTags = targetPage ? await fetchPageTags(targetPage.id) : [];
  const proposedHtml = renderMarkdown(submission.content || "");
  const currentHtml = targetPage
    ? renderMarkdown(targetPage.content || "")
    : null;

  res.render("admin/submission_detail", {
    submission,
    proposedTags,
    currentTags,
    proposedHtml,
    currentHtml,
  });
  },
);

r.post(
  "/submissions/:id/approve",
  requirePermission(["can_review_submissions", "can_accept_submissions"]),
  async (req, res) => {
  const submission = await getPageSubmissionById(req.params.id);
  if (!submission) {
    pushNotification(req, {
      type: "error",
      message: "Contribution introuvable.",
    });
    return res.redirect("/admin/submissions");
  }
  if (submission.status !== "pending") {
    pushNotification(req, {
      type: "info",
      message: "Cette contribution a déjà été traitée.",
    });
    return res.redirect("/admin/submissions");
  }

  const reviewNote = (req.body.note || "").trim();
  const reviewerId = req.session.user?.id || null;

  try {
    if (submission.type === "create") {
      const base = slugify(submission.title);
      const slugId = randId();
      const pageSnowflake = generateSnowflake();
      const insertResult = await run(
        "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at) VALUES(?,?,?,?,?,?,?,?)",
        [
          pageSnowflake,
          base,
          slugId,
          submission.title,
          submission.content,
          submission.author_name || submission.submitted_by || null,
          "published",
          null,
        ],
      );
      const pageId = insertResult?.lastID;
      if (!pageId) {
        throw new Error("Impossible de créer la page");
      }
      const tagNames = await upsertTags(pageId, submission.tags || "");
      await recordRevision(
        pageId,
        submission.title,
        submission.content,
        reviewerId,
      );
      await savePageFts({
        id: pageId,
        title: submission.title,
        content: submission.content,
        slug_id: slugId,
        tags: tagNames.join(" "),
      });
      await updatePageSubmissionStatus(submission.snowflake_id, {
        status: "approved",
        reviewerId,
        reviewNote,
        pageId,
        resultSlugId: slugId,
        targetSlugId: slugId,
      });
      pushNotification(req, {
        type: "success",
        message: "Contribution approuvée et nouvel article publié.",
      });
      const pageUrl =
        req.protocol + "://" + req.get("host") + "/wiki/" + slugId;
      await sendAdminEvent("Contribution approuvée", {
        page: {
          title: submission.title,
          slug_id: slugId,
          snowflake_id: pageSnowflake,
        },
        user: req.session.user?.username || null,
        extra: {
          submission: submission.snowflake_id,
          ip: submission.ip || null,
          type: submission.type,
          author: submission.author_name || submission.submitted_by || null,
        },
      });
      await sendFeedEvent(
        "Nouvel article",
        {
          page: {
            title: submission.title,
            slug_id: slugId,
            snowflake_id: pageSnowflake,
          },
          author:
            submission.author_name ||
            submission.submitted_by ||
            "Anonyme",
          url: pageUrl,
          tags: submission.tags,
        },
        { articleContent: submission.content },
      );
    } else {
      const page = submission.page_id
        ? await get("SELECT * FROM pages WHERE id=?", [submission.page_id])
        : submission.current_slug
          ? await get("SELECT * FROM pages WHERE slug_id=?", [
              submission.current_slug,
            ])
          : null;
      if (!page) {
        throw new Error("Page cible introuvable");
      }
      await recordRevision(page.id, page.title, page.content, reviewerId);
      const base = slugify(submission.title);
      const nextAuthor =
        submission.author_name || page.author || submission.submitted_by || null;
      await run(
        "UPDATE pages SET title=?, content=?, slug_base=?, author=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [submission.title, submission.content, base, nextAuthor, page.id],
      );
      await run("DELETE FROM page_tags WHERE page_id=?", [page.id]);
      const tagNames = await upsertTags(page.id, submission.tags || "");
      await recordRevision(
        page.id,
        submission.title,
        submission.content,
        reviewerId,
      );
      await savePageFts({
        id: page.id,
        title: submission.title,
        content: submission.content,
        slug_id: page.slug_id,
        tags: tagNames.join(" "),
      });
      await updatePageSubmissionStatus(submission.snowflake_id, {
        status: "approved",
        reviewerId,
        reviewNote,
        pageId: page.id,
        resultSlugId: page.slug_id,
        targetSlugId: page.slug_id,
      });
      pushNotification(req, {
        type: "success",
        message: "Contribution approuvée et article mis à jour.",
      });
      await sendAdminEvent("Contribution approuvée", {
        page: {
          title: submission.title,
          slug_id: page.slug_id,
          snowflake_id: page.snowflake_id,
        },
        user: req.session.user?.username || null,
        extra: {
          submission: submission.snowflake_id,
          ip: submission.ip || null,
          type: submission.type,
          author: nextAuthor,
        },
      });
    }
  } catch (err) {
    console.error(err);
    pushNotification(req, {
      type: "error",
      message: "Impossible d'approuver la contribution.",
    });
    return res.redirect(`/admin/submissions/${submission.snowflake_id}`);
  }

  res.redirect("/admin/submissions");
  },
);

r.post(
  "/submissions/:id/reject",
  requirePermission(["can_review_submissions", "can_reject_submissions"]),
  async (req, res) => {
  const submission = await getPageSubmissionById(req.params.id);
  if (!submission) {
    pushNotification(req, {
      type: "error",
      message: "Contribution introuvable.",
    });
    return res.redirect("/admin/submissions");
  }
  if (submission.status !== "pending") {
    pushNotification(req, {
      type: "info",
      message: "Cette contribution a déjà été traitée.",
    });
    return res.redirect("/admin/submissions");
  }

  const reviewNote = (req.body.note || "").trim();
  const reviewerId = req.session.user?.id || null;
  const updated = await updatePageSubmissionStatus(submission.snowflake_id, {
    status: "rejected",
    reviewerId,
    reviewNote,
  });
  if (!updated) {
    pushNotification(req, {
      type: "error",
      message: "Impossible de mettre à jour cette contribution.",
    });
    return res.redirect(`/admin/submissions/${submission.snowflake_id}`);
  }

  pushNotification(req, {
    type: "info",
    message: "Contribution rejetée.",
  });
  await sendAdminEvent("Contribution rejetée", {
    page: submission.current_slug
      ? { title: submission.current_title, slug_id: submission.current_slug }
      : { title: submission.title },
    user: req.session.user?.username || null,
    extra: {
      submission: submission.snowflake_id,
      ip: submission.ip || null,
      type: submission.type,
      note: reviewNote || null,
    },
  });

  res.redirect("/admin/submissions");
  },
);

r.get(
  "/schedule",
  requirePermission([
    "can_schedule_pages",
    "can_manage_pages",
    "can_publish_pages",
  ]),
  async (req, res) => {
    const rows = await all(`
      SELECT id,
             snowflake_id,
             slug_id,
             title,
             author,
             publish_at,
             created_at,
             updated_at
        FROM pages
       WHERE status = 'scheduled'
         AND publish_at IS NOT NULL
         AND datetime(publish_at) > datetime('now')
       ORDER BY datetime(publish_at) ASC, slug_id ASC
    `);

    const now = Date.now();
    const scheduledPages = rows.map((row) => {
      const publishAt = row.publish_at ? new Date(row.publish_at) : null;
      return {
        id: row.id,
        snowflake_id: row.snowflake_id,
        slug_id: row.slug_id,
        title: row.title,
        author: row.author,
        publish_at: row.publish_at,
        publishAtIso: publishAt ? publishAt.toISOString() : null,
        publishAtLabel: publishAt ? formatDateTimeLocalized(publishAt) : "",
        publishAtRelative: publishAt
          ? formatRelativeDurationMs(publishAt.getTime() - now)
          : "",
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    res.render("admin/schedule", { scheduledPages });
  },
);

r.post(
  "/schedule/:slugid/publish",
  requirePermission([
    "can_schedule_pages",
    "can_publish_pages",
    "can_manage_pages",
  ]),
  async (req, res) => {
    const slugId = req.params.slugid;
    const page = await get(
      `
      SELECT p.id,
             p.snowflake_id,
             p.slug_id,
             p.slug_base,
             p.title,
             p.content,
             p.author,
             p.status,
             p.publish_at,
             GROUP_CONCAT(t.name, ',') AS tagsCsv
        FROM pages p
        LEFT JOIN page_tags pt ON pt.page_id = p.id
        LEFT JOIN tags t ON t.id = pt.tag_id
       WHERE p.slug_id = ?
       GROUP BY p.id
    `,
      [slugId],
    );

    if (!page || page.status !== "scheduled") {
      pushNotification(req, {
        type: "error",
        message: "Impossible de publier cette page : elle n'est pas planifiée.",
      });
      return res.redirect("/admin/schedule");
    }

    await run(
      "UPDATE pages SET status='published', updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [page.id],
    );

    try {
      await sendAdminEvent("Page programmée publiée manuellement", {
        page: {
          title: page.title,
          slug_id: page.slug_id,
          slug_base: page.slug_base,
          snowflake_id: page.snowflake_id,
        },
        user: req.session.user?.username || null,
        extra: {
          publish_at: page.publish_at,
          action: "manual_publish",
        },
      });
      const tags = page.tagsCsv || "";
      await sendFeedEvent(
        "Nouvel article",
        {
          page: {
            title: page.title,
            slug_id: page.slug_id,
            snowflake_id: page.snowflake_id,
            content: page.content,
          },
          author: page.author || "Anonyme",
          url: `/wiki/${page.slug_id}`,
          tags,
        },
        { articleContent: page.content },
      );
    } catch (err) {
      console.error("Failed to notify manual scheduled publication", err);
    }

    pushNotification(req, {
      type: "success",
      message: `« ${page.title || page.slug_id} » est maintenant publiée.`,
    });

    res.redirect("/admin/schedule");
  },
);

r.post(
  "/schedule/:slugid/cancel",
  requirePermission([
    "can_schedule_pages",
    "can_manage_pages",
  ]),
  async (req, res) => {
    const slugId = req.params.slugid;
    const page = await get(
      `SELECT id, snowflake_id, slug_id, slug_base, title, status FROM pages WHERE slug_id = ?`,
      [slugId],
    );

    if (!page || page.status !== "scheduled") {
      pushNotification(req, {
        type: "error",
        message: "Impossible d'annuler : cette page n'est pas programmée.",
      });
      return res.redirect("/admin/schedule");
    }

    await run(
      "UPDATE pages SET status='draft', publish_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [page.id],
    );

    try {
      await sendAdminEvent("Programmation annulée", {
        page: {
          title: page.title,
          slug_id: page.slug_id,
          slug_base: page.slug_base,
          snowflake_id: page.snowflake_id,
        },
        user: req.session.user?.username || null,
        extra: {
          action: "cancel_schedule",
        },
      });
    } catch (err) {
      console.error("Failed to notify schedule cancellation", err);
    }

    pushNotification(req, {
      type: "success",
      message: `La programmation de « ${page.title || page.slug_id} » a été annulée.`,
    });

    res.redirect("/admin/schedule");
  },
);

r.get(
  "/pages",
  requirePermission(["can_manage_pages", "can_view_page_overview"]),
  async (req, res) => {
  const countRow = await get("SELECT COUNT(*) AS c FROM pages");
  const latest = await get(`
    SELECT title, slug_id,
      COALESCE(updated_at, created_at) AS ts
    FROM pages
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 1
  `);
  res.render("admin/pages", {
    stats: {
      count: countRow?.c || 0,
      latest,
    },
  });
  },
);

r.post(
  "/pages/:slugid/revisions/:revisionId/revert",
  requirePermission(["can_revert_page_history"]),
  async (req, res) => {
  const redirectUrl = `/wiki/${req.params.slugid}/history`;
  const revisionNumber = Number.parseInt(req.params.revisionId, 10);

  if (!Number.isInteger(revisionNumber) || revisionNumber <= 0) {
    pushNotification(req, {
      type: "error",
      message: "Révision cible invalide.",
    });
    return res.redirect(redirectUrl);
  }

  const page = await get(
    `SELECT id, snowflake_id, slug_id, slug_base, title, content
       FROM pages
      WHERE slug_id=?`,
    [req.params.slugid],
  );

  if (!page) {
    pushNotification(req, {
      type: "error",
      message: "Page introuvable.",
    });
    return res.redirect("/admin/pages");
  }

  const revision = await get(
    `SELECT revision, title, content
       FROM page_revisions
      WHERE page_id=? AND revision=?`,
    [page.id, revisionNumber],
  );

  if (!revision) {
    pushNotification(req, {
      type: "error",
      message: "Révision introuvable.",
    });
    return res.redirect(redirectUrl);
  }

  const nextTitle =
    typeof revision.title === "string" && revision.title.trim().length
      ? revision.title
      : page.title;
  const nextContent =
    typeof revision.content === "string" ? revision.content : "";
  const slugBaseSeed =
    nextTitle || page.slug_base || page.slug_id || page.title || "";
  const computedSlugBase = slugify(String(slugBaseSeed));
  const nextSlugBase = computedSlugBase || page.slug_base || page.slug_id;
  const previousRevisionRow = await get(
    "SELECT MAX(revision) AS latest FROM page_revisions WHERE page_id = ?",
    [page.id],
  );
  const previousRevisionNumber = Number(previousRevisionRow?.latest || 0);
  const tags = await fetchPageTags(page.id);

  try {
    await run(
      "UPDATE pages SET title=?, content=?, slug_base=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      [nextTitle, nextContent, nextSlugBase, page.id],
    );
    await savePageFts({
      id: page.id,
      title: nextTitle,
      content: nextContent,
      slug_id: page.slug_id,
      tags: tags.join(" "),
    });
  } catch (err) {
    console.error("Failed to revert page revision", err);
    pushNotification(req, {
      type: "error",
      message: "La restauration a échoué. Merci de réessayer.",
    });
    return res.redirect(redirectUrl);
  }

  let newRevisionNumber = null;
  try {
    newRevisionNumber = await recordRevision(
      page.id,
      nextTitle,
      nextContent,
      req.session.user?.id || null,
    );
  } catch (err) {
    console.error("Failed to record restored revision", err);
    pushNotification(req, {
      type: "error",
      message: "Impossible d'enregistrer la restauration.",
    });
    return res.redirect(redirectUrl);
  }

  const ip = getClientIp(req);
  try {
    await sendAdminEvent("Page reverted", {
      user: req.session.user?.username || null,
      page: {
        title: nextTitle,
        slug_id: page.slug_id,
        snowflake_id: page.snowflake_id,
      },
      extra: {
        action: "revert_revision",
        target_revision: revision.revision,
        previous_revision: previousRevisionNumber,
        new_revision: newRevisionNumber,
        ip,
      },
    });
  } catch (err) {
    console.error("Failed to log page revert event", err);
  }

  pushNotification(req, {
    type: "success",
    message: `La page a été restaurée à la révision #${revision.revision}.`,
  });

  return res.redirect(redirectUrl);
  },
);

r.get(
  "/stats",
  requirePermission(["can_view_stats", "can_view_stats_basic"]),
  async (req, res) => {
  const periods = [
    {
      key: "day",
      label: req.t("admin.stats.periods.day"),
      durationMs: 24 * 60 * 60 * 1000,
      limit: 10,
    },
    {
      key: "week",
      label: req.t("admin.stats.periods.week"),
      durationMs: 7 * 24 * 60 * 60 * 1000,
      limit: 15,
    },
    {
      key: "month",
      label: req.t("admin.stats.periods.month"),
      durationMs: 30 * 24 * 60 * 60 * 1000,
      limit: 15,
    },
    { key: "all", label: req.t("admin.stats.periods.all"), durationMs: null, limit: 20 },
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

  const topLikedCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT 1
          FROM likes
         GROUP BY page_id
      ) sub`);
  const topLikedOptions = {
    pageParam: "likesPage",
    perPageParam: "likesPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let topLikedPagination = buildPagination(
    req,
    Number(topLikedCount?.total ?? 0),
    topLikedOptions,
  );
  const topLikedOffset =
    (topLikedPagination.page - 1) * topLikedPagination.perPage;
  const topLikedPages = await all(
    `
    SELECT p.title, p.slug_id, COUNT(*) AS likes
      FROM likes l
      JOIN pages p ON p.id = l.page_id
     GROUP BY l.page_id
     ORDER BY likes DESC, p.title ASC
     LIMIT ? OFFSET ?
  `,
    [topLikedPagination.perPage, topLikedOffset],
  );
  topLikedPagination = decoratePagination(
    req,
    topLikedPagination,
    topLikedOptions,
  );

  const topCommenterCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT COALESCE(author, 'Anonyme') AS author
          FROM comments
         GROUP BY COALESCE(author, 'Anonyme')
      ) sub`);
  const topCommentersOptions = {
    pageParam: "commentersPage",
    perPageParam: "commentersPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let topCommentersPagination = buildPagination(
    req,
    Number(topCommenterCount?.total ?? 0),
    topCommentersOptions,
  );
  const topCommentersOffset =
    (topCommentersPagination.page - 1) * topCommentersPagination.perPage;
  const topCommenters = await all(
    `
    SELECT COALESCE(author, 'Anonyme') AS author, COUNT(*) AS comments
      FROM comments
     GROUP BY COALESCE(author, 'Anonyme')
     ORDER BY comments DESC
     LIMIT ? OFFSET ?
  `,
    [topCommentersPagination.perPage, topCommentersOffset],
  );
  topCommentersPagination = decoratePagination(
    req,
    topCommentersPagination,
    topCommentersOptions,
  );

  const topCommentedCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT page_id
          FROM comments
         WHERE status='approved'
         GROUP BY page_id
      ) sub`);
  const topCommentedOptions = {
    pageParam: "commentedPage",
    perPageParam: "commentedPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let topCommentedPagination = buildPagination(
    req,
    Number(topCommentedCount?.total ?? 0),
    topCommentedOptions,
  );
  const topCommentedOffset =
    (topCommentedPagination.page - 1) * topCommentedPagination.perPage;
  const topCommentedPages = await all(
    `
    SELECT p.title, p.slug_id, COUNT(*) AS comments
      FROM comments c
      JOIN pages p ON p.id = c.page_id
     WHERE c.status='approved'
     GROUP BY c.page_id
     ORDER BY comments DESC, p.title ASC
     LIMIT ? OFFSET ?
  `,
    [topCommentedPagination.perPage, topCommentedOffset],
  );
  topCommentedPagination = decoratePagination(
    req,
    topCommentedPagination,
    topCommentedOptions,
  );

  const tagUsageCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT pt.tag_id
          FROM page_tags pt
         GROUP BY pt.tag_id
      ) sub`);
  const tagUsageOptions = {
    pageParam: "tagsPage",
    perPageParam: "tagsPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let tagUsagePagination = buildPagination(
    req,
    Number(tagUsageCount?.total ?? 0),
    tagUsageOptions,
  );
  const tagUsageOffset =
    (tagUsagePagination.page - 1) * tagUsagePagination.perPage;
  const tagUsage = await all(
    `
    SELECT t.name, COUNT(*) AS pages
      FROM page_tags pt
      JOIN tags t ON t.id = pt.tag_id
     GROUP BY pt.tag_id
     ORDER BY pages DESC, t.name ASC
     LIMIT ? OFFSET ?
  `,
    [tagUsagePagination.perPage, tagUsageOffset],
  );
  tagUsagePagination = decoratePagination(
    req,
    tagUsagePagination,
    tagUsageOptions,
  );

  const commentTimelineCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT strftime('%Y-%m-%d', created_at) AS day
          FROM comments
         GROUP BY strftime('%Y-%m-%d', created_at)
      ) sub`);
  const commentTimelineOptions = {
    pageParam: "timelinePage",
    perPageParam: "timelinePerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let commentTimelinePagination = buildPagination(
    req,
    Number(commentTimelineCount?.total ?? 0),
    commentTimelineOptions,
  );
  const commentTimelineOffset =
    (commentTimelinePagination.page - 1) * commentTimelinePagination.perPage;
  const commentTimeline = await all(
    `
    SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS comments
      FROM comments
     GROUP BY day
     ORDER BY day DESC
     LIMIT ? OFFSET ?
  `,
    [commentTimelinePagination.perPage, commentTimelineOffset],
  );
  commentTimelinePagination = decoratePagination(
    req,
    commentTimelinePagination,
    commentTimelineOptions,
  );

  const activeIpsCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT ip
          FROM page_views
         WHERE ip IS NOT NULL AND ip <> ''
         GROUP BY ip
      ) sub`);
  const activeIpsOptions = {
    pageParam: "ipsPage",
    perPageParam: "ipsPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let activeIpsPagination = buildPagination(
    req,
    Number(activeIpsCount?.total ?? 0),
    activeIpsOptions,
  );
  const activeIpsOffset =
    (activeIpsPagination.page - 1) * activeIpsPagination.perPage;
  const activeIps = await all(
    `
    SELECT ip, COUNT(*) AS views
      FROM page_views
     WHERE ip IS NOT NULL AND ip <> ''
     GROUP BY ip
     ORDER BY views DESC
     LIMIT ? OFFSET ?
  `,
    [activeIpsPagination.perPage, activeIpsOffset],
  );
  activeIpsPagination = decoratePagination(
    req,
    activeIpsPagination,
    activeIpsOptions,
  );
  const uniqueIps = await get(
    "SELECT COUNT(DISTINCT ip) AS total FROM page_views WHERE ip IS NOT NULL AND ip <> ''",
  );
  const ipViewsCount = await get(`
    SELECT COUNT(*) AS total
      FROM (
        SELECT pv.ip, pv.page_id
          FROM page_views pv
         WHERE pv.ip IS NOT NULL AND pv.ip <> ''
         GROUP BY pv.ip, pv.page_id
      ) sub`);
  const ipViewsOptions = {
    pageParam: "ipViewsPage",
    perPageParam: "ipViewsPerPage",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
  let ipViewsPagination = buildPagination(
    req,
    Number(ipViewsCount?.total ?? 0),
    ipViewsOptions,
  );
  const ipViewsOffset =
    (ipViewsPagination.page - 1) * ipViewsPagination.perPage;
  const ipViewsByPage = await all(
    `
    SELECT pv.ip, p.title, p.slug_id, COUNT(*) AS views
      FROM page_views pv
      JOIN pages p ON p.id = pv.page_id
     WHERE pv.ip IS NOT NULL AND pv.ip <> ''
     GROUP BY pv.ip, pv.page_id
     ORDER BY views DESC
     LIMIT ? OFFSET ?
  `,
    [ipViewsPagination.perPage, ipViewsOffset],
  );
  ipViewsPagination = decoratePagination(
    req,
    ipViewsPagination,
    ipViewsOptions,
  );
  const banCount = await get(
    "SELECT COUNT(*) AS count FROM ip_bans WHERE lifted_at IS NULL",
  );
  const [
    totalPagesRow,
    newPagesRow,
    deletedPagesRow,
    pendingSubmissionsRow,
    totalUploadsRow,
    newUploadsRow,
    newCommentsRow,
    newLikesRow,
    newViewsRow,
    recentPages,
    recentEvents,
    viewTrendsSeries,
  ] = await Promise.all([
    get(
      "SELECT COUNT(*) AS total, SUM(LENGTH(CAST(content AS BLOB))) AS content_bytes FROM pages",
    ),
    get(
      "SELECT COUNT(*) AS total FROM pages WHERE created_at >= datetime('now','-7 day')",
    ),
    get("SELECT COUNT(*) AS total FROM deleted_pages"),
    get(
      "SELECT COUNT(*) AS total FROM page_submissions WHERE status='pending'",
    ),
    get(
      "SELECT COUNT(*) AS total, SUM(size) AS total_bytes FROM uploads",
    ),
    get(
      "SELECT COUNT(*) AS total FROM uploads WHERE created_at >= datetime('now','-7 day')",
    ),
    get(
      "SELECT COUNT(*) AS total FROM comments WHERE created_at >= datetime('now','-7 day')",
    ),
    get(
      "SELECT COUNT(*) AS total FROM likes WHERE created_at >= datetime('now','-7 day')",
    ),
    get(
      "SELECT COUNT(*) AS total FROM page_views WHERE viewed_at >= datetime('now','-7 day')",
    ),
    all(
      `SELECT title, slug_id, created_at
         FROM pages
        ORDER BY created_at DESC
        LIMIT 6`,
    ),
    all(
      `SELECT snowflake_id, type, channel, created_at, username
         FROM event_logs
        ORDER BY created_at DESC
        LIMIT 8`,
    ),
    fetchViewTrendsSeries(VIEW_TRENDS_DEFAULT_RANGE),
  ]);

  const totalPages = Number(totalPagesRow?.total || 0);
  const avgViewsPerPage = totalPages
    ? Math.round((totals?.totalViews || 0) / totalPages)
    : 0;
  const newPagesCount = Number(newPagesRow?.total || 0);
  const deletedPagesCount = Number(deletedPagesRow?.total || 0);
  const pendingSubmissionsCount = Number(pendingSubmissionsRow?.total || 0);
  const totalUploadsCount = Number(totalUploadsRow?.total || 0);
  const newUploadsCount = Number(newUploadsRow?.total || 0);
  const newCommentsCount = Number(newCommentsRow?.total || 0);
  const newLikesCount = Number(newLikesRow?.total || 0);
  const newViewsCount = Number(newViewsRow?.total || 0);

  const dbPath = path.join(process.cwd(), "data.sqlite");
  let databaseFileSize = 0;
  try {
    const dbFileStat = await fs.stat(dbPath);
    if (dbFileStat?.size) {
      databaseFileSize = Number(dbFileStat.size);
    }
  } catch (err) {
    console.warn("Impossible de déterminer la taille du fichier SQLite", err);
  }

  let pragmaPageSize = 0;
  let pragmaPageCount = 0;
  let pragmaFreelistCount = 0;
  try {
    const [pageSizeRow, pageCountRow, freelistRow] = await Promise.all([
      get("PRAGMA page_size"),
      get("PRAGMA page_count"),
      get("PRAGMA freelist_count"),
    ]);
    pragmaPageSize = Number(pageSizeRow?.page_size || 0);
    pragmaPageCount = Number(pageCountRow?.page_count || 0);
    pragmaFreelistCount = Number(freelistRow?.freelist_count || 0);
  } catch (err) {
    console.warn("Impossible de lire les PRAGMA de stockage", err);
  }

  let tableDetailsError = null;
  let tableDetailsRaw = [];
  try {
    tableDetailsRaw = await all(`
      SELECT d.name AS name,
             SUM(d.pgsize) AS size_bytes,
             SUM(CASE WHEN d.pagetype = 'leaf' THEN d.payload ELSE 0 END) AS payload_bytes,
             SUM(d.unused) AS unused_bytes,
             SUM(CASE WHEN d.pagetype = 'leaf' THEN d.ncell ELSE 0 END) AS row_estimate,
             COUNT(*) AS page_count
        FROM dbstat d
        JOIN sqlite_schema s ON s.name = d.name AND s.type = 'table'
       GROUP BY d.name
       ORDER BY size_bytes DESC
    `);
  } catch (err) {
    tableDetailsError = err;
    console.warn("Impossible de lire la table virtuelle dbstat", err);
  }

  const tableDetails = Array.isArray(tableDetailsRaw)
    ? tableDetailsRaw.map((row) => ({
        name: row.name,
        sizeBytes: Number(row.size_bytes || 0),
        payloadBytes: Number(row.payload_bytes || 0),
        unusedBytes: Number(row.unused_bytes || 0),
        pageCount: Number(row.page_count || 0),
        rowEstimate: Number(row.row_estimate || 0),
      }))
    : [];
  tableDetails.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const tableSizeMap = new Map(
    tableDetails.map((entry) => [entry.name, Number(entry.sizeBytes || 0)]),
  );

  const [
    revisionsStorageRow,
    commentsStorageRow,
    commentAttachmentsStorageRow,
    submissionsStorageRow,
    eventLogsStorageRow,
    pageViewsStorageRow,
    pageViewDailyStorageRow,
  ] = await Promise.all([
    get(
      "SELECT COUNT(*) AS count, SUM(LENGTH(CAST(content AS BLOB))) AS bytes FROM page_revisions",
    ),
    get(
      "SELECT COUNT(*) AS count, SUM(LENGTH(CAST(body AS BLOB))) AS bytes FROM comments",
    ),
    get(
      "SELECT COUNT(*) AS count, SUM(file_size) AS bytes FROM comment_attachments",
    ),
    get(
      "SELECT COUNT(*) AS count, SUM(LENGTH(CAST(content AS BLOB))) AS bytes FROM page_submissions",
    ),
    get(
      "SELECT COUNT(*) AS count, SUM(LENGTH(CAST(payload AS BLOB))) AS bytes FROM event_logs",
    ),
    get("SELECT COUNT(*) AS count FROM page_views"),
    get("SELECT COUNT(*) AS count FROM page_view_daily"),
  ]);

  const storageDefinitions = [
    {
      key: "pages",
      label: "Pages publiées",
      tableName: "pages",
      rows: totalPages,
      estimateBytes: Number(totalPagesRow?.content_bytes || 0),
    },
    {
      key: "page_revisions",
      label: "Révisions de page",
      tableName: "page_revisions",
      rows: Number(revisionsStorageRow?.count || 0),
      estimateBytes: Number(revisionsStorageRow?.bytes || 0),
    },
    {
      key: "comments",
      label: "Commentaires",
      tableName: "comments",
      rows: Number(commentsStorageRow?.count || 0),
      estimateBytes: Number(commentsStorageRow?.bytes || 0),
    },
    {
      key: "comment_attachments",
      label: "Pièces jointes de commentaires",
      tableName: "comment_attachments",
      rows: Number(commentAttachmentsStorageRow?.count || 0),
      estimateBytes: Number(commentAttachmentsStorageRow?.bytes || 0),
    },
    {
      key: "page_submissions",
      label: "Soumissions de pages",
      tableName: "page_submissions",
      rows: Number(submissionsStorageRow?.count || 0),
      estimateBytes: Number(submissionsStorageRow?.bytes || 0),
    },
    {
      key: "uploads",
      label: "Fichiers uploadés",
      tableName: "uploads",
      rows: totalUploadsCount,
      estimateBytes: Number(totalUploadsRow?.total_bytes || 0),
    },
    {
      key: "event_logs",
      label: "Journal d'événements",
      tableName: "event_logs",
      rows: Number(eventLogsStorageRow?.count || 0),
      estimateBytes: Number(eventLogsStorageRow?.bytes || 0),
    },
    {
      key: "page_views",
      label: "Historique des vues",
      tableName: "page_views",
      rows: Number(pageViewsStorageRow?.count || 0),
      estimateBytes: 0,
    },
    {
      key: "page_view_daily",
      label: "Agrégats de vues quotidiennes",
      tableName: "page_view_daily",
      rows: Number(pageViewDailyStorageRow?.count || 0),
      estimateBytes: 0,
    },
  ];

  const storageBreakdown = storageDefinitions
    .map((definition) => {
      const tableBytes = tableSizeMap.get(definition.tableName);
      const estimateBytes = Number(definition.estimateBytes || 0);
      let bytes = Number.isFinite(tableBytes) ? Number(tableBytes) : estimateBytes;
      if (!Number.isFinite(bytes) || bytes < 0) {
        bytes = 0;
      }
      let source = Number.isFinite(tableBytes) ? "table" : estimateBytes > 0 ? "estimate" : "unknown";
      const rows = Number.isFinite(definition.rows)
        ? Number(definition.rows)
        : Number.isFinite(Number(definition.rows))
        ? Number(definition.rows)
        : null;
      return {
        key: definition.key,
        label: definition.label,
        tableName: definition.tableName,
        rows,
        bytes,
        bytesSource: source,
        estimateBytes,
      };
    })
    .filter((entry) => {
      const hasRows = Number.isFinite(entry.rows) && Number(entry.rows) > 0;
      return hasRows || entry.bytes > 0;
    });

  const accountedBytes = storageBreakdown.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0),
    0,
  );
  const databaseAllocatedBytes =
    pragmaPageSize && pragmaPageCount ? pragmaPageSize * pragmaPageCount : databaseFileSize;
  const databaseUsedBytes =
    pragmaPageSize && pragmaPageCount
      ? pragmaPageSize * Math.max(pragmaPageCount - pragmaFreelistCount, 0)
      : databaseFileSize;
  const databaseFreeBytes = Math.max(databaseAllocatedBytes - databaseUsedBytes, 0);
  const percentageBase = databaseUsedBytes > 0 ? databaseUsedBytes : accountedBytes;
  const remainingBytes = Math.max(percentageBase - accountedBytes, 0);
  if (remainingBytes > 0) {
    storageBreakdown.push({
      key: "other",
      label: "Autres tables",
      tableName: null,
      rows: null,
      bytes: remainingBytes,
      bytesSource: "derived",
      estimateBytes: 0,
    });
  }
  const totalTrackedBytes = storageBreakdown.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0),
    0,
  );
  for (const entry of storageBreakdown) {
    entry.percentage = percentageBase > 0 ? (entry.bytes / percentageBase) * 100 : 0;
  }

  const storageStats = {
    databaseFileSize,
    databaseAllocatedBytes,
    databaseUsedBytes,
    databaseFreeBytes,
    pageSize: pragmaPageSize,
    pageCount: pragmaPageCount,
    freelistCount: pragmaFreelistCount,
    breakdown: storageBreakdown,
    totalTrackedBytes,
    percentageBaseBytes: percentageBase,
    tableDetails,
    tableDetailsError: tableDetailsError
      ? tableDetailsError?.message || String(tableDetailsError)
      : null,
  };

  const statsHandleMap = await resolveHandleColors([
    ...recentEvents.map((event) => event.username),
    ...topCommenters.map((row) => row.author),
  ]);
  const decoratedRecentEvents = recentEvents.map((event) => ({
    ...event,
    userRole: getHandleColor(event.username, statsHandleMap),
  }));
  const decoratedTopCommenters = topCommenters.map((row) => ({
    ...row,
    authorRole: getHandleColor(row.author, statsHandleMap),
  }));

  const normalizedViewTrends = Array.isArray(viewTrendsSeries?.points)
    ? viewTrendsSeries.points
    : [];
  const viewTrendsRange = {
    from: viewTrendsSeries?.startDate || null,
    to: viewTrendsSeries?.endDate || null,
  };
  const viewTrendsRangeDays = viewTrendsSeries?.rangeDays || VIEW_TRENDS_DEFAULT_RANGE;
  const viewTrendsTotal = Number(viewTrendsSeries?.totalViews || 0);
  const viewTrendsGeneratedAt = viewTrendsSeries?.generatedAt || new Date().toISOString();

  const engagementHighlights = [
    {
      icon: "📄",
      label: req.t("admin.stats.highlights.labels.publishedPages"),
      value: totalPages,
      secondary: req.t("admin.stats.highlights.secondary.newPagesThisWeek", { count: newPagesCount }),
    },
    {
      icon: "🗑️",
      label: req.t("admin.stats.highlights.labels.trashPages"),
      value: deletedPagesCount,
      secondary: req.t("admin.stats.highlights.secondary.readyToPurge"),
    },
    {
      icon: "⏳",
      label: req.t("admin.stats.highlights.labels.pendingSubmissions"),
      value: pendingSubmissionsCount,
      secondary: req.t("admin.stats.highlights.secondary.toModerate"),
    },
    {
      icon: "📦",
      label: req.t("admin.stats.highlights.labels.uploadedFiles"),
      value: totalUploadsCount,
      secondary: req.t("admin.stats.highlights.secondary.uploadsThisWeek", { count: newUploadsCount }),
    },
    {
      icon: "👀",
      label: req.t("admin.stats.highlights.labels.views7d"),
      value: newViewsCount,
      secondary: req.t("admin.stats.highlights.secondary.avgViewsPerPage", { avg: avgViewsPerPage }),
    },
    {
      icon: "💬",
      label: req.t("admin.stats.highlights.labels.comments7d"),
      value: newCommentsCount,
      secondary: req.t("admin.stats.highlights.secondary.likes7d", { count: newLikesCount }),
    },
  ];

  const now = Date.now();
  const allLiveVisitors = serializeLiveVisitors(now);
  const liveVisitorsPagination = buildPagination(
    req,
    allLiveVisitors.length,
    LIVE_VISITOR_PAGINATION_OPTIONS,
  );
  const liveOffset =
    (liveVisitorsPagination.page - 1) * liveVisitorsPagination.perPage;
  const liveVisitors = allLiveVisitors.slice(
    liveOffset,
    liveOffset + liveVisitorsPagination.perPage,
  );
  const liveVisitorsWindowSeconds = Math.round(ACTIVE_VISITOR_TTL_MS / 1000);

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
      events: Number(eventLogsStorageRow?.count || 0),
      uniqueIps: uniqueIps?.total || 0,
    },
    avgViewsPerPage,
    engagementHighlights,
    topLikedPages,
    topLikedPagination,
    topCommenters: decoratedTopCommenters,
    topCommentersPagination,
    topCommentedPages,
    topCommentedPagination,
    tagUsage,
    tagUsagePagination,
    commentTimeline,
    commentTimelinePagination,
    activeIps,
    activeIpsPagination,
    ipViewsByPage,
    ipViewsPagination,
    recentPages,
    recentEvents: decoratedRecentEvents,
    viewTrends: normalizedViewTrends,
    viewTrendsRange,
    viewTrendsRangeDays,
    viewTrendsTotal,
    viewTrendsGeneratedAt,
    liveVisitors,
    liveVisitorsPagination,
    liveVisitorsWindowSeconds,
    storageStats,
  });
});

r.get(
  "/stats/trends.json",
  requirePermission(["can_view_stats", "can_view_stats_basic"]),
  async (req, res) => {
    const requestedRange = normalizeTrendRangeInput(req.query?.range);
    const series = await fetchViewTrendsSeries(requestedRange);
    res.set("Cache-Control", "no-store");
    return res.json({
      range: {
        days: series.rangeDays,
        from: series.startDate,
        to: series.endDate,
      },
      totals: { views: series.totalViews },
      points: series.points,
      generatedAt: series.generatedAt,
    });
  },
);

r.get(
  "/stats/live",
  requirePermission(["can_view_stats", "can_view_stats_detailed"]),
  (req, res) => {
  const now = Date.now();
  const allLiveVisitors = serializeLiveVisitors(now);
  const windowSeconds = Math.round(ACTIVE_VISITOR_TTL_MS / 1000);
  const pagination = buildPagination(
    req,
    allLiveVisitors.length,
    LIVE_VISITOR_PAGINATION_OPTIONS,
  );
  const offset = (pagination.page - 1) * pagination.perPage;
  const visitors = allLiveVisitors.slice(offset, offset + pagination.perPage);

  res.json({
    ok: true,
    visitors,
    pagination: {
      page: pagination.page,
      perPage: pagination.perPage,
      totalItems: pagination.totalItems,
      totalPages: pagination.totalPages,
      hasPrevious: pagination.hasPrevious,
      hasNext: pagination.hasNext,
      previousPage: pagination.previousPage,
      nextPage: pagination.nextPage,
    },
    liveVisitorsWindowSeconds: windowSeconds,
  });
  },
);

r.post(
  "/uploads",
  requirePermission(["can_manage_uploads", "can_upload_files"]),
  upload.single("image"),
  async (req, res, next) => {
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
  },
);

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

r.get(
  "/uploads",
  requirePermission(["can_manage_uploads", "can_view_uploads"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const normalizedSearch = searchTerm.toLowerCase();
  const [uploadsList, profileUploads] = await Promise.all([
    listUploads(),
    listProfileUploads(),
  ]);
  const ordered = [...uploadsList].sort(
    (a, b) => (b.mtime || 0) - (a.mtime || 0),
  );
  const filtered = normalizedSearch
    ? ordered.filter((entry) => {
        const haystack = [
          entry.id,
          entry.filename,
          entry.originalName,
          entry.displayName,
          entry.extension,
        ]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase())
          .join(" ");
        return haystack.includes(normalizedSearch);
      })
    : ordered;

  const basePagination = buildPagination(req, filtered.length);
  const start = (basePagination.page - 1) * basePagination.perPage;
  const uploads = filtered.slice(start, start + basePagination.perPage);
  const pagination = decoratePagination(req, basePagination);

  res.render("admin/uploads", {
    uploads,
    pagination,
    searchTerm,
    profileUploads,
  });
  },
);

r.post(
  "/uploads/:id/name",
  requirePermission(["can_manage_uploads", "can_replace_files"]),
  async (req, res) => {
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
  },
);

r.post(
  "/uploads/:id/delete",
  requirePermission(["can_manage_uploads", "can_delete_files"]),
  async (req, res) => {
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
  },
);

// reactions
r.get(
  "/reactions",
  requirePermission(["can_manage_settings", "can_manage_features"]),
  async (_req, res) => {
    const reactions = await listReactionOptions();
    res.render("admin/reactions", { reactions });
  },
);

r.post(
  "/reactions",
  requirePermission(["can_manage_settings", "can_manage_features"]),
  async (req, res) => {
    try {
      const reaction = await createReactionOption({
        id: req.body?.id,
        label: req.body?.label,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Réaction ajoutée",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            key: reaction?.id || req.body?.id || null,
            label: reaction?.label || null,
            emoji: reaction?.emoji || null,
            imageUrl: reaction?.imageUrl || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: "Réaction ajoutée avec succès.",
      });
    } catch (err) {
      console.error("Impossible d'ajouter une réaction", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible d'ajouter la réaction. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/reactions");
  },
);

r.post(
  "/reactions/:key/update",
  requirePermission(["can_manage_settings", "can_manage_features"]),
  async (req, res) => {
    const reactionKey = req.params.key;
    try {
      const reaction = await updateReactionOption(reactionKey, {
        label: req.body?.label,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Réaction mise à jour",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            key: reaction?.id || reactionKey,
            label: reaction?.label || null,
            emoji: reaction?.emoji || null,
            imageUrl: reaction?.imageUrl || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: "Réaction mise à jour.",
      });
    } catch (err) {
      console.error("Impossible de mettre à jour la réaction", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de mettre à jour la réaction. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/reactions");
  },
);

r.post(
  "/reactions/:key/delete",
  requirePermission(["can_manage_settings", "can_manage_features"]),
  async (req, res) => {
    const reactionKey = req.params.key;
    try {
      const removed = await deleteReactionOption(reactionKey);
      if (!removed) {
        throw new Error("Réaction introuvable");
      }
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Réaction supprimée",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            key: reactionKey,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: "Réaction supprimée.",
      });
    } catch (err) {
      console.error("Impossible de supprimer la réaction", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de supprimer la réaction. Merci de réessayer.",
      });
    }
    res.redirect("/admin/reactions");
  },
);

r.post(
  "/reactions/:key/move",
  requirePermission(["can_manage_settings", "can_manage_features"]),
  async (req, res) => {
    const reactionKey = req.params.key;
    const direction = req.body?.direction === "up" ? "up" : "down";
    try {
      const moved = await moveReactionOption(reactionKey, direction);
      if (!moved) {
        throw new Error("Réaction déjà à cette position");
      }
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Réactions réordonnées",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            key: reactionKey,
            direction,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: "Ordre des réactions mis à jour.",
      });
    } catch (err) {
      console.error("Impossible de réordonner la réaction", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de réordonner la réaction. Merci de réessayer.",
      });
    }
    res.redirect("/admin/reactions");
  },
);

// settings
r.get(
  "/settings",
  requirePermission(["can_manage_settings", "can_update_general_settings"]),
  async (_req, res) => {
  const s = await getSiteSettingsForForm();
  res.render("admin/settings", { s });
  },
);
r.post(
  "/settings",
  requirePermission(["can_manage_settings", "can_update_general_settings"]),
  async (req, res) => {
  try {
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
          githubRepo: updated.githubRepo || null,
          changelogMode: updated.changelogMode,
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: "Paramètres enregistrés.",
    });
  } catch (err) {
    console.error("Impossible de mettre à jour les paramètres", err);
    pushNotification(req, {
      type: "error",
      message:
        err?.message ||
        "Impossible d'enregistrer les paramètres. Vérifiez les informations saisies.",
    });
  }
  res.redirect("/admin/settings");
  },
);

// roles
r.get(
  "/roles",
  requirePermission(["can_manage_roles", "can_view_roles"]),
  async (_req, res) => {
  const roles = await listRolesWithUsage();
  res.render("admin/roles", { roles, permissionCategories: PERMISSION_CATEGORIES });
  },
);
r.post(
  "/roles",
  requirePermission(["can_manage_roles", "can_create_roles"]),
  async (req, res) => {
    const wantsJson =
      req.xhr ||
      req.accepts(["json", "html"]) === "json" ||
      (req.get("accept") || "").includes("application/json") ||
      (req.get("content-type") || "").includes("application/json");

    const { name, description } = req.body;
    const permissions =
      typeof req.body.permissions === "object" && req.body.permissions
        ? req.body.permissions
        : extractPermissionsFromBody(req.body);

    try {
      const colorScheme = extractRoleColorFromBody(req.body);
      const role = await createRole({ name, description, color: colorScheme, permissions });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Rôle créé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            roleId: role.id,
            roleName: role.name,
            roleColor: role.colorPresentation?.label || null,
            permissions: buildPermissionSnapshot(role),
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: `Rôle ${role.name} créé avec succès.`,
      });
      if (wantsJson) {
        return res.json({ success: true, role });
      }
    } catch (error) {
      console.error("Failed to create role", error);
      const message = error?.message?.includes("UNIQUE")
        ? "Ce nom de rôle existe déjà."
        : error?.message || "Impossible de créer le rôle. Merci de réessayer.";
      pushNotification(req, {
        type: "error",
        message,
      });
      if (wantsJson) {
        return res.status(400).json({ success: false, message });
      }
    }

    return res.redirect("/admin/roles");
  },
);
r.post(
  "/roles/reorder",
  requirePermission(["can_manage_roles", "can_edit_roles"]),
  async (req, res) => {
    try {
      const rawOrder = req.body?.order;
      let desiredOrder = [];
      if (Array.isArray(rawOrder)) {
        desiredOrder = rawOrder;
      } else if (typeof rawOrder === "string") {
        desiredOrder = rawOrder
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      }
      const result = await updateRoleOrdering(desiredOrder);
      res.json({
        success: true,
        changed: result.changed,
        order: result.order,
      });
    } catch (error) {
      console.error("Failed to reorder roles", error);
      res.status(500).json({
        success: false,
        message: "Impossible de sauvegarder le nouvel ordre des rôles.",
      });
    }
  },
);
r.post(
  "/roles/:id",
  requirePermission(["can_manage_roles", "can_edit_roles", "can_delete_roles"]),
  async (req, res) => {
  const roleId = req.params.id;
  const existing = await getRoleById(roleId);
  if (!existing) {
    pushNotification(req, {
      type: "error",
      message: "Rôle introuvable.",
    });
    return res.redirect("/admin/roles");
  }
  const action = req.body._action;
  if (action === "delete") {
    if (existing.is_system || existing.isEveryone) {
      pushNotification(req, {
        type: "error",
        message: "Ce rôle ne peut pas être supprimé.",
      });
      return res.redirect("/admin/roles");
    }
    try {
      await deleteRole(existing.id);
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Rôle supprimé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            roleId: existing.id,
            roleName: existing.name,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: `Rôle ${existing.name} supprimé avec succès.`,
      });
    } catch (error) {
      console.error("Failed to delete role", error);
      pushNotification(req, {
        type: "error",
        message: error?.message || "Impossible de supprimer ce rôle.",
      });
    }
    return res.redirect("/admin/roles");
  }

  if (action === "reassign_to_everyone") {
    const everyoneRole = await getEveryoneRole();
    const everyoneRoleName = everyoneRole?.name || "Everyone";
    if (existing.isEveryone) {
      pushNotification(req, {
        type: "error",
        message: `Ce rôle est déjà ${everyoneRoleName}.`,
      });
      return res.redirect("/admin/roles");
    }
    try {
      if (!everyoneRole) {
        throw new Error(`Rôle ${everyoneRoleName} introuvable.`);
      }
      const { moved } = await reassignUsersToRole(existing.id, everyoneRole);
      const ip = getClientIp(req);
      await sendAdminEvent(
        `Utilisateurs réassignés vers ${everyoneRoleName}`,
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            sourceRoleId: existing.id,
            sourceRoleName: existing.name,
            targetRoleId: everyoneRole.id,
            targetRoleName: everyoneRole.name,
            movedUsers: moved,
          },
        },
        { includeScreenshot: false },
      );
      if (moved > 0) {
        const plural = moved > 1 ? "s" : "";
        pushNotification(req, {
          type: "success",
          message: `${moved} utilisateur${plural} déplacé${plural} vers ${everyoneRoleName}.`,
        });
      } else {
        pushNotification(req, {
          type: "info",
          message: "Aucun utilisateur à réassigner pour ce rôle.",
        });
      }
    } catch (error) {
      console.error("Failed to reassign role users", error);
      pushNotification(req, {
        type: "error",
        message:
          error?.message ||
          `Impossible de réassigner les utilisateurs vers ${everyoneRoleName}.`,
      });
    }
    return res.redirect("/admin/roles");
  }
  const permissions = extractPermissionsFromBody(req.body);
  const colorKeys = ["color", "roleColor", "color_mode", "colorMode", "roleColorMode"];
  const hasColorField = colorKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(req.body || {}, key),
  );
  const colorPayload = hasColorField ? extractRoleColorFromBody(req.body) : undefined;
  try {
    const updated = await updateRolePermissions(existing.id, {
      permissions,
      color: colorPayload,
    });
    const ip = getClientIp(req);
    await sendAdminEvent(
      "Permissions de rôle mises à jour",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          roleId: updated?.id || existing.id,
          roleName: updated?.name || existing.name,
          previousColor: existing.colorPresentation?.label || null,
          newColor:
            updated?.colorPresentation?.label || existing.colorPresentation?.label || null,
          previousPermissions: buildPermissionSnapshot(existing),
          newPermissions: buildPermissionSnapshot(
            updated ?? existing,
          ),
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Permissions mises à jour pour ${updated?.name || existing.name}.`,
    });
    const updatedRoleId = updated?.id || existing.id;
    if (req.session?.user?.role_id === updatedRoleId) {
      const refreshedSession = buildSessionUser(
        {
          ...req.session.user,
          role_id: updatedRoleId,
          role_snowflake_id: updatedRoleId,
          role_numeric_id:
            updated?.numeric_id ??
            existing.numeric_id ??
            req.session.user.role_numeric_id ??
            null,
          role_name: updated?.name || existing.name,
          role_color_serialized:
            updated?.colorSerialized ??
            existing.colorSerialized ??
            req.session.user.role_color_serialized ??
            null,
        },
        updated ?? existing,
      );
      req.session.user = { ...req.session.user, ...refreshedSession };
    }
  } catch (error) {
    console.error("Failed to update role", error);
    pushNotification(req, {
      type: "error",
      message:
        error?.message ||
        "Impossible de mettre à jour les permissions du rôle.",
    });
  }
  res.redirect("/admin/roles");
  },
);

// premium codes
r.get(
  "/premium-codes",
  requirePermission(["can_manage_roles", "can_assign_roles"]),
  async (req, res) => {
    let codes = [];
    let loadError = null;
    try {
      const fetched = await listPremiumCodes();
      codes = fetched.map((code) => {
        const expiresAt = code.expiresAt instanceof Date ? code.expiresAt : null;
        const redeemedAt = code.redeemedAt instanceof Date ? code.redeemedAt : null;
        const createdAt = code.createdAt instanceof Date ? code.createdAt : null;
        const now = Date.now();
        const isRedeemed = Boolean(redeemedAt);
        const isExpired = !isRedeemed && expiresAt ? expiresAt.getTime() <= now : false;
        return {
          ...code,
          isRedeemed,
          isExpired,
          premiumDurationLabel: formatPremiumDurationLabel(code.premiumDurationSeconds),
          expiresAtFormatted: expiresAt ? formatDateTimeLocalized(expiresAt) : null,
          expiresAtRelative: expiresAt
            ? formatRelativeDurationMs(Date.now() - expiresAt.getTime())
            : null,
          redeemedAtFormatted: redeemedAt ? formatDateTimeLocalized(redeemedAt) : null,
          redeemedAtRelative: redeemedAt
            ? formatRelativeDurationMs(Date.now() - redeemedAt.getTime())
            : null,
          createdAtFormatted: createdAt ? formatDateTimeLocalized(createdAt) : null,
          createdAtRelative: createdAt
            ? formatRelativeDurationMs(Date.now() - createdAt.getTime())
            : null,
        };
      });
    } catch (error) {
      console.error("Unable to list premium codes", error);
      loadError = "Impossible de charger la liste des codes premium.";
    }
    res.render("admin/premiumCodes", {
      codes,
      loadError,
      durationUnits: PREMIUM_CODE_DURATION_UNITS,
      formDefaults: {
        code: "",
        expiresValue: "7",
        expiresUnit: "days",
        durationValue: "30",
        durationUnit: "days",
      },
    });
  },
);

r.post(
  "/premium-codes",
  requirePermission(["can_manage_roles", "can_assign_roles"]),
  async (req, res) => {
    const rawCode = typeof req.body.code === "string" ? req.body.code.trim() : "";
    const expiresValue = req.body.expiresValue;
    const expiresUnit = req.body.expiresUnit;
    const durationValue = req.body.durationValue;
    const durationUnit = req.body.durationUnit;
    const expiresMs = parseAdminDurationInput(expiresValue, expiresUnit, { allowZero: true });
    const durationMs = parseAdminDurationInput(durationValue, durationUnit, { allowZero: false });
    const expiresAt = expiresMs && expiresMs > 0 ? new Date(Date.now() + expiresMs) : null;
    if (!durationMs || durationMs <= 0) {
      pushNotification(req, {
        type: "error",
        message: "Veuillez indiquer une durée premium valide (supérieure à zéro).",
      });
      return res.redirect("/admin/premium-codes");
    }
    try {
      const created = await createPremiumCode({
        code: rawCode,
        expiresAt,
        premiumDurationMs: durationMs,
        createdBy: req.session.user?.id || null,
      });
      pushNotification(req, {
        type: "success",
        message: `Le code premium ${created.code} a été généré avec succès.`,
      });
      await sendAdminEvent(
        "Code premium créé",
        {
          user: req.session.user?.username || null,
          extra: {
            code: created.code,
            expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
            premiumDurationSeconds: created.premiumDurationSeconds,
          },
        },
        { includeScreenshot: false },
      );
    } catch (error) {
      if (error instanceof PremiumCodeError) {
        pushNotification(req, {
          type: "error",
          message: error.message,
        });
        return res.redirect("/admin/premium-codes");
      }
      console.error("Unable to create premium code", error);
      pushNotification(req, {
        type: "error",
        message: "Impossible de créer ce code premium.",
      });
    }
    res.redirect("/admin/premium-codes");
  },
);

r.post(
  "/premium-codes/:id/delete",
  requirePermission(["can_manage_roles", "can_assign_roles"]),
  async (req, res) => {
    const identifier = req.params.id;
    try {
      const deleted = await deletePremiumCode(identifier);
      if (deleted) {
        pushNotification(req, {
          type: "success",
          message: `Le code premium ${deleted.code} a été supprimé.`,
        });
        await sendAdminEvent(
          "Code premium supprimé",
          {
            user: req.session.user?.username || null,
            extra: {
              code: deleted.code,
              expiresAt: deleted.expiresAt ? deleted.expiresAt.toISOString() : null,
            },
          },
          { includeScreenshot: false },
        );
      } else {
        pushNotification(req, {
          type: "error",
          message: "Code introuvable ou déjà supprimé.",
        });
      }
    } catch (error) {
      if (error instanceof PremiumCodeError) {
        pushNotification(req, {
          type: "error",
          message: error.message,
        });
      } else {
        console.error("Unable to delete premium code", error);
        pushNotification(req, {
          type: "error",
          message: "Impossible de supprimer ce code premium.",
        });
      }
    }
    res.redirect("/admin/premium-codes");
  },
);

// users
r.get(
  "/users",
  requirePermission(["can_manage_users", "can_view_users"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(CAST(u.id AS TEXT) LIKE ? OR u.username LIKE ? OR COALESCE(u.display_name,'') LIKE ?)",
    );
    params.push(like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const totalRow = await get(
    `SELECT COUNT(*) AS total FROM users u ${where}`,
    params,
  );
  const basePagination = buildPagination(req, Number(totalRow?.total ?? 0));
  const offset = (basePagination.page - 1) * basePagination.perPage;

  const users = await all(
    `SELECT u.id, u.username, u.display_name, u.is_admin, u.is_moderator, u.is_helper, u.is_contributor, u.can_comment, u.can_submit_pages, u.role_id, u.is_banned, u.ban_reason, u.banned_at, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ${where}
     ORDER BY u.id
     LIMIT ? OFFSET ?`,
    [...params, basePagination.perPage, offset],
  );
  const availableRoles = await listRoles();
  const everyoneRole =
    availableRoles.find((role) => role.isEveryone) || null;
  const administratorRole =
    availableRoles.find((role) => role.isAdministrator) || null;
  const fallbackEveryoneName = everyoneRole?.name || "Everyone";
  const fallbackAdministratorName = administratorRole?.name || "Administrateur";
  const userIds = users
    .map((user) => Number.parseInt(user.id, 10))
    .filter((id) => Number.isInteger(id));
  const roleAssignments = await listRolesForUsers(userIds);
  let ipProfilesByUser = {};
  if (userIds.length) {
    const ipPlaceholders = userIds.map(() => "?").join(", ");
    const ipRows = await all(
      `SELECT claimed_user_id AS user_id, hash, claimed_at
         FROM ip_profiles
        WHERE claimed_user_id IN (${ipPlaceholders})
        ORDER BY claimed_at DESC`,
      userIds,
    );
    ipProfilesByUser = ipRows.reduce((acc, row) => {
      const id = Number.parseInt(row.user_id, 10);
      if (!Number.isInteger(id)) {
        return acc;
      }
      if (!acc[id]) {
        acc[id] = [];
      }
      acc[id].push({
        hash: row.hash,
        shortHash: formatIpProfileLabel(row.hash),
        claimedAt: row.claimed_at || null,
      });
      return acc;
    }, {});
  }
  const userHandleMap = await resolveHandleColors(users.map((user) => user.username));
  const normalizedUsers = users.map((user) => {
    const isAdmin = Boolean(user.is_admin);
    const canComment = Boolean(user.can_comment);
    const canSubmit = Boolean(user.can_submit_pages);
    const numericId = Number.parseInt(user.id, 10);
    const assignedRoles =
      (Number.isInteger(numericId) ? roleAssignments.get(numericId) : null) || [];
    const primaryRole = assignedRoles[0] || null;
    const roleLabel = assignedRoles.length
      ? assignedRoles.map((role) => role.name).join(", ")
      : user.role_name || (isAdmin ? fallbackAdministratorName : fallbackEveryoneName);
    const handleProfile = getHandleColor(user.username, userHandleMap);
    const colorScheme =
      handleProfile?.colorScheme || primaryRole?.color || parseStoredRoleColor(user.role_color);
    const colorPresentation =
      handleProfile?.color || primaryRole?.colorPresentation || buildRoleColorPresentation(colorScheme);
    return {
      ...user,
      is_admin: isAdmin,
      can_comment: canComment,
      can_submit_pages: canSubmit,
      role_label: roleLabel,
      role_color: colorPresentation,
      role_color_scheme: colorScheme,
      role_color_serialized:
        primaryRole?.colorSerialized ||
        (typeof user.role_color === "string"
          ? user.role_color
          : colorScheme
            ? JSON.stringify(colorScheme)
            : null),
      role_snowflake_id: primaryRole?.id || user.role_snowflake_id || null,
      roles: assignedRoles,
      is_banned: Boolean(user.is_banned),
      ban_reason: user.ban_reason || null,
      banned_at: user.banned_at || null,
      ipProfiles: Number.isInteger(numericId) ? ipProfilesByUser[numericId] || [] : [],
      badges: handleProfile?.badges || [],
    };
  });
  const pagination = decoratePagination(req, basePagination);
  res.render("admin/users", {
    users: normalizedUsers,
    pagination,
    searchTerm,
    roles: availableRoles,
    defaultRoleId: everyoneRole?.id || null,
  });
  },
);
r.post(
  "/users",
  requirePermission(["can_manage_users", "can_invite_users"]),
  async (req, res) => {
  const { username, password } = req.body;
  const rawRoleSelection =
    req.body.roleIds ?? req.body.roleId ?? req.body.role ?? [];
  const selectedRoleIds = (Array.isArray(rawRoleSelection)
    ? rawRoleSelection
    : [rawRoleSelection]
  )
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value);
  if (!username || !password) {
    pushNotification(req, {
      type: "error",
      message: "Nom d'utilisateur et mot de passe requis.",
    });
    return res.redirect("/admin/users");
  }
  const sanitizedUsername = username.trim();
  const fetchedRoles = await Promise.all(
    selectedRoleIds.map((id) => getRoleById(id)),
  );
  const validRoles = fetchedRoles.filter(Boolean);
  if (!validRoles.length) {
    pushNotification(req, {
      type: "error",
      message: "Sélectionnez au moins un rôle valide.",
    });
    return res.redirect("/admin/users");
  }
  const sortedRoles = sortRolesForAssignment(validRoles);
  let mergedFlags = { ...DEFAULT_ROLE_FLAGS };
  for (const role of sortedRoles) {
    mergedFlags = mergeRoleFlags(mergedFlags, role);
  }
  const hashed = await hashPassword(password);
  try {
    const roleFlagValues = ROLE_FLAG_FIELDS.map((field) =>
      mergedFlags[field] ? 1 : 0,
    );
    const primaryRole = sortedRoles[0] || null;
    const result = await run(
      `INSERT INTO users(snowflake_id, username, password, role_id, ${ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?, ?, ${ROLE_FLAG_VALUE_PLACEHOLDERS})`,
      [
        generateSnowflake(),
        sanitizedUsername,
        hashed,
        primaryRole?.numeric_id ?? null,
        ...roleFlagValues,
      ],
    );
    await assignRoleToUser(result.lastID, sortedRoles);
    const ip = getClientIp(req);
    const roleSummary = sortedRoles.map((role) => role.name).join(", ");
    const primaryColor = primaryRole?.colorPresentation?.label || null;
    await sendAdminEvent(
      "Utilisateur créé",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          newUser: sanitizedUsername,
          userId: result?.lastID || null,
          roleIds: sortedRoles.map((role) => role.id),
          roleNames: sortedRoles.map((role) => role.name),
          roleColor: primaryColor,
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Utilisateur ${sanitizedUsername} créé (${roleSummary}).`,
    });
  } catch (error) {
    if (
      error?.code === "SQLITE_CONSTRAINT" ||
      error?.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      pushNotification(req, {
        type: "error",
        message: "Ce nom d'utilisateur existe déjà.",
      });
    } else {
      console.error("Failed to create user", error);
      pushNotification(req, {
        type: "error",
        message: "Impossible de créer l'utilisateur. Merci de réessayer.",
      });
    }
    return res.redirect("/admin/users");
  }
  res.redirect("/admin/users");
  },
);
r.post(
  "/users/:id/display-name",
  requirePermission(["can_manage_users", "can_edit_users"]),
  async (req, res) => {
  const target = await get(
    "SELECT id, username, display_name FROM users WHERE id=?",
    [req.params.id],
  );
  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/users");
  }

  const displayName = (req.body.displayName || "").trim().slice(0, 80);
  const normalizedDisplayName = displayName || null;
  const previousDisplayName = (target.display_name || "").trim() || null;

  if (previousDisplayName === normalizedDisplayName) {
    pushNotification(req, {
      type: "info",
      message: `Aucun changement pour ${target.username}.`,
    });
    return res.redirect("/admin/users");
  }

  await run("UPDATE users SET display_name=? WHERE id=?", [
    normalizedDisplayName,
    target.id,
  ]);

  if (req.session.user?.id === target.id) {
    req.session.user.display_name = normalizedDisplayName;
  }

  const ip = getClientIp(req);
  await sendAdminEvent(
    "Pseudo administrateur mis à jour",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        previousDisplayName,
        newDisplayName: normalizedDisplayName,
      },
    },
    { includeScreenshot: false },
  );

  pushNotification(req, {
    type: "success",
    message: normalizedDisplayName
      ? `Pseudo mis à jour pour ${target.username} (${normalizedDisplayName}).`
      : `Pseudo supprimé pour ${target.username}.`,
  });

  res.redirect("/admin/users");
  },
);
r.post(
  "/users/:id/role",
  requirePermission([
    "can_manage_users",
    "can_edit_users",
    "can_assign_roles",
  ]),
  async (req, res) => {
  const target = await get(
    `SELECT u.id, u.username, u.role_id, u.is_admin, u.is_moderator, u.is_helper, u.is_contributor, r.name AS role_name, r.color AS role_color, r.snowflake_id AS role_snowflake_id
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id=?`,
    [req.params.id],
  );
  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/users");
  }

  const currentRoleMap = await listRolesForUsers([target.id]);
  const currentRoles =
    currentRoleMap.get(Number.parseInt(target.id, 10)) || [];

  const rawRoleSelection =
    req.body?.roleIds ?? req.body?.roleId ?? req.body?.role ?? [];
  const requestedRoleIds = (Array.isArray(rawRoleSelection)
    ? rawRoleSelection
    : [rawRoleSelection]
  )
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value);
  const fetchedRoles = await Promise.all(
    requestedRoleIds.map((id) => getRoleById(id)),
  );
  const validRoles = fetchedRoles.filter(Boolean);

  if (!validRoles.length) {
    pushNotification(req, {
      type: "error",
      message: "Sélectionnez au moins un rôle valide.",
    });
    return res.redirect("/admin/users");
  }

  const sortedRoles = sortRolesForAssignment(validRoles);

  const [everyoneRole, administratorRole] = await Promise.all([
    getEveryoneRole(),
    getRoleById(ADMINISTRATOR_ROLE_SNOWFLAKE),
  ]);
  const fallbackEveryoneName = everyoneRole?.name || "Everyone";
  const fallbackAdministratorName = administratorRole?.name || "Administrateur";
  const previousRoleNames = currentRoles.length
    ? currentRoles.map((role) => role.name)
    : [
        target.role_name ||
          (target.is_admin ? fallbackAdministratorName : fallbackEveryoneName),
      ];
  const previousRoleColorPresentation =
    currentRoles[0]?.colorPresentation ||
    buildRoleColorPresentation(parseStoredRoleColor(target.role_color));

  const currentRoleIds = new Set(
    currentRoles
      .map((role) => role.numeric_id)
      .filter((value) => Number.isInteger(value)),
  );
  const newRoleIds = new Set(
    sortedRoles
      .map((role) => role.numeric_id)
      .filter((value) => Number.isInteger(value)),
  );
  const sameSelection =
    currentRoleIds.size === newRoleIds.size &&
    [...currentRoleIds].every((id) => newRoleIds.has(id));

  if (sameSelection) {
    pushNotification(req, {
      type: "info",
      message: `Aucun changement pour ${target.username}.`,
    });
    return res.redirect("/admin/users");
  }

  const updatedRoles = await assignRoleToUser(target.id, sortedRoles);
  const refreshedUser = await get(
    `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id=?`,
    [target.id],
  );
  const finalRoles = updatedRoles && updatedRoles.length ? updatedRoles : sortedRoles;

  if (req.session.user?.id === target.id) {
    const updatedSession = buildSessionUser({
      ...refreshedUser,
      roles: finalRoles,
    });
    req.session.user = { ...req.session.user, ...updatedSession };
  }

  const newRoleNames = finalRoles.map((role) => role.name);
  const newRoleColor = finalRoles[0]?.colorPresentation?.label || null;

  const ip = getClientIp(req);
  await sendAdminEvent(
    "Rôle utilisateur mis à jour",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        previousRoles: previousRoleNames,
        newRoleIds: finalRoles.map((role) => role.id),
        newRoleNames,
        previousRoleColor: previousRoleColorPresentation?.label || null,
        newRoleColor,
      },
    },
    { includeScreenshot: false },
  );

  pushNotification(req, {
    type: "success",
    message: `Rôles mis à jour pour ${target.username} (${newRoleNames.join(", ")}).`,
  });

  res.redirect("/admin/users");
  },
);
r.post(
  "/users/:id/delete",
  requirePermission(["can_manage_users", "can_delete_users", "can_suspend_users"]),
  async (req, res) => {
  const target = await get(
    "SELECT id, username, display_name FROM users WHERE id=?",
    [req.params.id],
  );
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
  },
);

r.post(
  "/users/:id/unban",
  requirePermission(["can_manage_users", "can_suspend_users"]),
  async (req, res) => {
  const target = await get(
    "SELECT id, username, is_banned FROM users WHERE id=?",
    [req.params.id],
  );
  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/users");
  }
  if (!target.is_banned) {
    pushNotification(req, {
      type: "info",
      message: `${target.username} n'est pas banni.`,
    });
    return res.redirect("/admin/users");
  }
  await run(
    `UPDATE users
        SET is_banned=0,
            ban_reason=NULL,
            banned_at=NULL,
            banned_by=NULL
      WHERE id=?`,
    [target.id],
  );
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Compte utilisateur débanni",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
      },
    },
    { includeScreenshot: false },
  );
  if (req.session.user?.id === target.id) {
    req.session.user = {
      ...req.session.user,
      is_banned: false,
      ban_reason: null,
      banned_at: null,
    };
  }
  pushNotification(req, {
    type: "success",
    message: `${target.username} a été débanni.`,
  });
  res.redirect("/admin/users");
  },
);

r.post(
  "/users/:id/ip-profiles/link",
  requirePermission(["can_manage_users", "can_manage_ip_profiles"]),
  async (req, res) => {
  const target = await get(
    "SELECT id, username FROM users WHERE id=?",
    [req.params.id],
  );
  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/users");
  }
  const rawHash = typeof req.body.hash === "string" ? req.body.hash.trim().toLowerCase() : "";
  if (!rawHash) {
    pushNotification(req, {
      type: "error",
      message: "Merci de fournir un hash de profil IP.",
    });
    return res.redirect("/admin/users");
  }
  const force = req.body.force === "1" || req.body.force === "on";
  const result = await linkIpProfileToUser(rawHash, target.id, { force });
  if (!result.updated) {
    let message = "Impossible d'associer ce profil IP.";
    if (result.reason === "invalid") {
      message = "Hash de profil IP invalide.";
    } else if (result.reason === "not_found") {
      message = "Profil IP introuvable.";
    } else if (result.reason === "already_claimed") {
      message = "Ce profil IP est déjà associé à un autre compte. Activez l'option forcer pour écraser l'association.";
    } else if (result.reason === "already_linked") {
      message = "Ce profil IP est déjà associé à cet utilisateur.";
    }
    pushNotification(req, {
      type: "error",
      message,
    });
    return res.redirect("/admin/users");
  }
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Profil IP associé à un utilisateur",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        profileHash: rawHash,
        shortHash: formatIpProfileLabel(rawHash),
        previousUserId: result.previousUserId || null,
        forced: Boolean(force),
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: `Profil IP ${formatIpProfileLabel(rawHash)} associé à ${target.username}.`,
  });
  res.redirect("/admin/users");
  },
);

r.post(
  "/users/:id/ip-profiles/:hash/unlink",
  requirePermission(["can_manage_users", "can_manage_ip_profiles"]),
  async (req, res) => {
  const target = await get(
    "SELECT id, username FROM users WHERE id=?",
    [req.params.id],
  );
  if (!target) {
    pushNotification(req, {
      type: "error",
      message: "Utilisateur introuvable.",
    });
    return res.redirect("/admin/users");
  }
  const rawHash = typeof req.params.hash === "string" ? req.params.hash.trim().toLowerCase() : "";
  if (!rawHash) {
    pushNotification(req, {
      type: "error",
      message: "Profil IP introuvable.",
    });
    return res.redirect("/admin/users");
  }
  const result = await unlinkIpProfile(rawHash, { expectedUserId: target.id });
  if (!result.updated) {
    let message = "Impossible de retirer ce profil IP.";
    if (result.reason === "invalid") {
      message = "Hash de profil IP invalide.";
    } else if (result.reason === "not_found") {
      message = "Profil IP introuvable.";
    } else if (result.reason === "mismatch") {
      message = "Ce profil IP est associé à un autre compte.";
    }
    pushNotification(req, {
      type: "error",
      message,
    });
    return res.redirect("/admin/users");
  }
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Profil IP retiré d'un utilisateur",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        profileHash: rawHash,
        shortHash: formatIpProfileLabel(rawHash),
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: `Profil IP ${formatIpProfileLabel(rawHash)} retiré de ${target.username}.`,
  });
  res.redirect("/admin/users");
  },
);

// badges
r.get(
  "/badges",
  requirePermission([
    "can_manage_badges",
    "can_view_badges",
    "can_assign_badges",
    "can_create_badges",
    "can_edit_badges",
    "can_delete_badges",
    "can_revoke_badges",
  ]),
  async (req, res, next) => {
    try {
      const badges = await listBadgesWithAssignments();
      const assignmentHandles = [];
      for (const badge of badges) {
        if (!badge?.assignees) continue;
        for (const assignment of badge.assignees) {
          if (assignment?.username) {
            assignmentHandles.push(assignment.username);
          }
          if (assignment?.displayName) {
            assignmentHandles.push(assignment.displayName);
          }
        }
      }
      const handleMap = await resolveHandleColors(assignmentHandles);
      const decorateBadgeAssignments = (badge) => ({
        ...badge,
        assignees: Array.isArray(badge.assignees)
          ? badge.assignees.map((assignment) => ({
              ...assignment,
              userRole:
                getHandleColor(assignment.username, handleMap) ||
                getHandleColor(assignment.displayName, handleMap),
            }))
          : [],
      });
      const achievementCriteria = getAchievementDefinitions();
      const criteriaByKey = new Map(
        achievementCriteria.map((criterion) => [criterion.key, criterion]),
      );
      const successBadges = badges
        .filter((badge) => badge.category === "success")
        .map((badge) => ({
          ...decorateBadgeAssignments(badge),
          criterion: criteriaByKey.get(badge.automaticKey || "") || null,
        }));
      const manualBadges = badges
        .filter((badge) => badge.category !== "success")
        .map((badge) => decorateBadgeAssignments(badge));
      const assignedCriterionKeys = successBadges
        .map((badge) => badge.automaticKey)
        .filter((key) => typeof key === "string" && key.trim().length > 0);
      const permissions = req.permissionFlags || {};
      res.render("admin/badges", {
        badges: manualBadges,
        manualBadges,
        successBadges,
        achievementCriteria,
        assignedCriterionKeys,
        canCreateBadges:
          permissions.can_manage_badges || permissions.can_create_badges,
        canEditBadges:
          permissions.can_manage_badges || permissions.can_edit_badges,
        canDeleteBadges:
          permissions.can_manage_badges || permissions.can_delete_badges,
        canAssignBadges:
          permissions.can_manage_badges || permissions.can_assign_badges,
        canRevokeBadges:
          permissions.can_manage_badges || permissions.can_revoke_badges,
      });
    } catch (err) {
      next(err);
    }
  },
);

r.post(
  "/badges/success",
  requirePermission(["can_manage_badges", "can_create_badges"]),
  async (req, res) => {
    try {
      const badge = await createAchievementBadge({
        criterionKey: req.body?.criterionKey,
        name: req.body?.name,
        description: req.body?.description,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge de succès créé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId: badge?.snowflakeId || null,
            badgeName: badge?.name || null,
            criterionKey: badge?.automaticKey || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge de succès « ${badge.name} » créé.`
          : "Badge de succès créé.",
      });
    } catch (err) {
      console.error("Impossible de créer le badge de succès", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de créer le badge de succès. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/success/:badgeId/update",
  requirePermission(["can_manage_badges", "can_edit_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    try {
      const badge = await updateAchievementBadge(badgeId, {
        criterionKey: req.body?.criterionKey,
        name: req.body?.name,
        description: req.body?.description,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge de succès mis à jour",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId: badge?.snowflakeId || badgeId,
            badgeName: badge?.name || null,
            criterionKey: badge?.automaticKey || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge de succès « ${badge.name} » mis à jour.`
          : "Badge de succès mis à jour.",
      });
    } catch (err) {
      console.error("Impossible de mettre à jour le badge de succès", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de mettre à jour ce badge de succès. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/success/:badgeId/delete",
  requirePermission(["can_manage_badges", "can_delete_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    try {
      const badge = await getBadgeBySnowflake(badgeId);
      await deleteAchievementBadge(badgeId);
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge de succès supprimé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId,
            badgeName: badge?.name || null,
            criterionKey: badge?.automaticKey || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge de succès « ${badge.name} » supprimé.`
          : "Badge de succès supprimé.",
      });
    } catch (err) {
      console.error("Impossible de supprimer le badge de succès", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de supprimer ce badge de succès. Merci de réessayer.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges",
  requirePermission(["can_manage_badges", "can_create_badges"]),
  async (req, res) => {
    try {
      const badge = await createBadge({
        name: req.body?.name,
        description: req.body?.description,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge créé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId: badge?.snowflakeId || null,
            badgeName: badge?.name || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge « ${badge.name} » ajouté.`
          : "Badge créé.",
      });
    } catch (err) {
      console.error("Impossible de créer le badge", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de créer le badge. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/:badgeId/update",
  requirePermission(["can_manage_badges", "can_edit_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    try {
      const badge = await updateBadge(badgeId, {
        name: req.body?.name,
        description: req.body?.description,
        emoji: req.body?.emoji,
        imageUrl: req.body?.imageUrl,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge mis à jour",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId: badge?.snowflakeId || badgeId,
            badgeName: badge?.name || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge « ${badge.name} » mis à jour.`
          : "Badge mis à jour.",
      });
    } catch (err) {
      console.error("Impossible de mettre à jour le badge", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de mettre à jour le badge. Vérifiez les informations saisies.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/:badgeId/delete",
  requirePermission(["can_manage_badges", "can_delete_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    try {
      const badge = await getBadgeBySnowflake(badgeId);
      const removed = await deleteBadge(badgeId);
      if (!removed) {
        throw new Error("Badge introuvable");
      }
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge supprimé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId,
            badgeName: badge?.name || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: badge?.name
          ? `Badge « ${badge.name} » supprimé.`
          : "Badge supprimé.",
      });
    } catch (err) {
      console.error("Impossible de supprimer le badge", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de supprimer le badge. Merci de réessayer.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/:badgeId/assign",
  requirePermission(["can_manage_badges", "can_assign_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    const username = req.body?.username;
    try {
      const assignment = await assignBadgeToUser({
        badgeSnowflakeId: badgeId,
        username,
        assignedByUserId: req.session.user?.id || null,
      });
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge attribué",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId: assignment.badge?.snowflakeId || badgeId,
            badgeName: assignment.badge?.name || null,
            targetUser: assignment.user?.username || username,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: assignment.user?.username
          ? `Badge attribué à ${assignment.user.username}.`
          : "Badge attribué.",
      });
    } catch (err) {
      console.error("Impossible d'attribuer le badge", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible d'attribuer le badge à cet utilisateur.",
      });
    }
    res.redirect("/admin/badges");
  },
);

r.post(
  "/badges/:badgeId/revoke",
  requirePermission(["can_manage_badges", "can_revoke_badges"]),
  async (req, res) => {
    const badgeId = req.params.badgeId;
    const username = req.body?.username;
    const normalizedUsername =
      typeof username === "string" ? username.trim() : "";
    try {
      const badge = await getBadgeBySnowflake(badgeId);
      if (!badge) {
        throw new Error("Badge introuvable.");
      }
      const removed = await revokeBadgeFromUser({
        badgeSnowflakeId: badgeId,
        username,
      });
      if (!removed) {
        throw new Error("Aucune attribution trouvée pour cet utilisateur.");
      }
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Badge retiré",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            badgeId,
            badgeName: badge.name,
            targetUser: normalizedUsername || null,
          },
        },
        { includeScreenshot: false },
      );
      pushNotification(req, {
        type: "success",
        message: normalizedUsername
          ? `Badge retiré pour ${normalizedUsername}.`
          : "Badge retiré.",
      });
    } catch (err) {
      console.error("Impossible de retirer le badge", err);
      pushNotification(req, {
        type: "error",
        message:
          err?.message ||
          "Impossible de retirer le badge pour cet utilisateur.",
      });
    }
    res.redirect("/admin/badges");
  },
);

// likes table improved
r.get(
  "/likes",
  requirePermission(["can_manage_likes", "can_view_likes"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(CAST(l.id AS TEXT) LIKE ? OR COALESCE(l.ip,'') LIKE ? OR COALESCE(p.slug_id,'') LIKE ? OR COALESCE(p.title,'') LIKE ?)",
    );
    params.push(like, like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const totalRow = await get(
    `SELECT COUNT(*) AS total
       FROM likes l
       JOIN pages p ON p.id = l.page_id
      ${where}`,
    params,
  );
  const totalLikes = Number(totalRow?.total ?? 0);
  const basePagination = buildPagination(req, totalLikes);
  const offset = (basePagination.page - 1) * basePagination.perPage;

  const rows = await all(
    `
    SELECT l.id, l.ip, l.created_at, p.title, p.slug_id
      FROM likes l
      JOIN pages p ON p.id = l.page_id
      ${where}
     ORDER BY l.created_at DESC
     LIMIT ? OFFSET ?
  `,
    [...params, basePagination.perPage, offset],
  );
  const pagination = decoratePagination(req, basePagination);

  res.render("admin/likes", { rows, pagination, searchTerm });
  },
);
r.post(
  "/likes/:id/delete",
  requirePermission(["can_manage_likes", "can_remove_likes"]),
  async (req, res) => {
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
  },
);

r.get(
  "/trash",
  requirePermission(["can_manage_trash", "can_view_trash"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(COALESCE(title,'') LIKE ? OR COALESCE(slug_id,'') LIKE ? OR COALESCE(deleted_by,'') LIKE ? OR COALESCE(author,'') LIKE ?)",
    );
    params.push(like, like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const totalRow = await get(
    `SELECT COUNT(*) AS total FROM deleted_pages ${where}`,
    params,
  );
  const total = Number(totalRow?.total ?? 0);
  const basePagination = buildPagination(req, total);
  const offset = (basePagination.page - 1) * basePagination.perPage;

  const trashedRows = await all(
    `SELECT id, snowflake_id, slug_id, slug_base, title, author, deleted_at, deleted_by, created_at, updated_at, tags_json
       FROM deleted_pages
       ${where}
      ORDER BY deleted_at DESC
      LIMIT ? OFFSET ?`,
    [...params, basePagination.perPage, offset],
  );

  const trashedPages = trashedRows.map((row) => ({
    id: row.id,
    snowflake_id: row.snowflake_id,
    slug_id: row.slug_id,
    slug_base: row.slug_base,
    title: row.title,
    author: row.author || null,
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags: parseTagsJson(row.tags_json),
  }));

  const pagination = decoratePagination(req, basePagination);

  res.render("admin/trash", {
    trashedPages,
    pagination,
    searchTerm,
  });
  },
);

r.post(
  "/trash/:id/restore",
  requirePermission(["can_manage_trash", "can_restore_trash"]),
  async (req, res) => {
  const trashed = await get(
    `SELECT * FROM deleted_pages WHERE snowflake_id = ?`,
    [req.params.id],
  );

  if (!trashed) {
    pushNotification(req, {
      type: "error",
      message: "Élément introuvable dans la corbeille.",
    });
    return res.redirect("/admin/trash");
  }

  const slugConflict = await get(`SELECT id FROM pages WHERE slug_id = ?`, [
    trashed.slug_id,
  ]);
  if (slugConflict?.id) {
    pushNotification(req, {
      type: "error",
      message:
        "Impossible de restaurer la page : un article actif utilise déjà ce même identifiant.",
    });
    return res.redirect("/admin/trash");
  }

  const tags = parseTagsJson(trashed.tags_json);
  const comments = parseCommentsJson(trashed.comments_json);
  const stats = parseStatsJson(trashed.stats_json);
  const snowflake = trashed.page_snowflake_id || generateSnowflake();
  const restoredTitle = trashed.title || "Page restaurée";
  const restoredLabel = trashed.title ? `« ${restoredTitle} »` : "La page";

  await run("BEGIN");
  try {
    const insert = await run(
      `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        snowflake,
        trashed.slug_base,
        trashed.slug_id,
        restoredTitle,
        trashed.content || "",
        trashed.author || null,
        trashed.status || "published",
        trashed.publish_at || null,
        trashed.created_at || null,
        trashed.updated_at || null,
      ],
    );

    const pageId = insert?.lastID;
    if (pageId) {
      if (tags.length) {
        await upsertTags(pageId, tags);
      }
      if (comments.length) {
        for (const comment of comments) {
          await run(
            `INSERT INTO comments(snowflake_id, page_id, author, body, created_at, updated_at, ip, edit_token, status, author_is_admin)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            [
              comment.snowflake_id,
              pageId,
              comment.author,
              comment.body,
              comment.created_at,
              comment.updated_at,
              comment.ip,
              comment.edit_token,
              comment.status,
              comment.author_is_admin ? 1 : 0,
            ],
          );
        }
      }
      if (stats.likes.length) {
        for (const like of stats.likes) {
          await run(
            `INSERT INTO likes(snowflake_id, page_id, ip, created_at) VALUES(?,?,?,?)`,
            [
              like.snowflake_id || generateSnowflake(),
              pageId,
              like.ip,
              like.created_at,
            ],
          );
        }
      }
      if (stats.viewEvents.length) {
        for (const view of stats.viewEvents) {
          await run(
            `INSERT INTO page_views(snowflake_id, page_id, ip, viewed_at) VALUES(?,?,?,?)`,
            [
              view.snowflake_id || generateSnowflake(),
              pageId,
              view.ip,
              view.viewed_at,
            ],
          );
        }
      }
      if (stats.viewDaily.length) {
        for (const view of stats.viewDaily) {
          await run(
            `INSERT INTO page_view_daily(snowflake_id, page_id, day, views) VALUES(?,?,?,?)`,
            [
              view.snowflake_id || generateSnowflake(),
              pageId,
              view.day,
              view.views,
            ],
          );
        }
      }
      await savePageFts({
        id: pageId,
        title: restoredTitle,
        content: trashed.content || "",
        slug_id: trashed.slug_id,
        tags: tags.join(" "),
      });
    }

    await run(`DELETE FROM deleted_pages WHERE id = ?`, [trashed.id]);
    await run("COMMIT");
  } catch (error) {
    await run("ROLLBACK");
    console.error("Failed to restore page from trash", error);
    pushNotification(req, {
      type: "error",
      message: "La restauration a échoué. Merci de réessayer.",
    });
    return res.redirect("/admin/trash");
  }

  await sendAdminEvent("Page restored", {
    user: req.session.user?.username,
    page: {
      title: restoredTitle,
      slug_id: trashed.slug_id,
      snowflake_id: snowflake,
    },
    extra: {
      restored_from: trashed.snowflake_id,
    },
  });

  pushNotification(req, {
    type: "success",
    message: `${restoredLabel} a été restaurée.`,
  });

  res.redirect(`/wiki/${trashed.slug_id}`);
  },
);

r.post(
  "/trash/:id/delete",
  requirePermission(["can_manage_trash", "can_purge_trash"]),
  async (req, res) => {
  const trashed = await get(
    `SELECT id, title, slug_id FROM deleted_pages WHERE snowflake_id = ?`,
    [req.params.id],
  );

  if (!trashed) {
    pushNotification(req, {
      type: "error",
      message: "Élément introuvable dans la corbeille.",
    });
    return res.redirect("/admin/trash");
  }

  await run(`DELETE FROM deleted_pages WHERE id = ?`, [trashed.id]);

  await sendAdminEvent("Page purged", {
    user: req.session.user?.username,
    page: {
      title: trashed.title,
      slug_id: trashed.slug_id,
    },
    extra: {
      action: "permanent_delete",
    },
  });

  pushNotification(req, {
    type: "success",
    message: `« ${trashed.title || trashed.slug_id} » a été supprimée définitivement.`,
  });

  res.redirect("/admin/trash");
  },
);

r.post(
  "/trash/empty",
  requirePermission(["can_manage_trash", "can_purge_trash"]),
  async (req, res) => {
  const totalRow = await get("SELECT COUNT(*) AS total FROM deleted_pages");
  const total = Number(totalRow?.total || 0);

  if (!total) {
    pushNotification(req, {
      type: "info",
      message: "La corbeille est déjà vide.",
    });
    return res.redirect("/admin/trash");
  }

  const result = await run("DELETE FROM deleted_pages");

  await sendAdminEvent("Trash emptied", {
    user: req.session.user?.username,
    extra: {
      removed: result?.changes || total,
    },
  });

  pushNotification(req, {
    type: "success",
    message: `Corbeille vidée (${result?.changes || total} élément(s)).`,
  });

  res.redirect("/admin/trash");
  },
);

r.get(
  "/snowflakes",
  requirePermission(["can_view_snowflakes", "can_lookup_snowflake_history"]),
  (req, res) => {
  const queryId = typeof req.query.id === "string" ? req.query.id.trim() : "";
  let decoded = null;
  let error = null;
  const now = Date.now();
  const nowDate = new Date(now);
  const nowInfo = {
    iso: nowDate.toISOString(),
    localized: formatDateTimeLocalized(nowDate),
  };

  if (queryId) {
    const details = decomposeSnowflake(queryId, { now });
    if (!details) {
      error =
        "Impossible de décoder cet identifiant. Vérifiez qu’il s’agit bien d’un snowflake valide.";
    } else {
      const createdAt = new Date(details.timestamp.milliseconds);
      decoded = {
        ...details,
        createdAtLocalized: formatDateTimeLocalized(createdAt),
        createdAtUnixSeconds: Math.floor(details.timestamp.milliseconds / 1000),
        relativeAge: formatRelativeDurationMs(details.ageMs),
        absoluteAgeSeconds: Math.round(Math.abs(details.ageMs) / 1000),
        isFuture: details.ageMs < 0,
      };
    }
  }

  res.render("admin/snowflakes", {
    title: "Décodeur de snowflakes",
    queryId,
    decoded,
    error,
    now: nowInfo,
    epoch: {
      ms: SNOWFLAKE_EPOCH_MS,
      iso: new Date(SNOWFLAKE_EPOCH_MS).toISOString(),
      localized: formatDateTimeLocalized(new Date(SNOWFLAKE_EPOCH_MS)),
    },
    structure: SNOWFLAKE_STRUCTURE,
  });
  },
);

r.get(
  "/events",
  requirePermission(["can_view_events", "can_view_event_log"]),
  async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(COALESCE(snowflake_id,'') LIKE ? OR CAST(id AS TEXT) LIKE ? OR COALESCE(channel,'') LIKE ? OR COALESCE(type,'') LIKE ? OR COALESCE(username,'') LIKE ? OR COALESCE(ip,'') LIKE ? OR COALESCE(payload,'') LIKE ?)",
    );
    params.push(like, like, like, like, like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const totalRow = await get(
    `SELECT COUNT(*) AS total FROM event_logs ${where}`,
    params,
  );
  const totalEvents = Number(totalRow?.total ?? 0);
  const basePagination = buildPagination(req, totalEvents);
  const offset = (basePagination.page - 1) * basePagination.perPage;
  const events = await all(
    `SELECT snowflake_id, id, channel, type, payload, ip, username, created_at
       FROM event_logs
       ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, basePagination.perPage, offset],
  );
  const eventHandleMap = await resolveHandleColors(
    events.map((event) => event.username),
  );
  const decoratedEvents = events.map((event) => ({
    ...event,
    userRole: getHandleColor(event.username, eventHandleMap),
  }));
  const pagination = decoratePagination(req, basePagination);

  res.render("admin/events", {
    events: decoratedEvents,
    pagination,
    searchTerm,
  });
  },
);

export default r;

function parseTagsJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return Array.from(
      new Set(
        parsed
          .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
          .filter(Boolean),
      ),
    );
  } catch (_error) {
    return [];
  }
}

function parseCommentsJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((comment) => {
        if (!comment || typeof comment !== "object") {
          return null;
        }
        const body = typeof comment.body === "string" ? comment.body : "";
        const providedSnowflake =
          typeof comment.snowflake_id === "string"
            ? comment.snowflake_id.trim()
            : "";
        const legacyId =
          typeof comment.id === "string" || typeof comment.id === "number"
            ? String(comment.id).trim()
            : "";
        const snowflakeId = providedSnowflake || legacyId;
        const status =
          typeof comment.status === "string" &&
          ["pending", "approved", "rejected"].includes(comment.status)
            ? comment.status
            : "pending";
        return {
          snowflake_id: snowflakeId || generateSnowflake(),
          author: typeof comment.author === "string" ? comment.author : null,
          body,
          created_at:
            typeof comment.created_at === "string" ? comment.created_at : null,
          updated_at:
            typeof comment.updated_at === "string" ? comment.updated_at : null,
          ip: typeof comment.ip === "string" ? comment.ip : null,
          edit_token:
            typeof comment.edit_token === "string" ? comment.edit_token : null,
          status,
          author_is_admin: comment.author_is_admin ? 1 : 0,
        };
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function parseStatsJson(value) {
  const empty = { likes: [], viewEvents: [], viewDaily: [] };
  if (!value) {
    return empty;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return empty;
    }
    const likes = Array.isArray(parsed.likes)
      ? parsed.likes
          .map((like) => {
            if (!like || typeof like !== "object") {
              return null;
            }
            return {
              snowflake_id:
                typeof like.snowflake_id === "string" && like.snowflake_id
                  ? like.snowflake_id
                  : null,
              ip: typeof like.ip === "string" ? like.ip : null,
              created_at:
                typeof like.created_at === "string" ? like.created_at : null,
            };
          })
          .filter(Boolean)
      : [];
    const viewEvents = Array.isArray(parsed.viewEvents)
      ? parsed.viewEvents
          .map((view) => {
            if (!view || typeof view !== "object") {
              return null;
            }
            return {
              snowflake_id:
                typeof view.snowflake_id === "string" && view.snowflake_id
                  ? view.snowflake_id
                  : null,
              ip: typeof view.ip === "string" ? view.ip : null,
              viewed_at:
                typeof view.viewed_at === "string" ? view.viewed_at : null,
            };
          })
          .filter(Boolean)
      : [];
    const viewDaily = Array.isArray(parsed.viewDaily)
      ? parsed.viewDaily
          .map((view) => {
            if (!view || typeof view !== "object") {
              return null;
            }
            const day = typeof view.day === "string" ? view.day : null;
            if (!day) {
              return null;
            }
            const views = Number(view.views);
            return {
              snowflake_id:
                typeof view.snowflake_id === "string" && view.snowflake_id
                  ? view.snowflake_id
                  : null,
              day,
              views:
                Number.isFinite(views) && views > 0 ? Math.floor(views) : 0,
            };
          })
          .filter(Boolean)
      : [];
    return { likes, viewEvents, viewDaily };
  } catch (_error) {
    return empty;
  }
}

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
