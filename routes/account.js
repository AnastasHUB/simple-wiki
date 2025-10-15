import { Router } from "express";
import { get, run } from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  countPageSubmissions,
  fetchPageSubmissions,
  mapSubmissionTags,
} from "../utils/pageSubmissionService.js";
import { buildPaginationView } from "../utils/pagination.js";
import { getClientIp } from "../utils/ip.js";
import { pushNotification } from "../utils/notifications.js";
import { usernamePattern } from "../utils/registrationValidation.js";

const r = Router();

function ensureAuthenticated(req, res, next) {
  if (req?.session?.user) {
    return next();
  }
  pushNotification(req, {
    type: "error",
    message: "Vous devez être connecté·e pour modifier votre profil.",
  });
  return res.redirect("/login");
}

function resolveIdentity(req) {
  return {
    submittedBy: req.session.user?.username || null,
    ip: getClientIp(req) || null,
  };
}

function normalizeMediaUrl(rawValue, { allowRelative = true } = {}) {
  if (typeof rawValue !== "string") {
    return { value: null, error: null };
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { value: null, error: null };
  }
  if (trimmed.length > 500) {
    return {
      value: null,
      error: "L'URL fournie est trop longue (500 caractères maximum).",
    };
  }
  const isHttp = /^https?:\/\//i.test(trimmed);
  const isRelative = trimmed.startsWith("/");
  if (isHttp || (allowRelative && isRelative)) {
    return { value: trimmed, error: null };
  }
  return {
    value: null,
    error:
      "Les images doivent utiliser une URL absolue (http/https) ou commencer par un slash (/).",
  };
}

async function buildSection(
  req,
  identity,
  { status, pageParam, perPageParam, orderBy, direction },
) {
  const hasIdentity = Boolean(identity.submittedBy) || Boolean(identity.ip);

  if (!hasIdentity) {
    return {
      rows: [],
      pagination: buildPaginationView(req, 0, { pageParam, perPageParam }),
    };
  }

  const total = await countPageSubmissions({
    status,
    submittedBy: identity.submittedBy,
    ip: identity.ip,
  });
  const pagination = buildPaginationView(req, total, {
    pageParam,
    perPageParam,
  });
  let rows = [];
  if (total > 0) {
    const offset = (pagination.page - 1) * pagination.perPage;
    const fetched = await fetchPageSubmissions({
      status,
      limit: pagination.perPage,
      offset,
      orderBy,
      direction,
      submittedBy: identity.submittedBy,
      ip: identity.ip,
    });
    rows = fetched.map((item) => ({
      ...item,
      tag_list: mapSubmissionTags(item),
    }));
  }
  return { rows, pagination };
}

r.get(
  "/submissions",
  asyncHandler(async (req, res) => {
    const identity = resolveIdentity(req);
    const [pending, approved, rejected] = await Promise.all([
      buildSection(req, identity, {
        status: "pending",
        pageParam: "pendingPage",
        perPageParam: "pendingPerPage",
        orderBy: "created_at",
        direction: "DESC",
      }),
      buildSection(req, identity, {
        status: "approved",
        pageParam: "approvedPage",
        perPageParam: "approvedPerPage",
        orderBy: "reviewed_at",
        direction: "DESC",
      }),
      buildSection(req, identity, {
        status: "rejected",
        pageParam: "rejectedPage",
        perPageParam: "rejectedPerPage",
        orderBy: "reviewed_at",
        direction: "DESC",
      }),
    ]);

    res.render("account/submissions", {
      pending: pending.rows,
      approved: approved.rows,
      rejected: rejected.rows,
      pendingPagination: pending.pagination,
      approvedPagination: approved.pagination,
      rejectedPagination: rejected.pagination,
    });
  }),
);

r.get(
  "/profile",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const profile = await get(
      "SELECT id, username, display_name, avatar_url, banner_url, bio FROM users WHERE id=?",
      [sessionUser.id],
    );
    if (!profile) {
      pushNotification(req, {
        type: "error",
        message: "Utilisateur introuvable. Merci de vous reconnecter.",
      });
      req.session.user = null;
      return res.redirect("/login");
    }
    res.render("account/profile", {
      errors: [],
      profile: {
        username: profile.username,
        displayName: profile.display_name || "",
        avatarUrl: profile.avatar_url || "",
        bannerUrl: profile.banner_url || "",
        bio: profile.bio || "",
      },
    });
  }),
);

