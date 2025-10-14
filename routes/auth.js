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
  describeCaptchaProvider,
  getEnabledCaptchaProviders,
  verifyCaptchaResponse,
} from "../utils/captcha.js";

const ROLE_FIELD_SELECT = ROLE_FLAG_FIELDS.map(
  (field) => `r.${field} AS role_${field}`,
).join(", ");
const USER_FLAG_UPDATE_ASSIGNMENTS = ROLE_FLAG_FIELDS.map(
  (field) => `${field}=?`,
).join(", ");
const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_FLAG_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");

const r = Router();

r.get("/login", (req, res) => res.render("login"));
r.get("/register", (req, res) => {
  const captchaOptions = getEnabledCaptchaProviders().map((option, index) => ({
    ...option,
    selected: index === 0,
  }));
  if (!captchaOptions.length) {
    return res
      .status(503)
      .render("register", { registrationDisabled: true, captchaOptions });
  }
  res.render("register", { captchaOptions });
});
r.post("/login", async (req, res) => {
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
  if (!isBcryptHash(storedHash)) {
    const newHash = await hashPassword(password);
    await run("UPDATE users SET password=? WHERE id=?", [newHash, u.id]);
  }
  const flags = deriveRoleFlags(u);
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
r.post("/register", async (req, res) => {
  const availableProviders = getEnabledCaptchaProviders();
  const { username, password } = req.body;
  const selectedProviderId =
    typeof req.body.captchaProvider === "string"
      ? req.body.captchaProvider
      : "";
  const captchaToken =
    typeof req.body.captchaToken === "string" ? req.body.captchaToken : "";
  const sanitizedUsername = typeof username === "string" ? username.trim() : "";
  const errors = [];
  const captchaOptions = availableProviders.map((option) => ({
    ...option,
    selected: option.id === selectedProviderId,
  }));

  if (!availableProviders.length) {
    return res.status(503).render("register", {
      registrationDisabled: true,
      captchaOptions,
    });
  }

  if (!sanitizedUsername) {
    errors.push("Veuillez indiquer un nom d'utilisateur.");
  } else if (sanitizedUsername.length < 3 || sanitizedUsername.length > 32) {
    errors.push(
      "Le nom d'utilisateur doit contenir entre 3 et 32 caractères.",
    );
  } else if (!/^[A-Za-z0-9_.-]+$/.test(sanitizedUsername)) {
    errors.push(
      "Le nom d'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores.",
    );
  }

  const passwordValue = typeof password === "string" ? password : "";
  if (!passwordValue) {
    errors.push("Veuillez indiquer un mot de passe.");
  } else if (passwordValue.length < 8) {
    errors.push("Le mot de passe doit contenir au moins 8 caractères.");
  }

  const provider = availableProviders.find(
    (option) => option.id === selectedProviderId,
  );
  if (!provider) {
    errors.push("Veuillez sélectionner un captcha valide.");
  }

  let captchaResult = { success: false, errorCodes: [] };
  if (provider) {
    captchaResult = await verifyCaptchaResponse(provider.id, captchaToken, {
      remoteIp: getClientIp(req),
    });
    if (!captchaResult.success) {
      const codes = captchaResult.errorCodes.length
        ? ` (${captchaResult.errorCodes.join(", ")})`
        : "";
      errors.push(`La vérification du captcha a échoué${codes}.`);
    }
  }

  if (!errors.length) {
    const existing = await get(
      "SELECT 1 FROM users WHERE username=? COLLATE NOCASE",
      [sanitizedUsername],
    );
    if (existing) {
      errors.push("Ce nom d'utilisateur est déjà utilisé.");
    }
  }

  if (errors.length) {
    return res.status(400).render("register", {
      errors,
      captchaOptions,
      values: { username: sanitizedUsername },
    });
  }

  const everyoneRole = await getEveryoneRole();
  const roleId = everyoneRole?.numeric_id || null;
  const roleFlagValues = ROLE_FLAG_FIELDS.map((field) =>
    everyoneRole && everyoneRole[field] ? 1 : 0,
  );
  const hashedPassword = await hashPassword(passwordValue);
  const ip = getClientIp(req);
  const displayName = sanitizedUsername;
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

  const createdUser = await get(
    `SELECT u.*, r.name AS role_name, r.snowflake_id AS role_snowflake_id, r.color AS role_color, ${ROLE_FIELD_SELECT}
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.id=?`,
    [result.lastID],
  );

  const flags = deriveRoleFlags(createdUser);
  req.session.user = buildSessionUser(createdUser, flags);
  const providerDescription = describeCaptchaProvider(provider.id);
  await sendAdminEvent(
    "Nouvelle inscription",
    {
      user: sanitizedUsername,
      extra: {
        ip,
        captchaProvider: providerDescription?.id || provider.id,
        captchaLabel: providerDescription?.label || provider.id,
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
