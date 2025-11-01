import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import multer from "multer";
import { Router } from "express";
import {
  get,
  run,
  all,
  rotateUserTotpSecret,
  rotateUserRecoveryCodes,
} from "../db.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  countPageSubmissions,
  fetchPageSubmissions,
  mapSubmissionTags,
} from "../utils/pageSubmissionService.js";
import { buildPaginationView } from "../utils/pagination.js";
import { getClientIp } from "../utils/ip.js";
import { pushNotification } from "../utils/notifications.js";
import { hashPassword, verifyPassword } from "../utils/passwords.js";
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
import { normalizeHttpUrl } from "../utils/urlValidation.js";
import {
  PremiumCodeError,
  redeemPremiumCodeForUser,
  getPremiumStatusForUser,
} from "../utils/premiumService.js";
import { loadSessionUserById } from "../utils/sessionUser.js";
import { formatDateTimeLocalized, formatRelativeDurationMs } from "../utils/time.js";
import { getSiteSettings } from "../utils/settingsService.js";
import {
  generateTwoFactorSecret,
  buildTwoFactorProvisioningUri,
  buildQrCodeDataUrl,
  verifyTwoFactorToken,
  generateRecoveryCodes,
  createRecoveryCodeState,
  serializeRecoveryCodeState,
  parseRecoveryCodeState,
  markRecoveryCodeUsed,
  countAvailableRecoveryCodes,
  formatRecoveryCodeForDisplay,
} from "../utils/twoFactor.js";
import {
  createRegistrationOptions,
  verifyRegistration,
  setRegistrationChallenge,
  getRegistrationChallenge,
  clearRegistrationChallenge,
  listUserWebAuthnCredentials,
  saveWebAuthnCredential,
  deleteUserWebAuthnCredential,
  toBase64Url,
} from "../utils/webauthn.js";

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

function buildProfileAssetUrl(origin, filename) {
  const relativePath = PROFILE_URL_PREFIX + filename;
  if (!origin) {
    return relativePath;
  }
  try {
    return new URL(relativePath, origin).toString();
  } catch (_err) {
    return relativePath;
  }
}

async function deleteProfileAsset(url) {
  if (typeof url !== "string") return;
  let normalizedUrl = url;
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      normalizedUrl = parsed.pathname || "";
    } catch (_err) {
      return;
    }
  }
  if (!normalizedUrl.startsWith(PROFILE_URL_PREFIX)) return;
  const filename = path.basename(normalizedUrl);
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

