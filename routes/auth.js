import { Router } from "express";
import { get, run, rotateUserRecoveryCodes } from "../db.js";
import {
  hashPassword,
  isBcryptHash,
  verifyPassword,
} from "../utils/passwords.js";
import { sendAdminEvent } from "../utils/webhook.js";
import { getClientIp } from "../utils/ip.js";
import { pushNotification } from "../utils/notifications.js";
import {
  ROLE_FLAG_FIELDS,
  buildSessionUser,
  deriveRoleFlags,
  getRoleFlagValues,
  needsRoleFlagSync,
} from "../utils/roleFlags.js";
import { assignRoleToUser, getEveryoneRole, getRolesForUser } from "../utils/roleService.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  createCaptchaChallenge,
  describeCaptcha,
} from "../utils/captcha.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { validateRegistrationSubmission } from "../utils/registrationValidation.js";
import { evaluateUserAchievements } from "../utils/achievementService.js";
import {
  verifyTwoFactorToken,
  parseRecoveryCodeState,
  markRecoveryCodeUsed,
  serializeRecoveryCodeState,
  countAvailableRecoveryCodes,
} from "../utils/twoFactor.js";
import { getSiteSettings } from "../utils/settingsService.js";
import {
  listUserWebAuthnCredentials,
  findWebAuthnCredential,
  createAuthenticationOptions,
  verifyAuthentication,
  setAuthenticationChallenge,
  getAuthenticationChallenge,
  clearAuthenticationChallenge,
  touchWebAuthnCredential,
} from "../utils/webauthn.js";

const ROLE_FIELD_SELECT = ROLE_FLAG_FIELDS.map(
  (field) => `r.${field} AS role_${field}`,
).join(", ");
const USER_FLAG_UPDATE_ASSIGNMENTS = ROLE_FLAG_FIELDS.map(
  (field) => `${field}=?`,
).join(", ");
const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_FLAG_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");

const r = Router();

const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message:
    "Trop de tentatives de connexion ont été détectées. Merci de patienter avant de réessayer.",
});

const registerRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message:
    "Trop de tentatives d'inscription successives ont été détectées. Réessayez plus tard.",
});

const twoFactorRateLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 5,
  message:
    "Trop de codes invalides ont été saisis. Merci de patienter avant de réessayer.",
});

const AUTH_USER_SELECT = `
  SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
`;

async function fetchAuthUserByUsername(username) {
  if (!username) {
    return null;
  }
  return get(`${AUTH_USER_SELECT} WHERE u.username=?`, [username]);
}

async function fetchAuthUserById(id) {
  if (!id) {
    return null;
  }
  return get(`${AUTH_USER_SELECT} WHERE u.id=?`, [id]);
}

function ensurePendingTwoFactor(req, res, next) {
  if (req?.session?.pendingTwoFactor?.userId) {
    return next();
  }
  return res.redirect("/login");
}

async function finalizeLogin(
  req,
  res,
  user,
  { ip = null, twoFactorMethod = null, responseType = "redirect" } = {},
) {
  if (!user) {
    return res.redirect("/login");
  }

  const flags = deriveRoleFlags(user);
  await evaluateUserAchievements(user.id);
  if (needsRoleFlagSync(user)) {
    await run(
      `UPDATE users SET ${USER_FLAG_UPDATE_ASSIGNMENTS} WHERE id=?`,
      [...getRoleFlagValues(flags), user.id],
    );
  }

  const assignedRoles = await getRolesForUser(user.id);

  req.session.user = buildSessionUser({ ...user, roles: assignedRoles }, flags);

  const detectedIp = ip || getClientIp(req);
  const extra = detectedIp ? { ip: detectedIp } : {};
  if (twoFactorMethod) {
    extra.twoFactor = twoFactorMethod;
  }

  await sendAdminEvent(
    "Connexion réussie",
    {
      user: user.username,
      extra,
    },
    { includeScreenshot: false },
  );

  pushNotification(req, {
    type: "success",
    message: `Bon retour parmi nous, ${user.username} !`,
  });

  if (responseType === "json") {
    return res.json({
      ok: true,
      redirect: "/",
      twoFactorMethod: twoFactorMethod || null,
    });
  }

  return res.redirect("/");
}

