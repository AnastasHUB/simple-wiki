import fs from "fs/promises";
import { Router } from "express";
import multer from "multer";
import path from "path";
import { randomUUID } from "crypto";
import { requireAdmin } from "../middleware/auth.js";
import { all, get, run, randSlugId, savePageFts } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
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
  listIpProfilesForReview,
  fetchRecentlyClearedProfiles,
  markIpProfileSafe,
  markIpProfileBanned,
  refreshIpReputationByHash,
  getRawIpProfileByHash,
  IP_REPUTATION_REFRESH_INTERVAL_MS,
  formatIpProfileLabel,
  touchIpProfile,
  deleteIpProfileByHash,
} from "../utils/ipProfiles.js";
import { getClientIp } from "../utils/ip.js";
import { buildPagination, decoratePagination } from "../utils/pagination.js";
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
  invalidateSiteSettingsCache,
} from "../utils/settingsService.js";
import { pushNotification } from "../utils/notifications.js";
import {
  countBanAppeals,
  fetchBanAppeals,
  getBanAppealBySnowflake,
  resolveBanAppeal,
  deleteBanAppeal,
} from "../utils/banAppeals.js";

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
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.status, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("UPDATE comments SET status='approved' WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "success",
    message: "Commentaire approuvé.",
  });
  await sendAdminEvent("Commentaire approuvé", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
});

r.post("/comments/:id/reject", async (req, res) => {
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.status, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("UPDATE comments SET status='rejected' WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "info",
    message: "Commentaire rejeté.",
  });
  await sendAdminEvent("Commentaire rejeté", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
});

async function handleCommentDeletion(req, res) {
  const comment = await get(
    `SELECT c.id, c.snowflake_id, c.ip, p.title, p.slug_id
       FROM comments c
       JOIN pages p ON p.id = c.page_id
      WHERE c.snowflake_id=?`,
    [req.params.id],
  );
  if (!comment) {
    pushNotification(req, {
      type: "error",
      message: "Commentaire introuvable.",
    });
    return res.redirect("/admin/comments");
  }
  await run("DELETE FROM comments WHERE id=?", [comment.id]);
  pushNotification(req, {
    type: "success",
    message: "Commentaire supprimé.",
  });
  await sendAdminEvent("Commentaire supprimé", {
    page: comment,
    extra: { ip: comment.ip, commentId: comment.snowflake_id },
  });
  res.redirect("/admin/comments");
}

