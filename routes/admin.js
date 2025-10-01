import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { all, get, run, randId, savePageFts } from "../db.js";
import {
  generateSnowflake,
  decomposeSnowflake,
  SNOWFLAKE_EPOCH_MS,
  SNOWFLAKE_STRUCTURE,
} from "../utils/snowflake.js";
import { slugify, linkifyInternal } from "../utils/linkify.js";
import { sendAdminEvent, sendFeedEvent } from "../utils/webhook.js";
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
import { banIp, liftBan, getBan, deleteBan } from "../utils/ipBans.js";
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
} from "../utils/ipProfiles.js";
import { getClientIp } from "../utils/ip.js";
import {
  formatDateTimeLocalized,
  formatRelativeDurationMs,
  formatSecondsAgo,
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
  listRoles,
  listRolesWithUsage,
  getRoleById,
  createRole,
  updateRolePermissions,
  assignRoleToUser,
  deleteRole,
  reassignUsersToRole,
  getEveryoneRole,
} from "../utils/roleService.js";
import { buildSessionUser } from "../utils/roleFlags.js";
import {
  countBanAppeals,
  fetchBanAppeals,
  getBanAppealBySnowflake,
  resolveBanAppeal,
  deleteBanAppeal,
} from "../utils/banAppeals.js";
import {
  getActiveVisitors,
  ACTIVE_VISITOR_TTL_MS,
} from "../utils/liveStats.js";

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

const MODERATOR_ALLOWED_PREFIXES = ["/comments", "/submissions"];

function isModeratorAllowedPath(pathname = "") {
  return MODERATOR_ALLOWED_PREFIXES.some((prefix) => {
    if (!pathname) return false;
    if (pathname === prefix) {
      return true;
    }
    return pathname.startsWith(`${prefix}/`);
  });
}

r.use((req, res, next) => {
  const user = req.session.user;
  if (!user) {
    return res.redirect("/login");
  }
  const isAdmin = Boolean(user.is_admin);
  const isModerator = Boolean(user.is_moderator);
  if (isAdmin) {
    res.locals.isModeratorUser = isModerator;
    return next();
  }
  if (isModerator && isModeratorAllowedPath(req.path || "")) {
    res.locals.isModeratorUser = true;
    return next();
  }
  return res.redirect("/login");
});

const LIVE_VISITOR_PAGE_SIZES = [5, 10, 25, 50];
const LIVE_VISITOR_DEFAULT_PAGE_SIZE = 10;
const LIVE_VISITOR_PAGINATION_OPTIONS = {
  pageParam: "livePage",
  perPageParam: "livePerPage",
  defaultPageSize: LIVE_VISITOR_DEFAULT_PAGE_SIZE,
  pageSizeOptions: LIVE_VISITOR_PAGE_SIZES,
};

function serializeLiveVisitors(now = Date.now()) {
  return getActiveVisitors({ now }).map((visitor) => {
    const secondsAgo = Math.max(0, Math.round((now - visitor.lastSeen) / 1000));
    return {
      ...visitor,
      lastSeenIso: new Date(visitor.lastSeen).toISOString(),
      lastSeenSecondsAgo: secondsAgo,
      lastSeenRelative: formatSecondsAgo(secondsAgo),
    };
  });
}

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

r.get("/comments", async (req, res) => {
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
  const pendingPagination = decoratePagination(
    req,
    pendingBase,
    { pageParam: "pendingPage", perPageParam: "pendingPerPage" },
  );

  const recentFilters = buildFilters("c.status<>'pending'");
  const recentCountRow = await get(
    `SELECT COUNT(*) AS total
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE ${recentFilters.where}`,
    recentFilters.params,
  );
  const recentBase = buildPagination(
    req,
    Number(recentCountRow?.total ?? 0),
    { pageParam: "recentPage", perPageParam: "recentPerPage" },
  );
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
  const recentPagination = decoratePagination(
    req,
    recentBase,
    { pageParam: "recentPage", perPageParam: "recentPerPage" },
  );

  res.render("admin/comments", {
    pending,
    recent,
    pendingPagination,
    recentPagination,
    searchTerm,
  });
});