r.post(
  "/profile",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const errors = [];

    const rawUsername = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const rawDisplayName =
      typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
    const avatarResult = normalizeMediaUrl(req.body.avatarUrl || "");
    const bannerResult = normalizeMediaUrl(req.body.bannerUrl || "");
    const rawBio = typeof req.body.bio === "string" ? req.body.bio.trim() : "";

    if (avatarResult.error) {
      errors.push(avatarResult.error);
    }
    if (bannerResult.error) {
      errors.push(bannerResult.error);
    }

    if (!rawUsername) {
      errors.push("Veuillez indiquer un nom d'utilisateur.");
    } else if (rawUsername.length < 3 || rawUsername.length > 32) {
      errors.push("Le nom d'utilisateur doit contenir entre 3 et 32 caractères.");
    } else if (!usernamePattern.test(rawUsername)) {
      errors.push(
        "Le nom d'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores.",
      );
    }

    let normalizedDisplayName = rawDisplayName.slice(0, 80);
    if (normalizedDisplayName && normalizedDisplayName.length < 2) {
      errors.push("Le pseudo affiché doit contenir au moins 2 caractères ou être laissé vide.");
    }
    if (!normalizedDisplayName) {
      normalizedDisplayName = null;
    }

    let normalizedBio = rawBio.slice(0, 500);
    if (rawBio.length > 500) {
      errors.push("La biographie est limitée à 500 caractères.");
    }
    if (!normalizedBio) {
      normalizedBio = null;
    }

    const avatarUrl = avatarResult.value;
    const bannerUrl = bannerResult.value;

    const usernameChanged =
      rawUsername && rawUsername.toLowerCase() !== sessionUser.username.toLowerCase();

    if (!errors.length && usernameChanged) {
      const existing = await get(
        "SELECT 1 FROM users WHERE username=? COLLATE NOCASE",
        [rawUsername],
      );
      if (existing) {
        errors.push("Ce nom d'utilisateur est déjà utilisé.");
      }
    }

    if (errors.length) {
      errors.forEach((message) =>
        pushNotification(req, {
          type: "error",
          message,
          timeout: 6000,
        }),
      );
      return res.status(400).render("account/profile", {
        errors,
        profile: {
          username: rawUsername || sessionUser.username,
          displayName: rawDisplayName,
          avatarUrl: req.body.avatarUrl || "",
          bannerUrl: req.body.bannerUrl || "",
          bio: rawBio.slice(0, 500),
        },
      });
    }

    try {
      await run(
        `UPDATE users
            SET username=?,
                display_name=?,
                avatar_url=?,
                banner_url=?,
                bio=?
          WHERE id=?`,
        [
          rawUsername,
          normalizedDisplayName,
          avatarUrl,
          bannerUrl,
          normalizedBio,
          sessionUser.id,
        ],
      );
    } catch (err) {
      if (err?.code === "SQLITE_CONSTRAINT" || err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        pushNotification(req, {
          type: "error",
          message: "Ce nom d'utilisateur est déjà utilisé.",
        });
        return res.status(400).render("account/profile", {
          errors: ["Ce nom d'utilisateur est déjà utilisé."],
          profile: {
            username: rawUsername,
            displayName: rawDisplayName,
            avatarUrl: req.body.avatarUrl || "",
            bannerUrl: req.body.bannerUrl || "",
            bio: rawBio.slice(0, 500),
          },
        });
      }
      throw err;
    }

    req.session.user = {
      ...sessionUser,
      username: rawUsername,
      display_name: normalizedDisplayName,
      avatar_url: avatarUrl,
      banner_url: bannerUrl,
      bio: normalizedBio,
    };

    pushNotification(req, {
      type: "success",
      message: "Votre profil a été mis à jour.",
    });

    res.redirect("/account/profile");
  }),
);

export default r;