r.delete("/comments/:id", handleCommentDeletion);
r.post("/comments/:id/delete", handleCommentDeletion);

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
  const [suspicious, cleared] = await Promise.all([
    listIpProfilesForReview({ limit: 100 }),
    fetchRecentlyClearedProfiles({ limit: 8 }),
  ]);
  const refreshIntervalHours = Math.round(
    (IP_REPUTATION_REFRESH_INTERVAL_MS / (60 * 60 * 1000)) * 10,
  ) / 10;
  res.render("admin/ip_reputation", {
    suspicious,
    cleared,
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
    const profile = await touchIpProfile(rawIp);
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
    defaultPageSize: 25,
    pageSizeOptions: [10, 25, 50, 100],
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
      const slugId = randSlugId(base);
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
    defaultPageSize: 15,
    pageSizeOptions: [10, 15, 25, 50, 100],
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
    defaultPageSize: 15,
    pageSizeOptions: [10, 15, 25, 50, 100],
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
    defaultPageSize: 15,
    pageSizeOptions: [10, 15, 25, 50, 100],
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
    defaultPageSize: 20,
    pageSizeOptions: [10, 20, 50, 100, 200],
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
    defaultPageSize: 30,
    pageSizeOptions: [15, 30, 60, 120],
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
    defaultPageSize: 25,
    pageSizeOptions: [10, 25, 50, 100, 200],
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
    defaultPageSize: 50,
    pageSizeOptions: [25, 50, 100, 200, 500],
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
      `SELECT type, channel, created_at, username
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
  });
});

r.get("/pages/export", async (_req, res) => {
  const settingsRow = await get(
    `SELECT id, wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text
       FROM settings
      WHERE id=1`,
  );
  const pageRows = await all(`
    SELECT p.id, p.slug_base, p.slug_id, p.title, p.content, p.created_at, p.updated_at,
      (SELECT GROUP_CONCAT(t.name, ',') FROM tags t
        JOIN page_tags pt ON pt.tag_id = t.id
       WHERE pt.page_id = p.id) AS tagsCsv
    FROM pages p
    ORDER BY p.created_at ASC
  `);
  const pages = pageRows.map((r) => ({
    id: r.id,
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
  const users = await all(
    `SELECT id, username, password, display_name, is_admin FROM users ORDER BY id ASC`,
  );
  const likes = await all(`
    SELECT l.id, l.page_id, p.slug_id, l.ip, l.created_at
      FROM likes l
      JOIN pages p ON p.id = l.page_id
     ORDER BY l.created_at ASC`);
  const comments = await all(`
    SELECT c.id, c.snowflake_id AS snowflake_id, c.page_id, p.slug_id, c.author, c.body, c.status,
           c.created_at, c.updated_at, c.ip, c.edit_token
      FROM comments c
      JOIN pages p ON p.id = c.page_id
     ORDER BY c.created_at ASC`);
  const viewEvents = await all(`
    SELECT pv.id, pv.page_id, p.slug_id, pv.ip, pv.viewed_at
      FROM page_views pv
      JOIN pages p ON p.id = pv.page_id
     ORDER BY pv.viewed_at ASC`);
  const aggregatedViews = await all(`
    SELECT v.page_id, p.slug_id, v.day, v.views
      FROM page_view_daily v
      JOIN pages p ON p.id = v.page_id
     ORDER BY v.day ASC`);
  const pageRevisions = await all(`
    SELECT pr.page_id, p.slug_id, pr.revision, pr.title, pr.content, pr.author_id, u.username AS author_username,
           pr.created_at
      FROM page_revisions pr
      JOIN pages p ON p.id = pr.page_id
      LEFT JOIN users u ON u.id = pr.author_id
     ORDER BY p.slug_id ASC, pr.revision ASC`);
  const uploads = await all(
    `SELECT id, original_name, display_name, extension, size, created_at FROM uploads ORDER BY created_at ASC`,
  );
  const ipBans = await all(
    `SELECT id, snowflake_id, ip, scope, value, reason, created_at, lifted_at
       FROM ip_bans
      ORDER BY created_at ASC`,
  );
  const events = await all(
    `SELECT id, channel, type, payload, ip, username, created_at
       FROM event_logs
      ORDER BY created_at ASC`,
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const date = new Date().toISOString().split("T")[0];
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="wiki-pages-${date}.json"`,
  );
  const payload = {
    schema_version: 2,
    full_export: true,
    exported_at: new Date().toISOString(),
    count: pages.length,
    counts: {
      pages: pages.length,
      users: users.length,
      likes: likes.length,
      comments: comments.length,
      view_events: viewEvents.length,
      view_daily: aggregatedViews.length,
      revisions: pageRevisions.length,
      uploads: uploads.length,
      ip_bans: ipBans.length,
      events: events.length,
    },
    settings: settingsRow || null,
    users,
    pages,
    page_revisions: pageRevisions,
    likes,
    comments,
    views: {
      events: viewEvents,
      daily: aggregatedViews,
    },
    uploads,
    ip_bans: ipBans,
    events,
  };
  res.send(JSON.stringify(payload, null, 2));
});

