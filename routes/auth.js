import { Router } from "express";
import { get, run } from "../db.js";
import { hashPassword, isBcryptHash, verifyPassword } from "../utils/passwords.js";

const r = Router();

r.get("/login", (req, res) => res.render("login"));
r.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const u = await get("SELECT * FROM users WHERE username=?", [username]);
  if (!u) return res.render("login", { error: "Identifiants invalides" });
  const storedHash = u.password;
  const ok = await verifyPassword(password, storedHash);
  if (!ok) return res.render("login", { error: "Identifiants invalides" });
  if (!isBcryptHash(storedHash)) {
    const newHash = await hashPassword(password);
    await run("UPDATE users SET password=? WHERE id=?", [newHash, u.id]);
  }
  req.session.user = { id: u.id, username: u.username, is_admin: !!u.is_admin };
  res.redirect("/");
});
r.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

export default r;
