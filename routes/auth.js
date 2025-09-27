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
  req.session.user = { id: u.id, username: u.username, is_admin: !!u.is_admin };
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