r.post(
  "/pages/import",
  jsonUpload.single("archive"),
  async (req, res, next) => {
    try {
      const ip = getClientIp(req);
      if (!req.file) {
        req.session.importResult = { errors: ["Aucun fichier importé."] };
        pushNotification(req, {
          type: "error",
          message: "Aucun fichier importé.",
        });
        return res.redirect("/admin/pages");
      }

      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString("utf8"));
      } catch (err) {
        req.session.importResult = {
          errors: ["Le fichier JSON est invalide: " + (err?.message || err)],
        };
        pushNotification(req, {
          type: "error",
          message: "Le fichier JSON est invalide.",
        });
        return res.redirect("/admin/pages");
      }

      const pages = Array.isArray(parsed) ? parsed : parsed?.pages;
      if (!Array.isArray(pages)) {
        req.session.importResult = {
          errors: ['Structure inattendue: un tableau "pages" est requis.'],
        };
        pushNotification(req, {
          type: "error",
          message: "Structure JSON inattendue : tableau \"pages\" requis.",
        });
        return res.redirect("/admin/pages");
      }

      const likesInput = Array.isArray(parsed?.likes) ? parsed.likes : [];
      const commentsInput = Array.isArray(parsed?.comments) ? parsed.comments : [];
      const viewEventsInput = Array.isArray(parsed?.views?.events)
        ? parsed.views.events
        : [];
      const viewDailyInput = Array.isArray(parsed?.views?.daily)
        ? parsed.views.daily
        : [];
      const ipBansInput = Array.isArray(parsed?.ip_bans) ? parsed.ip_bans : [];
      const eventsInput = Array.isArray(parsed?.events) ? parsed.events : [];
      const usersInput = Array.isArray(parsed?.users) ? parsed.users : [];
      const revisionsInput = Array.isArray(parsed?.page_revisions)
        ? parsed.page_revisions
        : [];
      const uploadsInput = Array.isArray(parsed?.uploads) ? parsed.uploads : [];
      const settingsInput =
        parsed && typeof parsed === "object" && parsed.settings &&
        typeof parsed.settings === "object"
          ? parsed.settings
          : null;

      const summary = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        stats: {
          users: 0,
          likes: 0,
          comments: 0,
          viewEvents: 0,
          viewDaily: 0,
          ipBans: 0,
          events: 0,
          revisions: 0,
          uploads: 0,
        },
        settingsUpdated: false,
      };

      const tagCache = new Map();
      const slugToId = new Map();

      await run("BEGIN TRANSACTION");
      try {
        if (settingsInput) {
          const currentSettings = await get(
            `SELECT wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text
               FROM settings
              WHERE id=1`,
          );
          const wikiName =
            typeof settingsInput.wiki_name === "string"
              ? settingsInput.wiki_name.trim()
              : typeof settingsInput.wikiName === "string"
                ? settingsInput.wikiName.trim()
                : currentSettings?.wiki_name || "Wiki";
          const logoUrl =
            typeof settingsInput.logo_url === "string"
              ? settingsInput.logo_url.trim()
              : typeof settingsInput.logoUrl === "string"
                ? settingsInput.logoUrl.trim()
                : currentSettings?.logo_url || "";
          const adminWebhook =
            typeof settingsInput.admin_webhook_url === "string"
              ? settingsInput.admin_webhook_url.trim()
              : typeof settingsInput.adminWebhook === "string"
                ? settingsInput.adminWebhook.trim()
                : currentSettings?.admin_webhook_url || "";
          const feedWebhook =
            typeof settingsInput.feed_webhook_url === "string"
              ? settingsInput.feed_webhook_url.trim()
              : typeof settingsInput.feedWebhook === "string"
                ? settingsInput.feedWebhook.trim()
                : currentSettings?.feed_webhook_url || "";
          const footerText =
            typeof settingsInput.footer_text === "string"
              ? settingsInput.footer_text.trim()
              : typeof settingsInput.footerText === "string"
                ? settingsInput.footerText.trim()
                : currentSettings?.footer_text || "";
          await run(
            `UPDATE settings
                SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=?
              WHERE id=1`,
            [wikiName, logoUrl, adminWebhook, feedWebhook, footerText],
          );
          summary.settingsUpdated = true;
        }

        for (let idx = 0; idx < usersInput.length; idx++) {
          const user = usersInput[idx] || {};
          const username =
            typeof user.username === "string" ? user.username.trim() : "";
          const password =
            typeof user.password === "string" ? user.password : "";
          const isAdminRaw = user.is_admin ?? user.isAdmin ?? 0;
        const isAdmin =
          typeof isAdminRaw === "boolean"
            ? isAdminRaw
            : Number(isAdminRaw) === 1;
        if (!username || !password) {
          summary.errors.push(
            `Utilisateur #${idx + 1}: identifiant ou mot de passe manquant.`,
          );
          continue;
        }
        const providedUserSnowflake =
          typeof user.snowflake_id === "string" && user.snowflake_id.trim()
            ? user.snowflake_id.trim()
            : null;
        const userSnowflake = providedUserSnowflake || generateSnowflake();
        const insertParams = [userSnowflake, username, password, isAdmin ? 1 : 0];
        const userId = parseInteger(user.id);
        if (userId !== null) {
          await run(
            `INSERT INTO users(id, snowflake_id, username, password, is_admin) VALUES(?,?,?,?,?)
             ON CONFLICT(username) DO UPDATE SET password=excluded.password, is_admin=excluded.is_admin`,
            [userId, ...insertParams],
          );
        } else {
          await run(
            `INSERT INTO users(snowflake_id, username, password, is_admin) VALUES(?,?,?,?)
             ON CONFLICT(username) DO UPDATE SET password=excluded.password, is_admin=excluded.is_admin`,
            insertParams,
          );
        }
          summary.stats.users++;
        }

        const userRows = await all(
          `SELECT id, username, display_name FROM users`,
        );
        const usernameToId = new Map();
        const userIdSet = new Set();
        for (const row of userRows) {
          usernameToId.set(row.username, row.id);
          userIdSet.add(row.id);
        }

        for (let idx = 0; idx < pages.length; idx++) {
          const item = pages[idx] || {};
          const title = typeof item.title === "string" ? item.title.trim() : "";
          const content = typeof item.content === "string" ? item.content : "";
          if (!title || !content) {
            summary.errors.push(
              `Entrée #${idx + 1}: titre ou contenu manquant.`,
            );
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

          const providedPageSnowflake =
            typeof item.snowflake_id === "string" && item.snowflake_id.trim()
              ? item.snowflake_id.trim()
              : null;
          const pageSnowflake = providedPageSnowflake || generateSnowflake();

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
            const explicitId = parseInteger(item.id);
            if (explicitId !== null) {
              const existingById = await get(
                "SELECT id, created_at FROM pages WHERE id=?",
                [explicitId],
              );
              if (existingById) {
                const finalCreatedAt =
                  sanitizeDate(item.created_at) || existingById.created_at;
                const finalUpdatedAt = updatedAt || new Date().toISOString();
                await run(
                  "UPDATE pages SET slug_base=?, slug_id=?, title=?, content=?, created_at=?, updated_at=? WHERE id=?",
                  [
                    slugBase,
                    slugId,
                    title,
                    content,
                    finalCreatedAt,
                    finalUpdatedAt,
                    explicitId,
                  ],
                );
                pageId = explicitId;
                summary.updated++;
              } else {
                await run(
                  "INSERT INTO pages(id, snowflake_id, slug_base, slug_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
                  [
                    explicitId,
                    pageSnowflake,
                    slugBase,
                    slugId,
                    title,
                    content,
                    createdAt,
                    updatedAt,
                  ],
                );
                pageId = explicitId;
                summary.created++;
              }
            } else {
              const result = await run(
                "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                [
                  pageSnowflake,
                  slugBase,
                  slugId,
                  title,
                  content,
                  createdAt,
                  updatedAt,
                ],
              );
              pageId = result.lastID;
              summary.created++;
            }
          }

          slugToId.set(slugId, pageId);

          await run("DELETE FROM page_tags WHERE page_id=?", [pageId]);
          for (const tagName of tags) {
            let tagId = tagCache.get(tagName);
            if (!tagId) {
              await run("INSERT OR IGNORE INTO tags(name, snowflake_id) VALUES(?,?)", [
                tagName,
                generateSnowflake(),
              ]);
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
                "INSERT OR IGNORE INTO page_tags(snowflake_id, page_id, tag_id) VALUES(?,?,?)",
                [generateSnowflake(), pageId, tagId],
              );
            }
          }

          await savePageFts({
            id: pageId,
            title,
            content,
            slug_id: slugId,
            tags: tags.join(","),
          });
        }

        const slugRows = await all("SELECT id, slug_id FROM pages");
        for (const row of slugRows) {
          slugToId.set(row.slug_id, row.id);
        }

        for (let idx = 0; idx < revisionsInput.length; idx++) {
          const revision = revisionsInput[idx] || {};
          const slugId =
            typeof revision.slug_id === "string" ? revision.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Révision #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const revisionNumber = parseInteger(revision.revision);
          if (revisionNumber === null || revisionNumber < 1) {
            summary.errors.push(
              `Révision #${idx + 1}: numéro de révision invalide.`,
            );
            continue;
          }
          const title =
            typeof revision.title === "string" ? revision.title : "";
          const content =
            typeof revision.content === "string" ? revision.content : "";
          const createdAt = sanitizeDate(revision.created_at);
          const authorUsername =
            typeof revision.author_username === "string"
              ? revision.author_username.trim()
              : "";
          let authorId = parseInteger(revision.author_id);
          if (authorId && !userIdSet.has(authorId)) {
            authorId = null;
          }
          if (!authorId && authorUsername) {
            authorId = usernameToId.get(authorUsername) || null;
          }
          const revisionSnowflake =
            typeof revision.snowflake_id === "string" && revision.snowflake_id.trim()
              ? revision.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO page_revisions(snowflake_id, page_id, revision, title, content, author_id, created_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(page_id, revision) DO UPDATE SET
               title=excluded.title,
               content=excluded.content,
               author_id=excluded.author_id,
               created_at=excluded.created_at`,
            [
              revisionSnowflake,
              pageId,
              revisionNumber,
              title,
              content,
              authorId,
              createdAt,
            ],
          );
          summary.stats.revisions++;
        }

        for (let idx = 0; idx < likesInput.length; idx++) {
          const like = likesInput[idx] || {};
          const slugId =
            typeof like.slug_id === "string" ? like.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Like #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const ipValue =
            typeof like.ip === "string" && like.ip.trim()
              ? like.ip.trim()
              : null;
          if (!ipValue) {
            summary.errors.push(
              `Like #${idx + 1}: adresse IP manquante pour ${slugId}.`,
            );
            continue;
          }
          const createdAt =
            sanitizeDate(like.created_at) || new Date().toISOString();
          const likeId = parseInteger(like.id);
          const likeSnowflake =
            typeof like.snowflake_id === "string" && like.snowflake_id.trim()
              ? like.snowflake_id.trim()
              : generateSnowflake();
          if (likeId !== null) {
            await run(
              `INSERT INTO likes(id, snowflake_id, page_id, ip, created_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, ip=excluded.ip, created_at=excluded.created_at`,
              [likeId, likeSnowflake, pageId, ipValue, createdAt],
            );
          } else {
            await run(
              `INSERT INTO likes(snowflake_id, page_id, ip, created_at) VALUES(?,?,?,?)
               ON CONFLICT(page_id, ip) DO UPDATE SET created_at=excluded.created_at`,
              [likeSnowflake, pageId, ipValue, createdAt],
            );
          }
          summary.stats.likes++;
        }

        for (let idx = 0; idx < commentsInput.length; idx++) {
          const comment = commentsInput[idx] || {};
          const slugId =
            typeof comment.slug_id === "string" ? comment.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Commentaire #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const snowflakeId =
            typeof comment.snowflake_id === "string"
              ? comment.snowflake_id
              : typeof comment.id === "string"
                ? comment.id
                : null;
          if (!snowflakeId) {
            summary.errors.push(
              `Commentaire #${idx + 1}: identifiant absent pour ${slugId}.`,
            );
            continue;
          }
          const author =
            typeof comment.author === "string" ? comment.author : null;
          const body =
            typeof comment.body === "string" ? comment.body : "";
          if (!body) {
            summary.errors.push(
              `Commentaire #${idx + 1}: contenu manquant pour ${slugId}.`,
            );
            continue;
          }
          const status =
            typeof comment.status === "string" && comment.status
              ? comment.status
              : "pending";
          const createdAt =
            sanitizeDate(comment.created_at) || new Date().toISOString();
          const updatedAt = sanitizeDate(comment.updated_at);
          const ipValue =
            typeof comment.ip === "string" && comment.ip.trim()
              ? comment.ip.trim()
              : null;
          const editToken =
            typeof comment.edit_token === "string"
              ? comment.edit_token
              : null;
          const commentId = parseInteger(comment.id);
          const authorIsAdmin = comment.author_is_admin ? 1 : 0;
          await run(
            `INSERT INTO comments(id, snowflake_id, page_id, author, body, status, created_at, updated_at, ip, edit_token, author_is_admin)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(snowflake_id) DO UPDATE SET
               page_id=excluded.page_id,
               author=excluded.author,
               body=excluded.body,
               status=excluded.status,
               created_at=excluded.created_at,
               updated_at=excluded.updated_at,
               ip=excluded.ip,
               edit_token=excluded.edit_token,
               author_is_admin=excluded.author_is_admin`,
            [
              commentId,
              snowflakeId,
              pageId,
              author,
              body,
              status,
              createdAt,
              updatedAt,
              ipValue,
              editToken,
              authorIsAdmin,
            ],
          );
          summary.stats.comments++;
        }

        for (let idx = 0; idx < viewEventsInput.length; idx++) {
          const view = viewEventsInput[idx] || {};
          const slugId =
            typeof view.slug_id === "string" ? view.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Vue #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const viewedAt =
            sanitizeDate(view.viewed_at) || new Date().toISOString();
          const ipValue =
            typeof view.ip === "string" && view.ip.trim()
              ? view.ip.trim()
              : null;
          const viewSnowflake =
            typeof view.snowflake_id === "string" && view.snowflake_id.trim()
              ? view.snowflake_id.trim()
              : generateSnowflake();
          const viewId = parseInteger(view.id);
          if (viewId !== null) {
            await run(
              `INSERT INTO page_views(id, snowflake_id, page_id, ip, viewed_at) VALUES(?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id, ip=excluded.ip, viewed_at=excluded.viewed_at`,
              [viewId, viewSnowflake, pageId, ipValue, viewedAt],
            );
          } else {
            await run(
              `INSERT INTO page_views(snowflake_id, page_id, ip, viewed_at) VALUES(?,?,?,?)`,
              [viewSnowflake, pageId, ipValue, viewedAt],
            );
          }
          summary.stats.viewEvents++;
        }

        for (let idx = 0; idx < viewDailyInput.length; idx++) {
          const view = viewDailyInput[idx] || {};
          const slugId =
            typeof view.slug_id === "string" ? view.slug_id.trim() : "";
          const pageId = slugToId.get(slugId);
          if (!pageId) {
            summary.errors.push(
              `Statistiques quotidiennes #${idx + 1}: page inconnue (${slugId || "sans slug"}).`,
            );
            continue;
          }
          const day = typeof view.day === "string" ? view.day : null;
          if (!day) {
            summary.errors.push(
              `Statistiques quotidiennes #${idx + 1}: jour manquant.`,
            );
            continue;
          }
          const viewsValue = parseInteger(view.views);
          const finalViews = viewsValue ?? 0;
          const viewDailySnowflake =
            typeof view.snowflake_id === "string" && view.snowflake_id.trim()
              ? view.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO page_view_daily(snowflake_id, page_id, day, views) VALUES(?,?,?,?)
             ON CONFLICT(page_id, day) DO UPDATE SET views=excluded.views`,
            [viewDailySnowflake, pageId, day, finalViews],
          );
          summary.stats.viewDaily++;
        }

        for (let idx = 0; idx < uploadsInput.length; idx++) {
          const upload = uploadsInput[idx] || {};
          const id = typeof upload.id === "string" ? upload.id : null;
          if (!id) {
            summary.errors.push(
              `Upload #${idx + 1}: identifiant manquant.`,
            );
            continue;
          }
          const originalName =
            typeof upload.original_name === "string"
              ? upload.original_name
              : upload.originalName;
          const extension =
            typeof upload.extension === "string"
              ? upload.extension
              : null;
          if (!originalName || !extension) {
            summary.errors.push(
              `Upload #${idx + 1}: nom d'origine ou extension manquants.`,
            );
            continue;
          }
          const displayName =
            typeof upload.display_name === "string"
              ? upload.display_name
              : typeof upload.displayName === "string"
                ? upload.displayName
                : null;
          const sizeValue = parseInteger(upload.size);
          const createdAt = sanitizeDate(upload.created_at);
          const uploadSnowflake =
            typeof upload.snowflake_id === "string" && upload.snowflake_id.trim()
              ? upload.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO uploads(id, snowflake_id, original_name, display_name, extension, size, created_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               original_name=excluded.original_name,
               display_name=excluded.display_name,
               extension=excluded.extension,
               size=excluded.size,
               created_at=excluded.created_at`,
            [
              id,
              uploadSnowflake,
              originalName,
              displayName,
              extension,
              sizeValue ?? null,
              createdAt,
            ],
          );
          summary.stats.uploads++;
        }

        for (let idx = 0; idx < ipBansInput.length; idx++) {
          const ban = ipBansInput[idx] || {};
          const snowflakeId =
            typeof ban.snowflake_id === "string"
              ? ban.snowflake_id
              : typeof ban.id === "string"
                ? ban.id
                : null;
          if (!snowflakeId) {
            summary.errors.push(
              `Blocage #${idx + 1}: identifiant manquant.`,
            );
            continue;
          }
          const ipValue = typeof ban.ip === "string" ? ban.ip.trim() : "";
          const scope = typeof ban.scope === "string" ? ban.scope : null;
          if (!ipValue || !scope) {
            summary.errors.push(
              `Blocage #${idx + 1}: IP ou portée manquante.`,
            );
            continue;
          }
          const createdAt = sanitizeDate(ban.created_at);
          const liftedAt = sanitizeDate(ban.lifted_at);
          const banId = parseInteger(ban.id);
          const banValue = typeof ban.value === "string" ? ban.value : null;
          const banReason = typeof ban.reason === "string" ? ban.reason : null;
          if (banId !== null) {
            await run(
              `INSERT INTO ip_bans(id, snowflake_id, ip, scope, value, reason, created_at, lifted_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 snowflake_id=excluded.snowflake_id,
                 ip=excluded.ip,
                 scope=excluded.scope,
                 value=excluded.value,
                 reason=excluded.reason,
                 created_at=excluded.created_at,
                 lifted_at=excluded.lifted_at`,
              [
                banId,
                snowflakeId,
                ipValue,
                scope,
                banValue,
                banReason,
                createdAt,
                liftedAt,
              ],
            );
          } else {
            await run(
              `INSERT INTO ip_bans(snowflake_id, ip, scope, value, reason, created_at, lifted_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(snowflake_id) DO UPDATE SET
                 ip=excluded.ip,
                 scope=excluded.scope,
                 value=excluded.value,
                 reason=excluded.reason,
                 created_at=excluded.created_at,
                 lifted_at=excluded.lifted_at`,
              [
                snowflakeId,
                ipValue,
                scope,
                banValue,
                banReason,
                createdAt,
                liftedAt,
              ],
            );
          }
          summary.stats.ipBans++;
        }

        for (let idx = 0; idx < eventsInput.length; idx++) {
          const event = eventsInput[idx] || {};
          const eventId = parseInteger(event.id);
          if (eventId === null) {
            summary.errors.push(
              `Événement #${idx + 1}: identifiant numérique requis.`,
            );
            continue;
          }
          const channel =
            typeof event.channel === "string" ? event.channel : null;
          const type = typeof event.type === "string" ? event.type : null;
          if (!channel || !type) {
            summary.errors.push(
              `Événement #${idx + 1}: canal ou type manquant.`,
            );
            continue;
          }
          const eventSnowflake =
            typeof event.snowflake_id === "string" && event.snowflake_id.trim()
              ? event.snowflake_id.trim()
              : generateSnowflake();
          await run(
            `INSERT INTO event_logs(id, snowflake_id, channel, type, payload, ip, username, created_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
               channel=excluded.channel,
               type=excluded.type,
               payload=excluded.payload,
               ip=excluded.ip,
               username=excluded.username,
               created_at=excluded.created_at`,
            [
              eventId,
              eventSnowflake,
              channel,
              type,
              typeof event.payload === "string"
                ? event.payload
                : event.payload
                  ? JSON.stringify(event.payload)
                  : null,
              typeof event.ip === "string" ? event.ip : null,
              typeof event.username === "string" ? event.username : null,
              sanitizeDate(event.created_at) || new Date().toISOString(),
            ],
          );
          summary.stats.events++;
        }

        await run("COMMIT");
      } catch (transactionError) {
        await run("ROLLBACK");
        throw transactionError;
      }

      if (summary.settingsUpdated) {
        invalidateSiteSettingsCache();
      }

      if (summary.errors.length) {
        req.session.importResult = summary;
      } else {
        delete req.session.importResult;
      }
      const baseSummaryMessage =
        `${summary.created} article(s) créé(s), ${summary.updated} article(s) mis à jour, ${summary.skipped} article(s) ignoré(s).`;
      const extraMetrics = [];
      if (summary.stats.users) {
        extraMetrics.push(`${summary.stats.users} utilisateur(s)`);
      }
      if (summary.stats.likes) {
        extraMetrics.push(`${summary.stats.likes} like(s)`);
      }
      if (summary.stats.comments) {
        extraMetrics.push(`${summary.stats.comments} commentaire(s)`);
      }
      if (summary.stats.viewEvents || summary.stats.viewDaily) {
        const viewsDetail = [];
        if (summary.stats.viewEvents) {
          viewsDetail.push(`${summary.stats.viewEvents} vue(s)`);
        }
        if (summary.stats.viewDaily) {
          viewsDetail.push(`${summary.stats.viewDaily} statistique(s) quotidienne(s)`);
        }
        if (viewsDetail.length) {
          extraMetrics.push(`statistiques (${viewsDetail.join(", ")})`);
        }
      }
      if (summary.stats.revisions) {
        extraMetrics.push(`${summary.stats.revisions} révision(s)`);
      }
      if (summary.stats.uploads) {
        extraMetrics.push(`${summary.stats.uploads} fichier(s)`);
      }
      if (summary.stats.ipBans) {
        extraMetrics.push(`${summary.stats.ipBans} blocage(s) IP`);
      }
      if (summary.stats.events) {
        extraMetrics.push(`${summary.stats.events} événement(s) journalisé(s)`);
      }
      const extraSummary =
        extraMetrics.length > 0
          ? ` Données synchronisées : ${extraMetrics.join(", ")}.`
          : "";
      const importSummaryMessage = summary.errors.length
        ? `Import terminé : ${baseSummaryMessage}${extraSummary} ${summary.errors.length} erreur(s) à consulter.`
        : `Import terminé avec succès : ${baseSummaryMessage}${extraSummary}`;
      pushNotification(req, {
        type: summary.errors.length ? "info" : "success",
        message: importSummaryMessage,
        timeout: 7000,
      });
      await sendAdminEvent(
        "Import de pages",
        {
          user: req.session.user?.username || null,
          extra: {
            ip,
            total: pages.length,
            created: summary.created,
            updated: summary.updated,
            skipped: summary.skipped,
            errors: summary.errors.slice(0, 5),
            stats: summary.stats,
            settingsUpdated: summary.settingsUpdated,
          },
        },
        { includeScreenshot: false },
      );
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

