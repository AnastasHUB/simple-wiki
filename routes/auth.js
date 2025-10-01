import { Router } from "express";
import { get, run } from "../db.js";
import { hashPassword, isBcryptHash, verifyPassword } from "../utils/passwords.js";
import { sendAdminEvent } from "../utils/webhook.js";
import { getClientIp } from "../utils/ip.js";
import { pushNotification } from "../utils/notifications.js";

const r = Router();

r.get("/login", (req, res) => res.render("login"));
r.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const ip = getClientIp(req);
  const u = await get("SELECT * FROM users WHERE username=?", [username]);
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
  const isAdmin = !!u.is_admin;
  const isModerator = !isAdmin && !!u.is_moderator;
  const isContributor = !isAdmin && !isModerator && !!u.is_contributor;
  const isHelper =
    !isAdmin && !isModerator && !isContributor && !!u.is_helper;

  const desiredAdmin = isAdmin ? 1 : 0;
  const desiredModerator = isModerator ? 1 : 0;
  const desiredContributor = isContributor ? 1 : 0;
  const desiredHelper = isHelper ? 1 : 0;

  if (
    u.is_admin !== desiredAdmin ||
    u.is_moderator !== desiredModerator ||
    u.is_contributor !== desiredContributor ||
    u.is_helper !== desiredHelper
  ) {
    await run(
      "UPDATE users SET is_admin=?, is_moderator=?, is_contributor=?, is_helper=? WHERE id=?",
      [
        desiredAdmin,
        desiredModerator,
        desiredContributor,
        desiredHelper,
        u.id,
      ],
    );
  }

  req.session.user = {
    id: u.id,
    username: u.username,
    is_admin: isAdmin,
    is_moderator: isModerator,
    is_contributor: isContributor,
    is_helper: isHelper,
    display_name: u.display_name || null,
  };
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