r.get("/login", (req, res) => res.render("login"));
r.get("/register", (req, res) => {
  const captcha = createCaptchaChallenge(req);
  if (!captcha) {
    return res
      .status(503)
      .render("register", { registrationDisabled: true, captcha: null });
  }
  res.render("register", { captcha });
});
r.post("/login", loginRateLimiter, async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const u = await fetchAuthUserByUsername(username);
  if (!u) {
    await sendAdminEvent(
      "Connexion échouée",
      {
        user: username,
        extra: {
          ip,
          reason: "Utilisateur inconnu",
        },
      },
      { includeScreenshot: false },
    );
    return res.render("login", { error: "Identifiants invalides" });
  }
  const storedHash = u.password;
  const ok = await verifyPassword(password, storedHash);
  if (!ok) {
    await sendAdminEvent(
      "Connexion échouée",
      {
        user: username,
        extra: {
          ip,
          reason: "Mot de passe invalide",
        },
      },
      { includeScreenshot: false },
    );
    return res.render("login", { error: "Identifiants invalides" });
  }
  if (u.is_banned) {
    const reasonText = u.ban_reason
      ? `Votre compte est suspendu : ${u.ban_reason}`
      : "Votre compte a été suspendu.";
    const bannedInfo = {
      reason: u.ban_reason || null,
      bannedAt: u.banned_at || null,
    };
    req.session.bannedAccountInfo = bannedInfo;
    res.locals.bannedAccountInfo = bannedInfo;
    pushNotification(req, {
      type: "error",
      message: reasonText,
      timeout: 7000,
    });
    await sendAdminEvent(
      "Connexion bloquée (compte banni)",
      {
        user: username,
        extra: {
          ip,
          reason: u.ban_reason || null,
        },
      },
      { includeScreenshot: false },
    );
    return res.status(403).render("login", {
      error: "Ce compte est actuellement suspendu.",
    });
  }
  if (!isBcryptHash(storedHash)) {
    const newHash = await hashPassword(password);
    await run("UPDATE users SET password=? WHERE id=?", [newHash, u.id]);
  }
  if (u.two_factor_enabled) {
    req.session.pendingTwoFactor = {
      userId: u.id,
      username: u.username,
      ip,
    };
    req.session.twoFactorState = null;
    return res.redirect("/login/two-factor");
  }

  return finalizeLogin(req, res, u, { ip });
});

r.post("/login/passkey/options", loginRateLimiter, async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) {
    return res.status(400).json({
      ok: false,
      error: "Veuillez saisir votre nom d'utilisateur.",
    });
  }

  const user = await fetchAuthUserByUsername(username);
  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "Utilisateur introuvable.",
    });
  }

  const credentials = await listUserWebAuthnCredentials(user.id);
  if (credentials.length === 0) {
    return res.status(404).json({
      ok: false,
      error: "Aucune passkey n'est associée à ce compte.",
    });
  }

  const settings = await getSiteSettings({ forceRefresh: false });

  try {
    const { options, challenge, config } = await createAuthenticationOptions({
      req,
      allowCredentials: credentials,
      rpName: settings?.wiki_name || "SimpleWiki",
    });
    setAuthenticationChallenge(req.session, {
      challenge,
      userId: user.id,
      username: user.username,
      rpID: config.rpID,
      origin: config.origin,
    });
    return res.json({
      ok: true,
      options,
      user: { username: user.username },
      rp: { id: config.rpID, name: config.rpName },
    });
  } catch (error) {
    console.error("Unable to prepare WebAuthn authentication", error);
    clearAuthenticationChallenge(req.session);
    return res.status(500).json({
      ok: false,
      error: "Impossible de générer un défi WebAuthn pour le moment.",
    });
  }
});