function parseInteger(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

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
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: "Paramètres enregistrés.",
  });
  res.redirect("/admin/settings");
});

// users
r.get("/users", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(CAST(id AS TEXT) LIKE ? OR username LIKE ? OR COALESCE(display_name,'') LIKE ?)",
    );
    params.push(like, like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const totalRow = await get(
    `SELECT COUNT(*) AS total FROM users ${where}`,
    params,
  );
  const basePagination = buildPagination(
    req,
    Number(totalRow?.total ?? 0),
  );
  const offset = (basePagination.page - 1) * basePagination.perPage;

  const users = await all(
    `SELECT id, username, display_name, is_admin FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`,
    [...params, basePagination.perPage, offset],
  );
  const pagination = decoratePagination(req, basePagination);
  res.render("admin/users", { users, pagination, searchTerm });
});
r.post("/users", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    pushNotification(req, {
      type: "error",
      message: "Nom d'utilisateur et mot de passe requis.",
    });
    return res.redirect("/admin/users");
  }
  const hashed = await hashPassword(password);
  try {
    const result = await run(
      "INSERT INTO users(snowflake_id, username,password,is_admin) VALUES(?,?,?,1)",
      [generateSnowflake(), username.trim(), hashed],
    );
    const ip = getClientIp(req);
    await sendAdminEvent(
      "Utilisateur créé",
      {
        user: req.session.user?.username || null,
        extra: {
          ip,
          newUser: username.trim(),
          userId: result?.lastID || null,
        },
      },
      { includeScreenshot: false },
    );
    pushNotification(req, {
      type: "success",
      message: `Utilisateur ${username.trim()} créé.`,
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
            `INSERT INTO comments(page_id, author, body, created_at, updated_at, ip, edit_token, status, author_is_admin)
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
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

r.get("/events", async (req, res) => {
  const searchTerm = (req.query.search || "").trim();
  const filters = [];
  const params = [];
  if (searchTerm) {
    const like = `%${searchTerm}%`;
    filters.push(
      "(CAST(id AS TEXT) LIKE ? OR COALESCE(channel,'') LIKE ? OR COALESCE(type,'') LIKE ? OR COALESCE(username,'') LIKE ? OR COALESCE(ip,'') LIKE ? OR COALESCE(payload,'') LIKE ?)",
    );
    params.push(like, like, like, like, like, like);
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
    `SELECT id, channel, type, payload, ip, username, created_at
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
        const status =
          typeof comment.status === "string" &&
          ["pending", "approved", "rejected"].includes(comment.status)
            ? comment.status
            : "pending";
        return {
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
