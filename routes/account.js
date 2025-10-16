import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import multer from "multer";
import { Router } from "express";
import { get, run, all } from "../db.js";
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
import {
  uploadDir,
  ensureUploadDir,
  optimizeUpload,
} from "../utils/uploads.js";
import {
  hashIp,
  formatIpProfileLabel,
} from "../utils/ipProfiles.js";
import { sendAdminEvent } from "../utils/webhook.js";

const PROFILE_UPLOAD_SUBDIR = "profiles";
const PROFILE_UPLOAD_DIR = path.join(uploadDir, PROFILE_UPLOAD_SUBDIR);
const PROFILE_URL_PREFIX = `/public/uploads/${PROFILE_UPLOAD_SUBDIR}/`;
const ALLOWED_PROFILE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

async function ensureProfileUploadDir() {
  await ensureUploadDir();
  await fs.mkdir(PROFILE_UPLOAD_DIR, { recursive: true });
}

function inferProfileExtension(mimeType, originalName) {
  const normalizedMime = (mimeType || "").toLowerCase();
  switch (normalizedMime) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default: {
      const ext = path.extname(originalName || "").toLowerCase();
      if (ext && ext.length <= 10) {
        return ext;
      }
      return ".png";
    }
  }
}

function buildProfileFilename(originalName, mimeType) {
  const ext = inferProfileExtension(mimeType, originalName);
  const randomPart = randomBytes(6).toString("hex");
  return `${Date.now()}-${randomPart}${ext}`;
}

function buildProfileAssetUrl(filename) {
  return PROFILE_URL_PREFIX + filename;
}

async function deleteProfileAsset(url) {
  if (typeof url !== "string") return;
  if (!url.startsWith(PROFILE_URL_PREFIX)) return;
  const filename = path.basename(url);
  if (!filename) return;
  const targetPath = path.join(PROFILE_UPLOAD_DIR, filename);
  try {
    await fs.unlink(targetPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn("Unable to delete profile asset %s: %s", filename, err);
    }
  }
}

async function cleanupProfileUploads(files = []) {
  await Promise.all(
    files
      .filter((file) => file && file.path)
      .map((file) =>
        fs.unlink(file.path).catch((err) => {
          if (err?.code !== "ENOENT") {
            console.warn(
              "Unable to clean temporary profile upload %s: %s",
              file.filename || file.path,
              err,
            );
          }
        }),
      ),
  );
}

async function finalizeProfileUpload(file) {
  if (!file) return null;
  try {
    await optimizeUpload(file.path, file.mimetype, path.extname(file.filename));
  } catch (err) {
    console.warn(
      "Unable to optimize profile upload %s: %s",
      file.filename,
      err?.message || err,
    );
  }
  return buildProfileAssetUrl(file.filename);
}

const profileUploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    ensureProfileUploadDir()
      .then(() => cb(null, PROFILE_UPLOAD_DIR))
      .catch((err) => cb(err));
  },
  filename(req, file, cb) {
    try {
      const filename = buildProfileFilename(file.originalname, file.mimetype);
      cb(null, filename);
    } catch (err) {
      cb(err);
    }
  },
});

const profileUpload = multer({
  storage: profileUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const mime = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_PROFILE_MIME_TYPES.has(mime)) {
      const error = new Error(
        "Seuls les fichiers JPG, PNG, GIF ou WebP sont acceptés pour le profil.",
      );
      error.code = "UNSUPPORTED_FILE_TYPE";
      return cb(error);
    }
    cb(null, true);
  },
});

const processProfileUploads = profileUpload.fields([
  { name: "avatarFile", maxCount: 1 },
  { name: "bannerFile", maxCount: 1 },
]);

function handleProfileUploads(req, res, next) {
  processProfileUploads(req, res, (err) => {
    if (err) {
      const errors = Array.isArray(req.profileUploadErrors)
        ? req.profileUploadErrors
        : [];
      let message = "Impossible de traiter le fichier envoyé.";
      if (err.code === "LIMIT_FILE_SIZE") {
        message = "Les images doivent peser moins de 5 Mo.";
      } else if (err.code === "UNSUPPORTED_FILE_TYPE") {
        message = err.message;
      } else if (err instanceof multer.MulterError) {
        message = err.message || message;
      }
      req.profileUploadErrors = [...errors, message];
      return next();
    }
    return next();
  });
}