r.post("/login/passkey/verify", loginRateLimiter, async (req, res) => {
  const pending = getAuthenticationChallenge(req.session);
  if (!pending || !pending.challenge) {
    return res.status(400).json({
      ok: false,
      error: "Le défi WebAuthn a expiré. Veuillez recommencer.",
    });
  }

  const credential = req.body?.credential;
  if (!credential || typeof credential !== "object") {
    return res.status(400).json({
      ok: false,
      error: "Réponse WebAuthn invalide.",
    });
  }

  const credentialId = typeof credential.id === "string" ? credential.id : null;
  if (!credentialId) {
    return res.status(400).json({
      ok: false,
      error: "Identifiant de credential manquant.",
    });
  }

  try {
    const dbCredential = await findWebAuthnCredential(credentialId);
    if (!dbCredential) {
      clearAuthenticationChallenge(req.session);
      return res.status(404).json({
        ok: false,
        error: "Cette passkey n'est pas reconnue.",
      });
    }

    if (pending.userId && pending.userId !== dbCredential.userId) {
      clearAuthenticationChallenge(req.session);
      return res.status(400).json({
        ok: false,
        error: "La passkey ne correspond pas à ce compte.",
      });
    }

    const verification = await verifyAuthentication({
      response: credential,
      authenticator: dbCredential,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
    });

    if (!verification?.verified || !verification.authenticationInfo) {
      clearAuthenticationChallenge(req.session);
      return res.status(400).json({
        ok: false,
        error: "La vérification de la passkey a échoué.",
      });
    }

    const { authenticationInfo } = verification;
    await touchWebAuthnCredential(dbCredential.credentialId, {
      counter: authenticationInfo.newCounter ?? dbCredential.counter,
      deviceType: authenticationInfo.credentialDeviceType || dbCredential.deviceType || null,
      backedUp:
        typeof authenticationInfo.credentialBackedUp === "boolean"
          ? authenticationInfo.credentialBackedUp
          : dbCredential.backedUp,
    });

    const user = await fetchAuthUserById(dbCredential.userId);
    if (!user) {
      clearAuthenticationChallenge(req.session);
      return res.status(404).json({
        ok: false,
        error: "Utilisateur introuvable.",
      });
    }
    if (user.is_banned) {
      clearAuthenticationChallenge(req.session);
      return res.status(403).json({
        ok: false,
        error: "Ce compte est actuellement suspendu.",
      });
    }

    clearAuthenticationChallenge(req.session);
    req.session.pendingTwoFactor = null;
    req.session.twoFactorState = null;

    return finalizeLogin(req, res, user, {
      ip: getClientIp(req),
      twoFactorMethod: "passkey",
      responseType: "json",
    });
  } catch (error) {
    console.error("Unable to verify WebAuthn authentication", error);
    clearAuthenticationChallenge(req.session);
    return res.status(500).json({
      ok: false,
      error: "Une erreur est survenue lors de la vérification de la passkey.",
    });
  }
});

r.get("/login/two-factor", ensurePendingTwoFactor, async (req, res) => {
  const pending = req.session.pendingTwoFactor;
  if (!pending) {
    return res.redirect("/login");
  }

  const user = await fetchAuthUserById(pending.userId);
  if (!user) {
    req.session.pendingTwoFactor = null;
    return res.redirect("/login");
  }

  const recoveryState = parseRecoveryCodeState(user.recovery_codes);
  const remainingRecoveryCodes = countAvailableRecoveryCodes(recoveryState);

  const sessionState = req.session.twoFactorState || {};
  const forcedRecoveryMode =
    typeof req.query.mode === "string" && req.query.mode.toLowerCase() === "recovery";

  const recoveryMode = forcedRecoveryMode || sessionState.recoveryMode === true;
  const error = sessionState.error || null;

  req.session.twoFactorState = null;

  return res.render("login-twofactor", {
    username: pending.username,
    error,
    recoveryMode,
    remainingRecoveryCodes,
  });
});