async function finalizeProfileUpload(req, file) {
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
  const origin = getRequestOrigin(req);
  return buildProfileAssetUrl(origin, file.filename);
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

function getRequestOrigin(req) {
  const host = req.get("host");
  if (!host) {
    return `${req.protocol}://localhost`;
  }
  return `${req.protocol}://${host}`;
}

function buildProfileLinks(origin, username, linkedIpProfiles, currentIpHash) {
  const normalizedLinkedProfiles = Array.isArray(linkedIpProfiles)
    ? linkedIpProfiles
    : [];
  const encodedUsername = typeof username === "string" ? encodeURIComponent(username) : "";
  const profilePublicUrl = encodedUsername
    ? `${origin}/members/${encodedUsername}`
    : `${origin}/members`;
  const decoratedProfiles = normalizedLinkedProfiles.map((profile) => ({
    ...profile,
    url: `${origin}/profiles/ip/${encodeURIComponent(profile.hash)}`,
  }));
  const currentIpLink = currentIpHash
    ? `${origin}/profiles/ip/${encodeURIComponent(currentIpHash)}`
    : null;
  return { profilePublicUrl, linkedIpProfiles: decoratedProfiles, currentIpLink };
}

async function loadTwoFactorStatus(userId) {
  if (!userId) {
    return {
      enabled: false,
      secret: null,
      recoveryState: [],
    };
  }
  const row = await get(
    "SELECT two_factor_enabled, totp_secret, recovery_codes FROM users WHERE id=?",
    [userId],
  );
  const recoveryState = parseRecoveryCodeState(row?.recovery_codes || null);
  return {
    enabled: row?.two_factor_enabled === 1,
    secret: row?.totp_secret || null,
    recoveryState,
  };
}

function setTwoFactorSetupSession(req, data) {
  if (!req.session) {
    return;
  }
  req.session.twoFactorSetup = data || null;
}

function getTwoFactorSetupSession(req) {
  if (!req.session) {
    return null;
  }
  const data = req.session.twoFactorSetup;
  return data && typeof data === "object" ? data : null;
}

function clearTwoFactorSetupSession(req) {
  if (req.session) {
    delete req.session.twoFactorSetup;
  }
}

function stashGeneratedRecoveryCodes(req, codes = []) {
  if (!req.session) {
    return;
  }
  req.session.generatedRecoveryCodes = Array.isArray(codes) ? [...codes] : [];
}

function getGeneratedRecoveryCodes(req) {
  if (!req.session) {
    return [];
  }
  return Array.isArray(req.session.generatedRecoveryCodes)
    ? [...req.session.generatedRecoveryCodes]
    : [];
}

function clearGeneratedRecoveryCodes(req) {
  if (req.session) {
    delete req.session.generatedRecoveryCodes;
  }
}

function formatRecoveryCodesForDisplayList(codes = []) {
  return codes.map((code) => formatRecoveryCodeForDisplay(code)).filter(Boolean);
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

function normalizeMediaUrl(
  rawValue,
  { allowRelative = false, fieldName = "L'URL de l'image" } = {},
) {
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
  const isRelative = trimmed.startsWith("/");
  if (allowRelative && isRelative) {
    return { value: trimmed, error: null };
  }
  try {
    const normalized = normalizeHttpUrl(trimmed, { fieldName });
    return { value: normalized, error: null };
  } catch (err) {
    return {
      value: null,
      error:
        err?.message ||
        "Les images doivent utiliser une URL absolue commençant par http:// ou https://.",
    };
  }
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
              profile_show_bio, profile_show_stats, premium_expires_at, premium_via_code
         FROM users
        WHERE id=?`,
      [sessionUser.id],
    );
    if (!profile) {
      pushNotification(req, {
        type: "error",
        message: req.t("account.errors.userNotFound"),
      });
      req.session.user = null;
      return res.redirect("/login");
    }
    const linkedIpProfiles = await fetchLinkedIpProfilesForUser(profile.id);
    const currentIp = getClientIp(req);
    const currentIpHash = hashIp(currentIp);
    const origin = getRequestOrigin(req);
    const { profilePublicUrl, linkedIpProfiles: decoratedProfiles, currentIpLink } =
      buildProfileLinks(origin, profile.username, linkedIpProfiles, currentIpHash);
    const premiumStatus = await getPremiumStatusForUser(profile.id);
    const premiumExpiresAtFormatted = premiumStatus.expiresAt
      ? formatDateTimeLocalized(premiumStatus.expiresAt, req.lang)
      : null;
    const premiumRelative = premiumStatus.expiresAt
      ? formatRelativeDurationMs(Date.now() - premiumStatus.expiresAt.getTime())
      : null;
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
      linkedIpProfiles: decoratedProfiles,
      currentIpHash,
      currentIpLink,
      profilePublicUrl,
      premium: {
        ...premiumStatus,
        expiresAtFormatted: premiumExpiresAtFormatted,
        expiresAtRelative: premiumRelative,
      },
    });
  }),
);

r.get(
  "/security",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const [twoFactor, settings, passkeyRecords] = await Promise.all([
      loadTwoFactorStatus(sessionUser.id),
      getSiteSettings({ forceRefresh: false }),
      listUserWebAuthnCredentials(sessionUser.id),
    ]);

    const setup = getTwoFactorSetupSession(req);
    const formattedSetupCodes = setup?.recoveryCodes
      ? formatRecoveryCodesForDisplayList(setup.recoveryCodes)
      : [];
    const generatedCodes = getGeneratedRecoveryCodes(req);
    const formattedGeneratedCodes = formatRecoveryCodesForDisplayList(generatedCodes);

    const issuerName = settings?.wiki_name || "SimpleWiki";
    const totalCodes = twoFactor.recoveryState.length;
    const remainingCodes = countAvailableRecoveryCodes(twoFactor.recoveryState);
    const usedCodes = Math.max(0, totalCodes - remainingCodes);

    const passkeys = passkeyRecords.map((record) => {
      const createdAtDate = record.createdAt ? new Date(record.createdAt) : null;
      const lastUsedDate = record.lastUsedAt ? new Date(record.lastUsedAt) : null;
      const fallbackName = record.credentialId
        ? `Clé ${record.credentialId.slice(0, 8)}…`
        : "Passkey";
      return {
        id: record.credentialId,
        friendlyName: record.friendlyName || fallbackName,
        createdAtFormatted: createdAtDate
          ? formatDateTimeLocalized(createdAtDate, req.lang)
          : null,
        lastUsedFormatted: lastUsedDate
          ? formatDateTimeLocalized(lastUsedDate, req.lang)
          : null,
        lastUsedRelative: lastUsedDate
          ? formatRelativeDurationMs(Date.now() - lastUsedDate.getTime())
          : null,
        deviceType: record.deviceType || null,
        backedUp: record.backedUp,
      };
    });

    res.render("account/security", {
      issuerName,
      twoFactorEnabled: twoFactor.enabled,
      recoveryCodesTotal: totalCodes,
      recoveryCodesRemaining: remainingCodes,
      recoveryCodesUsed: usedCodes,
      setup: setup
        ? {
            secret: setup.secret,
            qrDataUrl: setup.qrDataUrl,
            otpauthUrl: setup.otpauthUrl,
            recoveryCodes: formattedSetupCodes,
          }
        : null,
      generatedRecoveryCodes: formattedGeneratedCodes,
      passkeys,
    });
  }),
);

r.post(
  "/security/password",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const currentPassword =
      typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword =
      typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    const confirmPassword =
      typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";

    const errors = [];
    if (!currentPassword) {
      errors.push(req.t("account.security.errors.currentRequired"));
    }
    if (!newPassword) {
      errors.push(req.t("account.security.errors.newRequired"));
    } else if (newPassword.length < 8) {
      errors.push(req.t("account.security.errors.newTooShort"));
    }
    if (!confirmPassword) {
      errors.push(req.t("account.security.errors.confirmRequired"));
    } else if (newPassword && confirmPassword !== newPassword) {
      errors.push(req.t("account.security.errors.mismatch"));
    }

    if (errors.length) {
      errors.forEach((message) =>
        pushNotification(req, {
          type: "error",
          message,
          timeout: 6000,
        }),
      );
      return res.redirect("/account/security");
    }

    const account = await get("SELECT id, password FROM users WHERE id=?", [sessionUser.id]);
    if (!account) {
      pushNotification(req, {
        type: "error",
        message: req.t("account.errors.userNotFound"),
      });
      req.session.user = null;
      return res.redirect("/login");
    }

    const passwordMatches = await verifyPassword(currentPassword, account.password);
    if (!passwordMatches) {
      pushNotification(req, {
        type: "error",
        message: req.t("account.security.errors.currentInvalid"),
      });
      return res.redirect("/account/security");
    }

    if (currentPassword === newPassword) {
      pushNotification(req, {
        type: "error",
        message: req.t("account.security.errors.newSameAsCurrent"),
      });
      return res.redirect("/account/security");
    }

    const hashedPassword = await hashPassword(newPassword);
    await run("UPDATE users SET password=? WHERE id=?", [hashedPassword, sessionUser.id]);

    await sendAdminEvent(
      "Mot de passe modifié",
      {
        user: sessionUser.username,
        extra: {
          ip: getClientIp(req),
        },
      },
      { includeScreenshot: false },
    );

    pushNotification(req, {
      type: "success",
      message: req.t("account.security.success.passwordUpdated"),
    });

    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/setup",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const twoFactor = await loadTwoFactorStatus(sessionUser.id);
    if (twoFactor.enabled) {
      pushNotification(req, {
        type: "error",
        message: "La double authentification est déjà activée sur votre compte.",
      });
      return res.redirect("/account/security");
    }

    clearGeneratedRecoveryCodes(req);

    const settings = await getSiteSettings({ forceRefresh: false });
    const issuerName = settings?.wiki_name || "SimpleWiki";
    const secret = generateTwoFactorSecret();
    const accountLabel = `${issuerName}:${sessionUser.username}`;
    const otpauthUrl = buildTwoFactorProvisioningUri({
      secret,
      accountName: accountLabel,
      issuer: issuerName,
    });
    const qrDataUrl = await buildQrCodeDataUrl(otpauthUrl);
    const recoveryCodes = generateRecoveryCodes();

    setTwoFactorSetupSession(req, {
      secret,
      otpauthUrl,
      qrDataUrl,
      issuer: issuerName,
      recoveryCodes,
      createdAt: new Date().toISOString(),
    });

    pushNotification(req, {
      type: "info",
      message:
        "Scannez le QR code puis saisissez le code généré pour finaliser l'activation de la double authentification.",
    });

    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/enable",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const setup = getTwoFactorSetupSession(req);
    if (!setup || !setup.secret) {
      pushNotification(req, {
        type: "error",
        message:
          "Commencez par générer un secret avant de tenter d'activer la double authentification.",
      });
      return res.redirect("/account/security");
    }

    const token = typeof req.body.token === "string" ? req.body.token : "";
    if (!verifyTwoFactorToken(setup.secret, token)) {
      pushNotification(req, {
        type: "error",
        message: "Le code de vérification saisi est invalide. Réessayez.",
      });
      return res.redirect("/account/security");
    }

    const recoveryCodes = Array.isArray(setup.recoveryCodes) ? setup.recoveryCodes : [];
    const recoveryState = createRecoveryCodeState(recoveryCodes);
    const serializedRecoveryState =
      serializeRecoveryCodeState(recoveryState) ?? JSON.stringify([]);

    await rotateUserTotpSecret(sessionUser.id, setup.secret, { enable: true });
    await rotateUserRecoveryCodes(sessionUser.id, serializedRecoveryState);

    clearTwoFactorSetupSession(req);
    clearGeneratedRecoveryCodes(req);
    stashGeneratedRecoveryCodes(req, recoveryCodes);

    await sendAdminEvent(
      "Double authentification activée",
      {
        user: sessionUser.username,
        extra: {
          ip: getClientIp(req),
          method: "totp",
        },
      },
      { includeScreenshot: false },
    );

    const refreshedSessionUser = await loadSessionUserById(sessionUser.id);
    if (refreshedSessionUser) {
      req.session.user = refreshedSessionUser;
    }

    pushNotification(req, {
      type: "success",
      message: "La double authentification est maintenant activée.",
    });

    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/cancel-setup",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    clearTwoFactorSetupSession(req);
    clearGeneratedRecoveryCodes(req);
    pushNotification(req, {
      type: "info",
      message: "La configuration en cours a été annulée.",
    });
    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/disable",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const twoFactor = await loadTwoFactorStatus(sessionUser.id);
    if (!twoFactor.enabled) {
      pushNotification(req, {
        type: "error",
        message: "La double authentification est déjà désactivée.",
      });
      return res.redirect("/account/security");
    }

    const mode = typeof req.body.mode === "string" ? req.body.mode.toLowerCase() : "";
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const recoveryCode =
      typeof req.body.recoveryCode === "string" ? req.body.recoveryCode : "";
    const useRecovery = mode === "recovery" || recoveryCode.trim().length > 0;

    let method = "totp";

    if (useRecovery) {
      const { used } = markRecoveryCodeUsed(twoFactor.recoveryState, recoveryCode);
      if (!used) {
        pushNotification(req, {
          type: "error",
          message: "Ce code de récupération est invalide ou a déjà été utilisé.",
        });
        return res.redirect("/account/security");
      }
      method = "recovery-code";
    } else {
      if (!twoFactor.secret || !verifyTwoFactorToken(twoFactor.secret, token)) {
        pushNotification(req, {
          type: "error",
          message: "Le code TOTP fourni est invalide.",
        });
        return res.redirect("/account/security");
      }
    }

    await rotateUserTotpSecret(sessionUser.id, null, { enable: false });
    await rotateUserRecoveryCodes(sessionUser.id, null);

    clearTwoFactorSetupSession(req);
    clearGeneratedRecoveryCodes(req);

    await sendAdminEvent(
      "Double authentification désactivée",
      {
        user: sessionUser.username,
        extra: {
          ip: getClientIp(req),
          method,
        },
      },
      { includeScreenshot: false },
    );

    const refreshedSessionUser = await loadSessionUserById(sessionUser.id);
    if (refreshedSessionUser) {
      req.session.user = refreshedSessionUser;
    }

    pushNotification(req, {
      type: "success",
      message: "La double authentification a été désactivée.",
    });

    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/recovery-codes",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const twoFactor = await loadTwoFactorStatus(sessionUser.id);
    if (!twoFactor.enabled || !twoFactor.secret) {
      pushNotification(req, {
        type: "error",
        message:
          "Activez d'abord la double authentification avant de régénérer des codes de récupération.",
      });
      return res.redirect("/account/security");
    }

    const token = typeof req.body.token === "string" ? req.body.token : "";
    if (!verifyTwoFactorToken(twoFactor.secret, token)) {
      pushNotification(req, {
        type: "error",
        message: "Le code TOTP fourni est invalide.",
      });
      return res.redirect("/account/security");
    }

    const newCodes = generateRecoveryCodes();
    const newState = createRecoveryCodeState(newCodes);
    const serializedState = serializeRecoveryCodeState(newState) ?? JSON.stringify([]);

    await rotateUserRecoveryCodes(sessionUser.id, serializedState);

    clearGeneratedRecoveryCodes(req);
    stashGeneratedRecoveryCodes(req, newCodes);

    await sendAdminEvent(
      "Codes de récupération régénérés",
      {
        user: sessionUser.username,
        extra: {
          ip: getClientIp(req),
          total: newCodes.length,
        },
      },
      { includeScreenshot: false },
    );

    pushNotification(req, {
      type: "success",
      message: "Nouveaux codes de récupération générés.",
    });

    return res.redirect("/account/security");
  }),
);

r.post(
  "/security/passkeys/options",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const settings = await getSiteSettings({ forceRefresh: false });
    const existingCredentials = await listUserWebAuthnCredentials(sessionUser.id);

    try {
      const { options, challenge, config } = await createRegistrationOptions({
        req,
        user: sessionUser,
        existingCredentials,
        rpName: settings?.wiki_name || "SimpleWiki",
      });
      setRegistrationChallenge(req.session, {
        challenge,
        userId: sessionUser.id,
        rpID: config.rpID,
        origin: config.origin,
      });
      return res.json({
        ok: true,
        options,
        rp: { id: config.rpID, name: config.rpName },
      });
    } catch (error) {
      console.error("Unable to prepare WebAuthn registration", error);
      clearRegistrationChallenge(req.session);
      return res.status(500).json({
        ok: false,
        error: "Impossible de générer un défi WebAuthn pour le moment.",
      });
    }
  }),
);

r.post(
  "/security/passkeys/register",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const pending = getRegistrationChallenge(req.session);
    if (!pending || pending.userId !== sessionUser.id) {
      return res.status(400).json({
        ok: false,
        error: "Le défi d'enregistrement a expiré. Veuillez recommencer.",
      });
    }

    const credential = req.body?.credential;
    if (!credential || typeof credential !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Réponse WebAuthn invalide.",
      });
    }

    const rawLabel = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const friendlyName = rawLabel ? rawLabel.slice(0, 120) : null;

    try {
      const verification = await verifyRegistration({
        response: credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpID,
      });

      if (!verification?.verified || !verification.registrationInfo) {
        clearRegistrationChallenge(req.session);
        return res.status(400).json({
          ok: false,
          error: "La vérification de la passkey a échoué.",
        });
      }

      const { registrationInfo } = verification;
      const credentialInfo = registrationInfo.credential || {};
      const credentialId =
        (typeof credentialInfo.id === "string" && credentialInfo.id) ||
        toBase64Url(registrationInfo.credentialID);
      const publicKey =
        credentialInfo.publicKey || registrationInfo.credentialPublicKey;
      const counter =
        typeof credentialInfo.counter === "number"
          ? credentialInfo.counter
          : registrationInfo.counter || 0;
      const transports = Array.isArray(credentialInfo.transports)
        ? credentialInfo.transports
        : Array.isArray(credential?.response?.transports)
        ? credential.response.transports
        : [];

      await saveWebAuthnCredential({
        userId: sessionUser.id,
        credentialId,
        publicKey,
        counter,
        deviceType: registrationInfo.credentialDeviceType || null,
        backedUp: registrationInfo.credentialBackedUp || false,
        transports,
        friendlyName,
      });

      clearRegistrationChallenge(req.session);

      await sendAdminEvent(
        "Passkey enregistrée",
        {
          user: sessionUser.username,
          extra: {
            ip: getClientIp(req),
            credential: credentialId,
            label: friendlyName || undefined,
          },
        },
        { includeScreenshot: false },
      );

      return res.json({
        ok: true,
        credential: {
          id: credentialId,
          friendlyName: friendlyName || null,
        },
        notifications: [
          {
            type: "success",
            message: "Votre passkey a été enregistrée.",
          },
        ],
      });
    } catch (error) {
      console.error("Unable to verify WebAuthn registration", error);
      clearRegistrationChallenge(req.session);
      return res.status(500).json({
        ok: false,
        error: "Une erreur est survenue lors de la vérification de la passkey.",
      });
    }
  }),
);

r.post(
  "/security/passkeys/:credentialId/delete",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const credentialId = typeof req.params.credentialId === "string" ? req.params.credentialId : "";

    if (!credentialId) {
      pushNotification(req, {
        type: "error",
        message: "Identifiant de passkey invalide.",
      });
      return res.redirect("/account/security");
    }

    const deleted = await deleteUserWebAuthnCredential(sessionUser.id, credentialId);
    if (!deleted) {
      pushNotification(req, {
        type: "error",
        message: "Aucune passkey correspondante n'a été trouvée.",
      });
      return res.redirect("/account/security");
    }

    await sendAdminEvent(
      "Passkey supprimée",
      {
        user: sessionUser.username,
        extra: {
          ip: getClientIp(req),
          credential: credentialId,
        },
      },
      { includeScreenshot: false },
    );

    pushNotification(req, {
      type: "success",
      message: "La passkey a été supprimée.",
    });

    return res.redirect("/account/security");
  }),
);

r.get(
  "/security/recovery-codes/download",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const setup = getTwoFactorSetupSession(req);
    const codesSource = setup?.recoveryCodes || getGeneratedRecoveryCodes(req);
    if (!Array.isArray(codesSource) || codesSource.length === 0) {
      pushNotification(req, {
        type: "error",
        message: "Aucun code de récupération n'est disponible pour le téléchargement.",
      });
      return res.redirect("/account/security");
    }

    const lines = formatRecoveryCodesForDisplayList(codesSource);
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set(
      "Content-Disposition",
      "attachment; filename=\"codes-recuperation.txt\"",
    );
    res.send(`${lines.join("\n")}\n`);
  }),
);

r.post(
  "/security/recovery-codes/acknowledge",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    clearGeneratedRecoveryCodes(req);
    pushNotification(req, {
      type: "success",
      message: "Merci ! Pensez à conserver ces codes en lieu sûr.",
    });
    return res.redirect("/account/security");
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

    const avatarResult = normalizeMediaUrl(req.body.avatarUrl || "", {
      fieldName: "L'URL de l'avatar",
    });
    const bannerResult = normalizeMediaUrl(req.body.bannerUrl || "", {
      fieldName: "L'URL de la bannière",
    });

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
    const origin = getRequestOrigin(req);
    const { profilePublicUrl, linkedIpProfiles: decoratedProfiles, currentIpLink } =
      buildProfileLinks(origin, rawUsername || sessionUser.username, linkedIpProfiles, currentIpHash);

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
        linkedIpProfiles: decoratedProfiles,
        currentIpHash,
        currentIpLink,
        profilePublicUrl,
      });
    }

    let avatarUrl = avatarResult.value;
    let bannerUrl = bannerResult.value;

    if (removeAvatar) {
      avatarUrl = null;
    } else if (avatarFile) {
      avatarUrl = await finalizeProfileUpload(req, avatarFile);
    }

    if (removeBanner) {
      bannerUrl = null;
    } else if (bannerFile) {
      bannerUrl = await finalizeProfileUpload(req, bannerFile);
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
  "/premium/redeem",
  ensureAuthenticated,
  asyncHandler(async (req, res) => {
    const sessionUser = req.session.user;
    const rawCode = typeof req.body.code === "string" ? req.body.code.trim() : "";
    if (!rawCode) {
      pushNotification(req, {
        type: "error",
        message: "Veuillez renseigner un code premium valide.",
      });
      return res.redirect("/account/profile");
    }
    try {
      const redemption = await redeemPremiumCodeForUser({
        code: rawCode,
        userId: sessionUser.id,
      });
      const refreshed = await loadSessionUserById(sessionUser.id);
      if (refreshed) {
        req.session.user = refreshed;
      } else {
        req.session.user = null;
      }
      const expiresAtFormatted = formatDateTimeLocalized(redemption.expiresAt, req.lang);
      pushNotification(req, {
        type: "success",
        message: `Votre accès premium est actif jusqu'au ${expiresAtFormatted}.`,
      });
      await sendAdminEvent(
        "Code premium utilisé",
        {
          user: sessionUser.username,
          extra: {
            code: redemption.code.code,
            expiresAt: redemption.expiresAt.toISOString(),
          },
        },
        { includeScreenshot: false },
      );
      return res.redirect("/account/profile");
    } catch (error) {
      if (error instanceof PremiumCodeError) {
        pushNotification(req, {
          type: "error",
          message: error.message,
        });
        return res.redirect("/account/profile");
      }
      console.error("Unable to redeem premium code", error);
      pushNotification(req, {
        type: "error",
        message: "Impossible d'activer ce code premium pour le moment.",
      });
      return res.redirect("/account/profile");
    }
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
