import { Router } from "express";
import { get, run } from "../db.js";
import { hashPassword, isBcryptHash, verifyPassword } from "../utils/passwords.js";
import { sendAdminEvent } from "../utils/webhook.js";
import { getClientIp } from "../utils/ip.js";
import { pushNotification } from "../utils/notifications.js";
import {
  buildSessionUser,
  deriveRoleFlags,
  getRoleFlagValues,
  needsRoleFlagSync,
} from "../utils/roleFlags.js";

const r = Router();

r.get("/login", (req, res) => res.render("login"));
r.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const u = await get(
    `SELECT u.*, r.name AS role_name, r.is_admin AS role_is_admin, r.is_moderator AS role_is_moderator,
            r.is_helper AS role_is_helper, r.is_contributor AS role_is_contributor,
            r.can_comment AS role_can_comment, r.can_submit_pages AS role_can_submit_pages
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
      "UPDATE users SET is_admin=?, is_moderator=?, is_helper=?, is_contributor=?, can_comment=?, can_submit_pages=? WHERE id=?",
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