r.post(
  "/login/two-factor",
  twoFactorRateLimiter,
  ensurePendingTwoFactor,
  async (req, res) => {
    const pending = req.session.pendingTwoFactor;
    if (!pending) {
      return res.redirect("/login");
    }

    const user = await fetchAuthUserById(pending.userId);
    if (!user) {
      req.session.pendingTwoFactor = null;
      return res.redirect("/login");
    }

    if (!user.two_factor_enabled || !user.totp_secret) {
      req.session.pendingTwoFactor = null;
      req.session.twoFactorState = null;
      return finalizeLogin(req, res, user, { ip: pending.ip });
    }

    const mode = typeof req.body.mode === "string" ? req.body.mode.toLowerCase() : "";
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const recoveryCode =
      typeof req.body.recoveryCode === "string" ? req.body.recoveryCode : "";
    const useRecovery = mode === "recovery" || recoveryCode.trim().length > 0;

    if (useRecovery) {
      const recoveryState = parseRecoveryCodeState(user.recovery_codes);
      const { updated, used } = markRecoveryCodeUsed(recoveryState, recoveryCode);
      if (!used) {
        req.session.twoFactorState = {
          error: "Code de récupération invalide ou déjà utilisé.",
          recoveryMode: true,
        };
        return res.redirect("/login/two-factor");
      }

      await rotateUserRecoveryCodes(user.id, serializeRecoveryCodeState(updated));
      req.session.pendingTwoFactor = null;
      req.session.twoFactorState = null;
      return finalizeLogin(req, res, user, {
        ip: pending.ip,
        twoFactorMethod: "recovery-code",
      });
    }

    const valid = verifyTwoFactorToken(user.totp_secret, token);
    if (!valid) {
      req.session.twoFactorState = {
        error: "Code de vérification invalide.",
        recoveryMode: false,
      };
      return res.redirect("/login/two-factor");
    }

    req.session.pendingTwoFactor = null;
    req.session.twoFactorState = null;
    return finalizeLogin(req, res, user, {
      ip: pending.ip,
      twoFactorMethod: "totp",
    });
  },
);
r.post("/register", registerRateLimiter, async (req, res, next) => {
  const { username, password } = req.body;
  const captchaToken =
    typeof req.body.captchaToken === "string" ? req.body.captchaToken : "";
  const captchaAnswer =
    typeof req.body.captcha === "string" ? req.body.captcha : "";
  const validation = await validateRegistrationSubmission({
    req,
    username,
    password,
    captchaToken,
    captchaAnswer,
  });

  if (validation.captchaMissing) {
    return res.status(503).render("register", {
      registrationDisabled: true,
      captcha: validation.captcha,
    });
  }

  if (validation.errors.length) {
    return res.status(400).render("register", {
      errors: validation.errors,
      captcha: validation.captcha,
      values: { username: validation.sanitizedUsername },
    });
  }

  const sanitizedUsername = validation.sanitizedUsername;
  const passwordValue = validation.passwordValue;
  const captcha = validation.captcha;

  const everyoneRole = await getEveryoneRole();
  const roleId = everyoneRole?.numeric_id || null;
  const roleFlagValues = ROLE_FLAG_FIELDS.map((field) =>
    everyoneRole && everyoneRole[field] ? 1 : 0,
  );
  const hashedPassword = await hashPassword(passwordValue);
  const ip = getClientIp(req);
  const displayName = sanitizedUsername;
  let createdUser;
  try {
    const result = await run(
      `INSERT INTO users(snowflake_id, username, password, display_name, role_id, ${ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?,?,?,${ROLE_FLAG_PLACEHOLDERS})`,
      [
        generateSnowflake(),
        sanitizedUsername,
        hashedPassword,
        displayName,
        roleId,
        ...roleFlagValues,
      ],
    );

    await assignRoleToUser(result.lastID, everyoneRole ? [everyoneRole] : []);

    createdUser = await get(
      `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id=?`,
      [result.lastID],
    );
  } catch (err) {
    if (err?.code === "SQLITE_CONSTRAINT" || err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).render("register", {
        errors: ["Ce nom d'utilisateur est déjà utilisé."],
        captcha,
        values: { username: sanitizedUsername },
      });
    }
    return next(err);
  }

  const flags = deriveRoleFlags(createdUser);
  const assignedRoles = await getRolesForUser(createdUser.id);
  await evaluateUserAchievements(createdUser.id);
  req.session.user = buildSessionUser({ ...createdUser, roles: assignedRoles }, flags);
  const providerDescription = describeCaptcha();
  await sendAdminEvent(
    "Nouvelle inscription",
    {
      user: sanitizedUsername,
      extra: {
        ip,
        captchaProvider: providerDescription?.id || captcha.id,
        captchaLabel: providerDescription?.label || captcha.label,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: `Bienvenue, ${sanitizedUsername} ! Votre compte est prêt à l'emploi.`,
  });
  res.redirect("/");
});
r.post("/logout", async (req, res) => {
  const username = req.session?.user?.username || null;
  const ip = getClientIp(req);
  await sendAdminEvent(
    "Déconnexion",
    {
      user: username,
      extra: {
        ip,
      },
    },
    { includeScreenshot: false },
  );
  req.session.destroy(() => res.redirect("/"));
});

export default r;