async function fetchLinkedIpProfilesForUser(userId) {
  const numericId = Number.parseInt(userId, 10);
  if (!Number.isInteger(numericId)) {
    return [];
  }
  const rows = await all(
    `SELECT hash, claimed_at FROM ip_profiles WHERE claimed_user_id=? ORDER BY claimed_at DESC`,
    [numericId],
  );
  return rows.map((row) => ({
    hash: row.hash,
    claimedAt: row.claimed_at || null,
    shortHash: formatIpProfileLabel(row.hash),
  }));
}

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
      `SELECT id, username, display_name, avatar_url, banner_url, bio,
              profile_show_badges, profile_show_recent_pages, profile_show_ip_profiles,
              profile_show_bio, profile_show_stats
         FROM users
        WHERE id=?`,
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
    const linkedIpProfiles = await fetchLinkedIpProfilesForUser(profile.id);
    const currentIp = getClientIp(req);
    const currentIpHash = hashIp(currentIp);
    res.render("account/profile", {
      errors: [],
      profile: {
        username: profile.username,
        displayName: profile.display_name || "",
        avatarUrl: profile.avatar_url || "",
        bannerUrl: profile.banner_url || "",
        bio: profile.bio || "",
        showBadges: profile.profile_show_badges !== 0,
        showRecentPages: profile.profile_show_recent_pages !== 0,
        showIpProfiles: profile.profile_show_ip_profiles !== 0,
        showBio: profile.profile_show_bio !== 0,
        showStats: profile.profile_show_stats !== 0,
      },
      linkedIpProfiles,
      currentIpHash,
    });
  }),
);

