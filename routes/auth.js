import { Router } from "express";
import { get, run } from "../db.js";
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
import { getEveryoneRole } from "../utils/roleService.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  createCaptchaChallenge,
  describeCaptcha,
} from "../utils/captcha.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { validateRegistrationSubmission } from "../utils/registrationValidation.js";
import { evaluateUserAchievements } from "../utils/achievementService.js";

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
  const u = await get(
    `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.username=?`,
    [username],
  );
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
  const flags = deriveRoleFlags(u);
  await evaluateUserAchievements(u.id);
  if (needsRoleFlagSync(u)) {
    await run(
      `UPDATE users SET ${USER_FLAG_UPDATE_ASSIGNMENTS} WHERE id=?`,
      [...getRoleFlagValues(flags), u.id],
    );
  }

  req.session.user = buildSessionUser(u, flags);
  await sendAdminEvent(
    "Connexion réussie",
    {
      user: u.username,
      extra: {
        ip,
      },
    },
    { includeScreenshot: false },
  );
  pushNotification(req, {
    type: "success",
    message: `Bon retour parmi nous, ${u.username} !`,
  });
  res.redirect("/");
});
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
  await evaluateUserAchievements(createdUser.id);
  req.session.user = buildSessionUser(createdUser, flags);
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
