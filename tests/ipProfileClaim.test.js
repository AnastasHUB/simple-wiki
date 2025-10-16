import test from "node:test";
import assert from "node:assert/strict";

import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { touchIpProfile } from "../utils/ipProfiles.js";
import { createCaptchaChallenge } from "../utils/captcha.js";
import { hashPassword } from "../utils/passwords.js";

function findRouteHandlers(path, method = "post") {
  const lowerMethod = method.toLowerCase();
  const layer = pagesRouter.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[lowerMethod]);
  });
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} introuvable`);
  }
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

function createResponseRecorder(onDone) {
  const headers = new Map();
  const res = {
    statusCode: 200,
    headers,
    locals: {},
  };

  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };

  res.set = function set(name, value) {
    headers.set(String(name).toLowerCase(), value);
    return this;
  };

  res.get = function getHeader(name) {
    return headers.get(String(name).toLowerCase());
  };

  res.render = function render(view, data) {
    this.renderedView = view;
    this.renderedData = data;
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };

  res.redirect = function redirect(url) {
    if (typeof url === "number") {
      this.statusCode = url;
      return this;
    }
    if (this.statusCode === 200) {
      this.statusCode = 302;
    }
    this.redirectedTo = url;
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };

  res.send = function send(payload) {
    this.body = payload;
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };

  return res;
}

function dispatchHandler(handler, req) {
  return new Promise((resolve, reject) => {
    let recorder;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(recorder);
    };
    recorder = createResponseRecorder(finish);
    try {
      handler(req, recorder, (err) => {
        if (err) {
          settled = true;
          reject(err);
          return;
        }
        finish();
      });
    } catch (err) {
      settled = true;
      reject(err);
    }
  });
}

function buildClaimRequest({ hash, ip, body = {} }) {
  return {
    method: "POST",
    params: { hash },
    body,
    clientIp: ip,
    clientUserAgent: "test-agent",
    session: {},
    locals: {},
  };
}

function attachCaptcha(req) {
  const challenge = createCaptchaChallenge(req);
  if (!challenge) {
    throw new Error("Le captcha devrait être disponible pour les tests");
  }
  const answer = req.session.captchaChallenges?.[challenge.token]?.answer || "";
  return { challenge, answer };
}

const claimHandlers = findRouteHandlers("/profiles/ip/:hash/claim", "post");
const claimPostHandler = claimHandlers.at(-1);

if (!claimPostHandler) {
  throw new Error("Impossible de localiser le gestionnaire POST de conversion IP → compte");
}

const profileGetHandlers = findRouteHandlers("/profiles/ip/:hash", "get");
const profileGetHandler = profileGetHandlers.at(-1);

if (!profileGetHandler) {
  throw new Error("Impossible de localiser le gestionnaire GET du profil IP");
}

test("le rôle Utilisateurs est configuré avec les permissions de base", { concurrency: false }, async () => {
  await initDb();
  const everyone = await get(
    "SELECT can_comment, can_submit_pages FROM roles WHERE name=?",
    ["Everyone"],
  );
  const usersRole = await get(
    "SELECT name, can_comment, can_submit_pages FROM roles WHERE name=?",
    ["Utilisateurs"],
  );
  assert.ok(usersRole, "Le rôle Utilisateurs devrait exister");
  assert.equal(usersRole.name, "Utilisateurs");
  assert.equal(usersRole.can_comment, everyone?.can_comment);
  assert.equal(usersRole.can_submit_pages, everyone?.can_submit_pages);
});

test("un profil IP peut être converti en compte utilisateur", { concurrency: false }, async () => {
  await initDb();
  const ip = "203.0.113.42";
  const profile = await touchIpProfile(ip, { skipRefresh: true });
  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );
  const username = `convert-${Date.now()}`;
  const request = buildClaimRequest({
    hash: profile.hash,
    ip,
    body: {
      username,
      password: "MotdepasseUltraSecurise",
      captchaToken: "",
      captcha: "",
    },
  });

  const { challenge, answer } = attachCaptcha(request);
  request.body.captchaToken = challenge.token;
  request.body.captcha = answer;

  const response = await dispatchHandler(claimPostHandler, request);
  assert.equal(response.statusCode, 302);
  assert.equal(response.redirectedTo, "/");

  const createdUser = await get(
    "SELECT id, username, role_id FROM users WHERE username=?",
    [username],
  );
  assert.ok(createdUser, "Un utilisateur doit être créé");

  const roleRow = await get("SELECT name FROM roles WHERE id=?", [createdUser.role_id]);
  assert.equal(roleRow?.name, "Utilisateurs");

  const claimedProfile = await get(
    "SELECT claimed_user_id, claimed_at FROM ip_profiles WHERE hash=?",
    [profile.hash],
  );
  assert.equal(claimedProfile?.claimed_user_id, createdUser.id);
  assert.ok(claimedProfile?.claimed_at, "La date de revendication doit être renseignée");

  assert.equal(request.session.user?.username, username);

  // Nettoyage
  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );
  await run("DELETE FROM users WHERE id=?", [createdUser.id]);
});

test("un utilisateur connecté peut associer un second profil IP", { concurrency: false }, async () => {
  await initDb();

  const ip = "198.51.100.101";
  const profile = await touchIpProfile(ip, { skipRefresh: true });
  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );

  const hashedPassword = await hashPassword("MotdepasseUltraSecurise");
  const usersRole = await get("SELECT id FROM roles WHERE name=?", ["Utilisateurs"]);
  const now = Date.now();
  const username = `multi-${now}`;
  const insertedUser = await run(
    "INSERT INTO users(snowflake_id, username, password, role_id) VALUES(?,?,?,?)",
    [String(now), username, hashedPassword, usersRole?.id || null],
  );

  const request = buildClaimRequest({
    hash: profile.hash,
    ip,
    body: { mode: "link" },
  });
  request.session.user = {
    id: insertedUser.lastID,
    username,
    display_name: username,
  };

  const response = await dispatchHandler(claimPostHandler, request);
  assert.equal(response.statusCode, 302);
  assert.equal(response.redirectedTo, `/profiles/ip/${profile.hash}`);

  const claimedProfile = await get(
    "SELECT claimed_user_id, claimed_at FROM ip_profiles WHERE hash=?",
    [profile.hash],
  );
  assert.equal(claimedProfile?.claimed_user_id, insertedUser.lastID);
  assert.ok(claimedProfile?.claimed_at, "La date de revendication doit être renseignée");

  assert.ok(
    Array.isArray(request.session.notifications) &&
      request.session.notifications.some((note) =>
        typeof note?.message === "string" &&
        note.message.includes("désormais associé"),
      ),
    "Une notification de réussite doit être enregistrée",
  );

  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );
  await run("DELETE FROM users WHERE id=?", [insertedUser.lastID]);
});

test("le propriétaire déconnecté d'un profil revendiqué est redirigé vers la connexion", { concurrency: false }, async () => {
  await initDb();

  const ip = "198.51.100.200";
  const profile = await touchIpProfile(ip, { skipRefresh: true });
  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );

  const hashedPassword = await hashPassword("MotdepasseUltraSecurise");
  const usersRole = await get("SELECT id FROM roles WHERE name=?", ["Utilisateurs"]);
  const insertedUser = await run(
    "INSERT INTO users(snowflake_id, username, password, role_id) VALUES(?,?,?,?)",
    [
      String(Date.now()),
      `owner-${Date.now()}`,
      hashedPassword,
      usersRole?.id || null,
    ],
  );

  await run(
    "UPDATE ip_profiles SET claimed_user_id=?, claimed_at=CURRENT_TIMESTAMP WHERE hash=?",
    [insertedUser.lastID, profile.hash],
  );

  const request = {
    method: "GET",
    params: { hash: profile.hash },
    clientIp: ip,
    clientUserAgent: "test-agent",
    session: {},
    locals: {},
  };

  const response = await dispatchHandler(profileGetHandler, request);
  assert.equal(response.statusCode, 302);
  assert.equal(response.redirectedTo, "/login");
  assert.ok(
    Array.isArray(request.session.notifications) && request.session.notifications.length > 0,
    "Une notification de connexion doit être enregistrée",
  );
  assert.ok(
    request.session.notifications.some((note) =>
      typeof note?.message === "string" && note.message.includes("Connectez-vous"),
    ),
    "La notification doit inviter l'utilisateur à se connecter",
  );
});

test("la conversion est refusée si le hash ne correspond pas à l'adresse IP", { concurrency: false }, async () => {
  await initDb();
  const ip = "198.51.100.77";
  const profile = await touchIpProfile(ip, { skipRefresh: true });
  const request = buildClaimRequest({
    hash: profile.hash,
    ip: "203.0.113.10",
    body: {
      username: `refus-${Date.now()}`,
      password: "MotdepasseUltraSecurise",
      captchaToken: "",
      captcha: "",
    },
  });

  const { challenge, answer } = attachCaptcha(request);
  request.body.captchaToken = challenge.token;
  request.body.captcha = answer;

  const response = await dispatchHandler(claimPostHandler, request);
  assert.equal(response.statusCode, 403);
  assert.equal(response.renderedView, "error");

  const claimedProfile = await get(
    "SELECT claimed_user_id FROM ip_profiles WHERE hash=?",
    [profile.hash],
  );
  assert.equal(claimedProfile?.claimed_user_id, null);
});

test("la conversion échoue si le profil est déjà revendiqué", { concurrency: false }, async () => {
  await initDb();
  const ip = "203.0.113.88";
  const profile = await touchIpProfile(ip, { skipRefresh: true });
  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );

  const primaryUsername = `primaire-${Date.now()}`;
  const baseRequest = buildClaimRequest({
    hash: profile.hash,
    ip,
    body: {
      username: primaryUsername,
      password: "MotdepasseUltraSecurise",
      captchaToken: "",
      captcha: "",
    },
  });
  const { challenge: baseChallenge, answer: baseAnswer } = attachCaptcha(baseRequest);
  baseRequest.body.captchaToken = baseChallenge.token;
  baseRequest.body.captcha = baseAnswer;
  const firstResponse = await dispatchHandler(claimPostHandler, baseRequest);
  assert.equal(firstResponse.statusCode, 302);
  const primaryUser = await get(
    "SELECT id FROM users WHERE username=?",
    [primaryUsername],
  );
  assert.ok(primaryUser, "Le premier compte doit exister");

  const conflictingRequest = buildClaimRequest({
    hash: profile.hash,
    ip,
    body: {
      username: `secondaire-${Date.now()}`,
      password: "MotdepasseUltraSecurise",
      captchaToken: "",
      captcha: "",
    },
  });

  const { challenge: conflictChallenge, answer: conflictAnswer } = attachCaptcha(conflictingRequest);
  conflictingRequest.body.captchaToken = conflictChallenge.token;
  conflictingRequest.body.captcha = conflictAnswer;

  const conflictResponse = await dispatchHandler(claimPostHandler, conflictingRequest);
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.renderedView, "ip_profile");

  const users = await get(
    "SELECT COUNT(*) AS total FROM users WHERE username LIKE ?",
    ["secondaire-%"],
  );
  assert.equal(Number(users?.total || 0), 0, "Aucun second compte ne doit être créé");

  await run(
    "UPDATE ip_profiles SET claimed_user_id=NULL, claimed_at=NULL WHERE hash=?",
    [profile.hash],
  );
  await run("DELETE FROM users WHERE id=?", [primaryUser.id]);
});