r.post(
  "/profile",
  ensureAuthenticated,
  handleProfileUploads,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const dbProfile = await get(
      `SELECT id, username, avatar_url, banner_url FROM users WHERE id=?`,
      [sessionUser.id],
    );
    if (!dbProfile) {
      pushNotification(req, {
        type: "error",
        message: "Utilisateur introuvable. Merci de vous reconnecter.",
      });
      req.session.user = null;
      return res.redirect("/login");
    }

    const uploadErrors = Array.isArray(req.profileUploadErrors)
      ? [...req.profileUploadErrors]
      : [];
    const rawUsername = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const rawDisplayName =
      typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";
    const rawBio = typeof req.body.bio === "string" ? req.body.bio.trim() : "";
    const showBadges = req.body.showBadges === "on";
    const showRecentPages = req.body.showRecentPages === "on";
    const showIpProfiles = req.body.showIpProfiles === "on";
    const showBio = req.body.showBio === "on";
    const showStats = req.body.showStats === "on";
    const removeAvatar = req.body.removeAvatar === "on";
    const removeBanner = req.body.removeBanner === "on";

    const avatarResult = normalizeMediaUrl(req.body.avatarUrl || "");
    const bannerResult = normalizeMediaUrl(req.body.bannerUrl || "");

    const errors = [...uploadErrors];
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

    const avatarFile = req.files?.avatarFile?.[0] || null;
    const bannerFile = req.files?.bannerFile?.[0] || null;
    const uploadedFiles = [avatarFile, bannerFile].filter(Boolean);

    const usernameChanged =
      rawUsername && rawUsername.toLowerCase() !== dbProfile.username.toLowerCase();

    if (!errors.length && usernameChanged) {
      const existing = await get(
        "SELECT 1 FROM users WHERE username=? COLLATE NOCASE",
        [rawUsername],
      );
      if (existing) {
        errors.push("Ce nom d'utilisateur est déjà utilisé.");
      }
    }

    const linkedIpProfiles = await fetchLinkedIpProfilesForUser(sessionUser.id);
    const currentIpHash = hashIp(getClientIp(req));

    if (errors.length) {
      await cleanupProfileUploads(uploadedFiles);
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
          showBadges,
          showRecentPages,
          showIpProfiles,
          showBio,
          showStats,
        },
        linkedIpProfiles,
        currentIpHash,
      });
    }

    let avatarUrl = avatarResult.value;
    let bannerUrl = bannerResult.value;

    if (removeAvatar) {
      avatarUrl = null;
    } else if (avatarFile) {
      avatarUrl = await finalizeProfileUpload(avatarFile);
    }

    if (removeBanner) {
      bannerUrl = null;
    } else if (bannerFile) {
      bannerUrl = await finalizeProfileUpload(bannerFile);
    }

    try {
      await run(
        `UPDATE users
            SET username=?,
                display_name=?,
                avatar_url=?,
                banner_url=?,
                bio=?,
                profile_show_badges=?,
                profile_show_recent_pages=?,
                profile_show_ip_profiles=?,
                profile_show_bio=?,
                profile_show_stats=?
          WHERE id=?`,
        [
          rawUsername,
          normalizedDisplayName,
          avatarUrl,
          bannerUrl,
          normalizedBio,
          showBadges ? 1 : 0,
          showRecentPages ? 1 : 0,
          showIpProfiles ? 1 : 0,
          showBio ? 1 : 0,
          showStats ? 1 : 0,
          sessionUser.id,
        ],
      );
    } catch (err) {
      await cleanupProfileUploads(uploadedFiles);
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
            showBadges,
            showRecentPages,
            showIpProfiles,
            showBio,
            showStats,
          },
          linkedIpProfiles,
          currentIpHash,
        });
      }
      throw err;
    }

    if ((removeAvatar || avatarFile) && dbProfile.avatar_url !== avatarUrl) {
      await deleteProfileAsset(dbProfile.avatar_url);
    }
    if ((removeBanner || bannerFile) && dbProfile.banner_url !== bannerUrl) {
      await deleteProfileAsset(dbProfile.banner_url);
    }

    req.session.user = {
      ...sessionUser,
      username: rawUsername,
      display_name: normalizedDisplayName,
      avatar_url: avatarUrl,
      banner_url: bannerUrl,
      bio: normalizedBio,
      profile_show_badges: showBadges,
      profile_show_recent_pages: showRecentPages,
      profile_show_ip_profiles: showIpProfiles,
      profile_show_bio: showBio,
      profile_show_stats: showStats,
    };

    pushNotification(req, {
      type: "success",
      message: "Votre profil a été mis à jour.",
    });

    res.redirect("/account/profile");
  }),
);

r.post(
  "/profile/ip-profiles/:hash/unlink",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const rawHash = typeof req.params.hash === "string" ? req.params.hash.trim() : "";
    if (!rawHash) {
      pushNotification(req, {
        type: "error",
        message: "Profil IP introuvable.",
      });
      return res.redirect("/account/profile");
    }
    const normalizedHash = rawHash.toLowerCase();
    const profile = await get(
      `SELECT hash, claimed_user_id FROM ip_profiles WHERE hash=?`,
      [normalizedHash],
    );
    const numericOwner = Number.parseInt(profile?.claimed_user_id, 10);
    if (!profile || !Number.isInteger(numericOwner) || numericOwner !== sessionUser.id) {
      pushNotification(req, {
        type: "error",
        message: "Ce profil IP n'est pas associé à votre compte.",
      });
      return res.redirect("/account/profile");
    }

    const result = await run(
      `UPDATE ip_profiles
          SET claimed_user_id=NULL,
              claimed_at=NULL
        WHERE hash=? AND claimed_user_id=?`,
      [normalizedHash, sessionUser.id],
    );

    if (!result?.changes) {
      pushNotification(req, {
        type: "error",
        message: "Impossible de dissocier ce profil IP.",
      });
      return res.redirect("/account/profile");
    }

    const ip = getClientIp(req);
    await sendAdminEvent(
      "Profil IP dissocié",
      {
        user: sessionUser.username,
        extra: {
          ip,
          profileHash: normalizedHash,
          shortHash: formatIpProfileLabel(normalizedHash),
        },
      },
      { includeScreenshot: false },
    );

    pushNotification(req, {
      type: "success",
      message: "Le profil IP a été dissocié de votre compte.",
    });

    res.redirect("/account/profile");
  }),
);

export default r;