r.post("/comments/:id/approve", async (req, res) => {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return redirectToComments(req, res);
  }
  if (comment.status === "approved") {
    pushNotification(req, {
      type: "info",
      message: "Ce commentaire est déjà approuvé.",
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
      message: "Impossible d'approuver ce commentaire.",
    });
    return redirectToComments(req, res);
  }
  comment.status = "approved";
  pushNotification(req, {
    type: "success",
    message: "Commentaire approuvé.",
  });
  await sendAdminEvent("Commentaire approuvé", {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
});

r.post("/comments/:id/reject", async (req, res) => {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return redirectToComments(req, res);
  }
  if (comment.status === "rejected") {
    pushNotification(req, {
      type: "info",
      message: "Ce commentaire est déjà rejeté.",
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
      message: "Impossible de rejeter ce commentaire.",
    });
    return redirectToComments(req, res);
  }
  comment.status = "rejected";
  pushNotification(req, {
    type: "info",
    message: "Commentaire rejeté.",
  });
  await sendAdminEvent("Commentaire rejeté", {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
});

async function handleCommentDeletion(req, res) {
  const { comment } = await fetchModeratableComment(req.params.id);
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return redirectToComments(req, res);
  }
  const result = await run("DELETE FROM comments WHERE id=?", [comment.id]);
  if (!result?.changes) {
    pushNotification(req, {
      type: "error",
      message: "Impossible de supprimer ce commentaire.",
    });
    return redirectToComments(req, res);
  }
  comment.status = "deleted";
  pushNotification(req, {
    type: "success",
    message: "Commentaire supprimé.",
  });
  await sendAdminEvent("Commentaire supprimé", {
    page: buildCommentPageSummary(comment),
    comment: buildCommentSummary(comment),
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  return redirectToComments(req, res);
}

r.delete("/comments/:id", handleCommentDeletion);
r.post("/comments/:id/delete", handleCommentDeletion);

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

  if (!comment && numericIdentifier !== null && Number.isSafeInteger(numericIdentifier)) {
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

r.get("/ban-appeals", async (req, res) => {
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
});

r.post("/ban-appeals/:id/accept", async (req, res) => {
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
});

r.post("/ban-appeals/:id/reject", async (req, res) => {
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
});

r.post("/ban-appeals/:id/delete", async (req, res) => {
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
});

r.get("/ip-bans", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const like = searchTerm ? `%${searchTerm}%` : null;

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
  const activeBase = buildPagination(
    req,
    Number(activeCountRow?.total ?? 0),
    { pageParam: "activePage", perPageParam: "activePerPage" },
  );
  const activeOffset = (activeBase.page - 1) * activeBase.perPage;
  const activeBans = await all(
    `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      WHERE ${activeFilters.where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    [...activeFilters.params, activeBase.perPage, activeOffset],
  );
  const activePagination = decoratePagination(
    req,
    activeBase,
    { pageParam: "activePage", perPageParam: "activePerPage" },
  );

  const liftedFilters = buildFilters("lifted_at IS NOT NULL");
  const liftedCountRow = await get(
    `SELECT COUNT(*) AS total FROM ip_bans WHERE ${liftedFilters.where}`,
    liftedFilters.params,
  );
  const liftedBase = buildPagination(
    req,
    Number(liftedCountRow?.total ?? 0),
    { pageParam: "liftedPage", perPageParam: "liftedPerPage" },
  );
  const liftedOffset = (liftedBase.page - 1) * liftedBase.perPage;
  const liftedBans = await all(
    `SELECT snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      WHERE ${liftedFilters.where}
      ORDER BY lifted_at DESC
      LIMIT ? OFFSET ?`,
    [...liftedFilters.params, liftedBase.perPage, liftedOffset],
  );
  const liftedPagination = decoratePagination(
    req,
    liftedBase,
    { pageParam: "liftedPage", perPageParam: "liftedPerPage" },
  );

  res.render("admin/ip_bans", {
    activeBans,
    liftedBans,
    activePagination,
    liftedPagination,
    searchTerm,
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
});

r.post("/ip-bans/:id/delete", async (req, res) => {
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
});

r.get("/ip-reputation", async (req, res) => {
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
    listIpProfilesForReview({ limit: reviewBase.perPage, offset: reviewOffset }),
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

  const refreshIntervalHours = Math.round(
    (IP_REPUTATION_REFRESH_INTERVAL_MS / (60 * 60 * 1000)) * 10,
  ) / 10;
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
});

r.post("/ip-reputation/manual-check", async (req, res) => {
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
});

r.post("/ip-reputation/:hash/mark-safe", async (req, res) => {
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
});

r.post("/ip-reputation/:hash/clear-safe", async (req, res) => {
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
});

r.post("/ip-reputation/:hash/recheck", async (req, res) => {
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
});

r.post("/ip-reputation/:hash/ban", async (req, res) => {
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
  const reason = ((req.body.reason || reasonBase) || "")
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
});

r.get("/ip-profiles", async (req, res) => {
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
  const pagination = decoratePagination(
    req,
    paginationBase,
    paginationOptions,
  );

  res.render("admin/ip_profiles", {
    profiles,
    searchTerm,
    pagination,
  });
});

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
r.post("/ip-profiles/:hash/delete", handleIpProfileDeletion);

r.get("/submissions", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const search = searchTerm || null;

  const pendingTotal = await countPageSubmissions({
    status: "pending",
    search,
  });
  const pendingBase = buildPagination(
    req,
    pendingTotal,
    { pageParam: "pendingPage", perPageParam: "pendingPerPage" },
  );
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
  const pendingPagination = decoratePagination(
    req,
    pendingBase,
    { pageParam: "pendingPage", perPageParam: "pendingPerPage" },
  );

  const recentTotal = await countPageSubmissions({
    status: ["approved", "rejected"],
    search,
  });
  const recentBase = buildPagination(
    req,
    recentTotal,
    { pageParam: "recentPage", perPageParam: "recentPerPage" },
  );
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
  const recentPagination = decoratePagination(
    req,
    recentBase,
    { pageParam: "recentPage", perPageParam: "recentPerPage" },
  );

  res.render("admin/submissions", {
    pending,
    recent,
    pendingPagination,
    recentPagination,
    searchTerm,
  });
});

r.get("/submissions/:id", async (req, res) => {
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
    targetPage = await get(
      "SELECT id, title, content FROM pages WHERE id=?",
      [submission.page_id],
    );
  }
  if (!targetPage && submission.current_slug) {
    targetPage = await get(
      "SELECT id, title, content FROM pages WHERE slug_id=?",
      [submission.current_slug],
    );
  }

  const proposedTags = mapSubmissionTags(submission);
  const currentTags = targetPage ? await fetchPageTags(targetPage.id) : [];
  const proposedHtml = linkifyInternal(submission.content || "");
  const currentHtml = targetPage ? linkifyInternal(targetPage.content || "") : null;

  res.render("admin/submission_detail", {
    submission,
    proposedTags,
    currentTags,
    proposedHtml,
    currentHtml,
  });
});

r.post("/submissions/:id/approve", async (req, res) => {
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
        "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content) VALUES(?,?,?,?,?)",
        [pageSnowflake, base, slugId, submission.title, submission.content],
      );
      const pageId = insertResult?.lastID;
      if (!pageId) {
        throw new Error("Impossible de créer la page");
      }
      const tagNames = await upsertTags(pageId, submission.tags || "");
      await recordRevision(pageId, submission.title, submission.content, reviewerId);
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
      const pageUrl = req.protocol + "://" + req.get("host") + "/wiki/" + slugId;
      await sendAdminEvent("Contribution approuvée", {
        page: { title: submission.title, slug_id: slugId, snowflake_id: pageSnowflake },
        user: req.session.user?.username || null,
        extra: {
          submission: submission.snowflake_id,
          ip: submission.ip || null,
          type: submission.type,
        },
      });
      await sendFeedEvent(
        "Nouvel article",
        {
          page: { title: submission.title, slug_id: slugId, snowflake_id: pageSnowflake },
          author: submission.submitted_by || null,
          url: pageUrl,
          tags: submission.tags,
        },
        { articleContent: submission.content },
      );
    } else {
      const page = submission.page_id
        ? await get("SELECT * FROM pages WHERE id=?", [submission.page_id])
        : submission.current_slug
          ? await get("SELECT * FROM pages WHERE slug_id=?", [submission.current_slug])
          : null;
      if (!page) {
        throw new Error("Page cible introuvable");
      }
      await recordRevision(page.id, page.title, page.content, reviewerId);
      const base = slugify(submission.title);
      await run(
        "UPDATE pages SET title=?, content=?, slug_base=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        [submission.title, submission.content, base, page.id],
      );
      await run("DELETE FROM page_tags WHERE page_id=?", [page.id]);
      const tagNames = await upsertTags(page.id, submission.tags || "");
      await recordRevision(page.id, submission.title, submission.content, reviewerId);
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
});

r.post("/submissions/:id/reject", async (req, res) => {
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
  res.render("admin/pages", {
    stats: {
      count: countRow?.c || 0,
      latest,
    },
  });
});

r.get("/stats", async (req, res) => {
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
  topLikedPagination = decoratePagination(req, topLikedPagination, topLikedOptions);

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
  const eventCount = await get("SELECT COUNT(*) AS count FROM event_logs");

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
    viewTrends,
  ] = await Promise.all([
    get("SELECT COUNT(*) AS total FROM pages"),
    get(
      "SELECT COUNT(*) AS total FROM pages WHERE created_at >= datetime('now','-7 day')",
    ),
    get("SELECT COUNT(*) AS total FROM deleted_pages"),
    get(
      "SELECT COUNT(*) AS total FROM page_submissions WHERE status='pending'",
    ),
    get("SELECT COUNT(*) AS total FROM uploads"),
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
    all(
      `SELECT day, SUM(views) AS views
         FROM page_view_daily
        WHERE day >= date('now','-13 day')
        GROUP BY day
        ORDER BY day DESC
        LIMIT 14`,
    ),
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

  const engagementHighlights = [
    {
      icon: "📄",
      label: "Articles publiés",
      value: totalPages,
      secondary: `${newPagesCount} cette semaine`,
    },
    {
      icon: "🗑️",
      label: "Pages dans la corbeille",
      value: deletedPagesCount,
      secondary: "Prêtes à être purgées",
    },
    {
      icon: "⏳",
      label: "Soumissions en attente",
      value: pendingSubmissionsCount,
      secondary: "À modérer",
    },
    {
      icon: "📦",
      label: "Fichiers envoyés",
      value: totalUploadsCount,
      secondary: `${newUploadsCount} cette semaine`,
    },
    {
      icon: "👀",
      label: "Vues (7 j)",
      value: newViewsCount,
      secondary: `${avgViewsPerPage} vues moy./page`,
    },
    {
      icon: "💬",
      label: "Commentaires (7 j)",
      value: newCommentsCount,
      secondary: `${newLikesCount} likes (7 j)`,
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
      events: eventCount?.count || 0,
      uniqueIps: uniqueIps?.total || 0,
    },
    avgViewsPerPage,
    engagementHighlights,
    topLikedPages,
    topLikedPagination,
    topCommenters,
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
    recentEvents,
    viewTrends,
    liveVisitors,
    liveVisitorsPagination,
    liveVisitorsWindowSeconds,
  });
});

r.get("/stats/live", (req, res) => {
  const now = Date.now();
  const allLiveVisitors = serializeLiveVisitors(now);
  const windowSeconds = Math.round(ACTIVE_VISITOR_TTL_MS / 1000);
  const pagination = buildPagination(
    req,
    allLiveVisitors.length,
    LIVE_VISITOR_PAGINATION_OPTIONS,
  );
  const offset = (pagination.page - 1) * pagination.perPage;
  const visitors = allLiveVisitors.slice(
    offset,
    offset + pagination.perPage,
  );

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
});

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

r.get("/uploads", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const normalizedSearch = searchTerm.toLowerCase();
  const uploadsList = await listUploads();
  const ordered = [...uploadsList].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
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

  res.render("admin/uploads", { uploads, pagination, searchTerm });
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
});

// roles
r.get("/roles", async (_req, res) => {
  const roles = await listRolesWithUsage();
  res.render("admin/roles", { roles });
});
r.post("/roles", async (req, res) => {
  const { name, description } = req.body;
  const permissions = {
    is_admin: req.body.is_admin,
    is_moderator: req.body.is_moderator,
    is_helper: req.body.is_helper,
    is_contributor: req.body.is_contributor,
    can_comment: req.body.can_comment,
    can_submit_pages: req.body.can_submit_pages,
  };
  try {
    const role = await createRole({ name, description, permissions });
    const ip = getClientIp(req);
    await sendAdminEvent(
      "Rôle créé",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          roleId: role.id,
          roleName: role.name,
          permissions: {
            is_admin: role.is_admin,
            is_moderator: role.is_moderator,
            is_helper: role.is_helper,
            is_contributor: role.is_contributor,
            can_comment: role.can_comment,
            can_submit_pages: role.can_submit_pages,
          },
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Rôle ${role.name} créé avec succès.`,
    });
  } catch (error) {
    console.error("Failed to create role", error);
    pushNotification(req, {
      type: "error",
      message:
        error?.message?.includes("UNIQUE")
          ? "Ce nom de rôle existe déjà."
          : "Impossible de créer le rôle. Merci de réessayer.",
    });
  }
  res.redirect("/admin/roles");
});
r.post("/roles/:id", async (req, res) => {
  const roleId = Number.parseInt(req.params.id, 10);
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
    if (existing.is_system || existing.name?.toLowerCase() === "everyone") {
      pushNotification(req, {
        type: "error",
        message: "Ce rôle ne peut pas être supprimé.",
      });
      return res.redirect("/admin/roles");
    }
    try {
      await deleteRole(roleId);
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Rôle supprimé",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            roleId,
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
    if (existing.name?.toLowerCase() === "everyone") {
      pushNotification(req, {
        type: "error",
        message: "Ce rôle est déjà Everyone.",
      });
      return res.redirect("/admin/roles");
    }
    try {
      const everyoneRole = await getEveryoneRole();
      if (!everyoneRole) {
        throw new Error("Rôle Everyone introuvable.");
      }
      const { moved } = await reassignUsersToRole(roleId, everyoneRole);
      const ip = getClientIp(req);
      await sendAdminEvent(
        "Utilisateurs réassignés vers Everyone",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            sourceRoleId: roleId,
            sourceRoleName: existing.name,
            targetRoleId: everyoneRole.id,
            targetRoleName: everyoneRole.name,
            movedUsers: moved,
          },
        },
        { includeScreenshot: false },
      );
      if (moved > 0) {
        pushNotification(req, {
          type: "success",
          message: `${moved} utilisateur${moved > 1 ? "s" : ""} déplacé${
            moved > 1 ? "s" : ""
          } vers Everyone.`,
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
          "Impossible de réassigner les utilisateurs vers Everyone.",
      });
    }
    return res.redirect("/admin/roles");
  }
  const permissions = {
    is_admin: req.body.is_admin,
    is_moderator: req.body.is_moderator,
    is_helper: req.body.is_helper,
    is_contributor: req.body.is_contributor,
    can_comment: req.body.can_comment,
    can_submit_pages: req.body.can_submit_pages,
  };
  try {
    const updated = await updateRolePermissions(roleId, { permissions });
    const ip = getClientIp(req);
    await sendAdminEvent(
      "Permissions de rôle mises à jour",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          roleId: updated?.id || roleId,
          roleName: updated?.name || existing.name,
          previousPermissions: {
            is_admin: existing.is_admin,
            is_moderator: existing.is_moderator,
            is_helper: existing.is_helper,
            is_contributor: existing.is_contributor,
            can_comment: existing.can_comment,
            can_submit_pages: existing.can_submit_pages,
          },
          newPermissions: {
            is_admin: updated?.is_admin ?? existing.is_admin,
            is_moderator: updated?.is_moderator ?? existing.is_moderator,
            is_helper: updated?.is_helper ?? existing.is_helper,
            is_contributor: updated?.is_contributor ?? existing.is_contributor,
            can_comment: updated?.can_comment ?? existing.can_comment,
            can_submit_pages:
              updated?.can_submit_pages ?? existing.can_submit_pages,
          },
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Permissions mises à jour pour ${updated?.name || existing.name}.`,
    });
  } catch (error) {
    console.error("Failed to update role", error);
    pushNotification(req, {
      type: "error",
      message: "Impossible de mettre à jour les permissions du rôle.",
    });
  }
  res.redirect("/admin/roles");
});

// users
r.get("/users", async (req, res) => {
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
  const basePagination = buildPagination(
    req,
    Number(totalRow?.total ?? 0),
  );
  const offset = (basePagination.page - 1) * basePagination.perPage;

  const users = await all(
    `SELECT u.id, u.username, u.display_name, u.is_admin, u.is_moderator, u.is_helper, u.is_contributor, u.can_comment, u.can_submit_pages, u.role_id, r.name AS role_name
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ${where}
     ORDER BY u.id
     LIMIT ? OFFSET ?`,
    [...params, basePagination.perPage, offset],
  );
  const availableRoles = await listRoles();
  const defaultRole =
    availableRoles.find((role) => role.name === "Utilisateur") ||
    availableRoles.find(
      (role) =>
        !role.is_admin &&
        !role.is_moderator &&
        !role.is_helper &&
        !role.is_contributor,
    ) || null;
  const normalizedUsers = users.map((user) => {
    const isAdmin = Boolean(user.is_admin);
    const isModerator = Boolean(user.is_moderator);
    const isContributor = Boolean(user.is_contributor);
    const isHelper = Boolean(user.is_helper);
    const canComment = Boolean(user.can_comment);
    const canSubmit = Boolean(user.can_submit_pages);
    const roleLabel =
      user.role_name ||
      (isAdmin
        ? "Administrateur"
        : isModerator
        ? "Modérateur"
        : isContributor
        ? "Contributeur"
        : isHelper
        ? "Helper"
        : canSubmit
        ? "Contributeur" // fallback label for legacy display
        : "Utilisateur");
    return {
      ...user,
      is_admin: isAdmin,
      is_moderator: isModerator,
      is_contributor: isContributor,
      is_helper: isHelper,
      can_comment: canComment,
      can_submit_pages: canSubmit,
      role_label: roleLabel,
    };
  });
  const pagination = decoratePagination(req, basePagination);
  res.render("admin/users", {
    users: normalizedUsers,
    pagination,
    searchTerm,
    roles: availableRoles,
    defaultRoleId: defaultRole?.id || null,
  });
});
r.post("/users", async (req, res) => {
  const { username, password } = req.body;
  const selectedRoleId = Number.parseInt(req.body.roleId || req.body.role || "", 10);
  if (!username || !password) {
    pushNotification(req, {
      type: "error",
      message: "Nom d'utilisateur et mot de passe requis.",
    });
    return res.redirect("/admin/users");
  }
  const sanitizedUsername = username.trim();
  const role = await getRoleById(selectedRoleId);
  if (!role) {
    pushNotification(req, {
      type: "error",
      message: "Rôle invalide sélectionné.",
    });
    return res.redirect("/admin/users");
  }
  const hashed = await hashPassword(password);
  try {
    const result = await run(
      "INSERT INTO users(snowflake_id, username, password, role_id, is_admin, is_moderator, is_helper, is_contributor, can_comment, can_submit_pages) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        generateSnowflake(),
        sanitizedUsername,
        hashed,
        role.id,
        role.is_admin ? 1 : 0,
        role.is_moderator ? 1 : 0,
        role.is_helper ? 1 : 0,
        role.is_contributor ? 1 : 0,
        role.can_comment ? 1 : 0,
        role.can_submit_pages ? 1 : 0,
      ],
    );
    const ip = getClientIp(req);
    await sendAdminEvent(
      "Utilisateur créé",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          newUser: sanitizedUsername,
          userId: result?.lastID || null,
          roleId: role.id,
          roleName: role.name,
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Utilisateur ${sanitizedUsername} créé (${role.name}).`,
    });
  } catch (error) {
    if (error?.code === "SQLITE_CONSTRAINT" || error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
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
});
r.post("/users/:id/display-name", async (req, res) => {
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
});
r.post("/users/:id/role", async (req, res) => {
  const target = await get(
    `SELECT u.id, u.username, u.role_id, u.is_admin, u.is_moderator, u.is_helper, u.is_contributor, r.name AS role_name
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

  const requestedRoleId = Number.parseInt(req.body?.roleId || req.body?.role || "", 10);
  const role = await getRoleById(requestedRoleId);

  if (!role) {
    pushNotification(req, {
      type: "error",
      message: "Rôle invalide sélectionné.",
    });
    return res.redirect("/admin/users");
  }

  const previousRole = target.role_name || (target.is_admin
    ? "Administrateur"
    : target.is_moderator
    ? "Modérateur"
    : target.is_contributor
    ? "Contributeur"
    : target.is_helper
    ? "Helper"
    : "Utilisateur");

  if (target.role_id === role.id) {
    pushNotification(req, {
      type: "info",
      message: `Aucun changement pour ${target.username}.`,
    });
    return res.redirect("/admin/users");
  }

  await assignRoleToUser(target.id, role);

  if (req.session.user?.id === target.id) {
    const updatedSession = buildSessionUser(
      {
        ...req.session.user,
        ...target,
        role_id: role.id,
        role_name: role.name,
        is_admin: role.is_admin,
        is_moderator: role.is_moderator,
        is_helper: role.is_helper,
        is_contributor: role.is_contributor,
        can_comment: role.can_comment,
        can_submit_pages: role.can_submit_pages,
      },
      role,
    );
    req.session.user = { ...req.session.user, ...updatedSession };
  }

  const ip = getClientIp(req);
  await sendAdminEvent(
    "Rôle utilisateur mis à jour",
    {
      user: req.session.user?.username || null,
      extra: {
        ip,
        targetId: target.id,
        targetUsername: target.username,
        previousRole,
        newRoleId: role.id,
        newRoleName: role.name,
      },
    },
    { includeScreenshot: false },
  );

  pushNotification(req, {
    type: "success",
    message: `Rôle mis à jour pour ${target.username} (${role.name}).`,
  });

  res.redirect("/admin/users");
});
r.post("/users/:id/delete", async (req, res) => {
  const target = await get(
    "SELECT id, username, display_name FROM users WHERE id=?",
    [
      req.params.id,
    ],
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
});

// likes table improved
r.get("/likes", async (req, res) => {
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

r.get("/trash", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(COALESCE(title,'') LIKE ? OR COALESCE(slug_id,'') LIKE ? OR COALESCE(deleted_by,'') LIKE ?)",
    );
    params.push(like, like, like);
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
    `SELECT id, snowflake_id, slug_id, slug_base, title, deleted_at, deleted_by, created_at, updated_at, tags_json
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
});

r.post("/trash/:id/restore", async (req, res) => {
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

  const slugConflict = await get(
    `SELECT id FROM pages WHERE slug_id = ?`,
    [trashed.slug_id],
  );
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
      `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?)`,
      [
        snowflake,
        trashed.slug_base,
        trashed.slug_id,
        restoredTitle,
        trashed.content || "",
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
});

r.post("/trash/:id/delete", async (req, res) => {
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
});

r.post("/trash/empty", async (req, res) => {
  const totalRow = await get(
    "SELECT COUNT(*) AS total FROM deleted_pages",
  );
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
});

r.get("/snowflakes", (req, res) => {
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
});

r.get("/events", async (req, res) => {
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
  const pagination = decoratePagination(req, basePagination);

  res.render("admin/events", {
    events,
    pagination,
    searchTerm,
  });
});

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
              views: Number.isFinite(views) && views > 0 ? Math.floor(views) : 0,
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
