import test from "node:test";
import assert from "node:assert/strict";
import { authenticator } from "otplib";

import accountRouter from "../routes/account.js";
import authRouter from "../routes/auth.js";
import { initDb, run, get } from "../db.js";
import { hashPassword } from "../utils/passwords.js";
import { parseRecoveryCodeState } from "../utils/twoFactor.js";

function findRouteHandlers(router, path, method = "post") {
  const layer = router.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[method]);
  });
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} introuvable`);
  }
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

function createResponseRecorder(onFinish) {
  const headers = new Map();
  let finished = false;
  const res = {
    statusCode: 200,
    headersSent: false,
    locals: {},
  };

  function finish() {
    if (finished) {
      return;
    }
    finished = true;
    if (typeof onFinish === "function") {
      onFinish(res);
    }
  }

  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };

  res.set = function set(name, value) {
    headers.set(String(name).toLowerCase(), String(value));
    return this;
  };

  res.get = function getHeader(name) {
    return headers.get(String(name).toLowerCase()) || null;
  };

  res.render = function render(view, data) {
    this.view = view;
    this.data = data;
    this.headersSent = true;
    finish();
    return this;
  };

  res.redirect = function redirect(location) {
    this.redirectLocation = location;
    if (this.statusCode === 200) {
      this.statusCode = 302;
    }
    this.headersSent = true;
    finish();
    return this;
  };

  res.send = function send(body) {
    this.body = body;
    this.headersSent = true;
    finish();
    return this;
  };

  res.json = function json(payload) {
    this.body = payload;
    this.headersSent = true;
    finish();
    return this;
  };

  return res;
}

function createRequest({
  method = "post",
  body = {},
  session = {},
  query = {},
  headers = {},
  path = "/",
} = {}) {
  return {
    method: method.toUpperCase(),
    body,
    session,
    query,
    headers,
    path,
    originalUrl: path,
    ip: "127.0.0.1",
    get(name) {
      return headers[String(name).toLowerCase()] || null;
    },
  };
}

function dispatch(handlers, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let index = 0;
    let res;

    function finish(value, isError = false) {
      if (settled) return;
      settled = true;
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    }

    res = createResponseRecorder(() => finish(res, false));

    const next = (err) => {
      if (err) {
        finish(err, true);
        return;
      }
      const handler = handlers[index++];
      if (!handler) {
        finish(res, false);
        return;
      }
      try {
        const maybePromise = handler(req, res, next);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch((error) => finish(error, true));
        }
      } catch (error) {
        finish(error, true);
      }
    };

    next();
  });
}

const setupHandlers = findRouteHandlers(accountRouter, "/security/setup");
const enableHandlers = findRouteHandlers(accountRouter, "/security/enable");
const loginHandlers = findRouteHandlers(authRouter, "/login");
const twoFactorHandlers = findRouteHandlers(authRouter, "/login/two-factor");

test("le flux d'activation 2FA stocke un secret et des codes", async (t) => {
  await initDb();
  const username = `user-${Date.now()}`;
  const password = "Secret123!";
  const passwordHash = await hashPassword(password);
  await run("INSERT INTO users(username, password) VALUES(?, ?)", [username, passwordHash]);
  const user = await get("SELECT id FROM users WHERE username=?", [username]);
  const session = { user: { id: user.id, username }, notifications: [] };

  const setupReq = createRequest({
    session,
    path: "/account/security/setup",
  });
  await dispatch(setupHandlers, setupReq);
  assert.ok(session.twoFactorSetup, "une configuration doit être stockée en session");
  assert.match(session.twoFactorSetup.secret, /^[A-Z2-7]+=*$/i);

  const secretBeforeEnable = session.twoFactorSetup.secret;
  const token = authenticator.generate(secretBeforeEnable);
  const enableReq = createRequest({
    session,
    body: { token },
    path: "/account/security/enable",
  });
  const enableRes = await dispatch(enableHandlers, enableReq);
  assert.equal(enableRes.redirectLocation, "/account/security");
  assert.ok(
    Array.isArray(session.generatedRecoveryCodes) && session.generatedRecoveryCodes.length > 0,
    "les codes doivent être stockés en session",
  );

  const updatedUser = await get(
    "SELECT two_factor_enabled, totp_secret, recovery_codes FROM users WHERE id=?",
    [user.id],
  );
  assert.equal(updatedUser.two_factor_enabled, 1);
  assert.equal(updatedUser.totp_secret, secretBeforeEnable);
  assert.ok(updatedUser.recovery_codes, "les codes de récupération doivent être enregistrés");
  const state = parseRecoveryCodeState(updatedUser.recovery_codes);
  const generatedCodes = Array.isArray(session.generatedRecoveryCodes)
    ? session.generatedRecoveryCodes
    : [];
  assert.equal(state.length, generatedCodes.length || 10);
});

test("la connexion exige un code TOTP valide lorsqu'elle est activée", async (t) => {
  await initDb();
  const username = `twofa-${Date.now()}`;
  const password = "P@ssw0rd";
  const passwordHash = await hashPassword(password);
  await run("INSERT INTO users(username, password) VALUES(?, ?)", [username, passwordHash]);
  const user = await get("SELECT id FROM users WHERE username=?", [username]);
  const session = { user: { id: user.id, username }, notifications: [] };

  // Setup puis activation
  await dispatch(setupHandlers, createRequest({ session, path: "/account/security/setup" }));
  const setupSecret = session.twoFactorSetup.secret;
  const token = authenticator.generate(setupSecret);
  await dispatch(
    enableHandlers,
    createRequest({ session, path: "/account/security/enable", body: { token } }),
  );
  const persistedConfig = await get(
    "SELECT two_factor_enabled, totp_secret, recovery_codes FROM users WHERE id=?",
    [user.id],
  );
  assert.equal(persistedConfig.two_factor_enabled, 1);
  const persistedSecret = persistedConfig.totp_secret;
  const recoveryCodes = [...session.generatedRecoveryCodes];

  // Connexion initiale
  const loginSession = {};
  const loginReq = createRequest({
    body: { username, password },
    session: loginSession,
    path: "/login",
  });
  const loginRes = await dispatch(loginHandlers, loginReq);
  assert.equal(loginRes.redirectLocation, "/login/two-factor");
  assert.ok(loginSession.pendingTwoFactor, "la session doit enregistrer l'étape 2FA");

  const twoFactorReq = createRequest({
    session: loginSession,
    body: { token: authenticator.generate(persistedSecret) },
    path: "/login/two-factor",
  });
  const twoFactorRes = await dispatch(twoFactorHandlers, twoFactorReq);
  assert.equal(twoFactorRes.redirectLocation, "/");
  assert.ok(loginSession.user, "la session doit être authentifiée");
  assert.ok(loginSession.user.username === username);

  // Connexion via code de récupération
  const recoverySession = {};
  await dispatch(
    loginHandlers,
    createRequest({
      body: { username, password },
      session: recoverySession,
      path: "/login",
    }),
  );
  const recoveryCode = recoveryCodes[0];
  const recoveryTwoFactorReq = createRequest({
    session: recoverySession,
    body: { mode: "recovery", recoveryCode },
    path: "/login/two-factor",
  });
  const recoveryRes = await dispatch(twoFactorHandlers, recoveryTwoFactorReq);
  assert.equal(recoveryRes.redirectLocation, "/");
  const dbState = await get(
    "SELECT recovery_codes FROM users WHERE id=?",
    [user.id],
  );
  const updatedState = parseRecoveryCodeState(dbState.recovery_codes);
  const remaining = updatedState.filter((entry) => entry.used !== true).length;
  assert.equal(remaining, recoveryCodes.length - 1, "un code de récupération doit être consommé");
});
