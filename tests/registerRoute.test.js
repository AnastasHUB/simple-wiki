import test from "node:test";
import assert from "node:assert/strict";

import authRouter from "../routes/auth.js";
import { initDb, run, all } from "../db.js";
import { createCaptchaChallenge } from "../utils/captcha.js";

function findRouteHandlers(path, method = "post") {
  const layer = authRouter.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[method]);
  });
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} introuvable`);
  }
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

const registerHandlers = findRouteHandlers("/register");

function createResponseRecorder(onFinish) {
  const headers = new Map();
  let finished = false;
  const res = {
    statusCode: 200,
    headersSent: false,
    locals: {},
  };

  function finish() {
    if (finished) return;
    finished = true;
    if (typeof onFinish === "function") {
      onFinish();
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

  res.get = function get(name) {
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

function buildRegisterRequest({ username, password, captchaOverride } = {}) {
  const req = {
    body: { username, password, captchaToken: "", captcha: "" },
    headers: {},
    ip: "127.0.0.1",
    session: {},
    locals: {},
  };
  const challenge = createCaptchaChallenge(req);
  if (!challenge) {
    throw new Error("Le captcha devrait être disponible");
  }
  const answer = req.session.captchaChallenges?.[challenge.token]?.answer || "";
  req.body.captchaToken = challenge.token;
  req.body.captcha = captchaOverride ?? answer;
  return req;
}

function dispatchRegister(req) {
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
      const handler = registerHandlers[index++];
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

test("les inscriptions concurrentes renvoient une erreur conviviale", async (t) => {
  await initDb();

  const username = `test-concurrent-${Date.now()}`;
  const password = "P@ssword123";

  await run("DELETE FROM users WHERE username=? COLLATE NOCASE", [username]);

  t.after(async () => {
    await run("DELETE FROM users WHERE username=? COLLATE NOCASE", [username]);
  });

  const requestFactory = () => buildRegisterRequest({ username, password });

  const results = await Promise.all([
    dispatchRegister(requestFactory()),
    dispatchRegister(requestFactory()),
  ]);

  const successResponse = results.find((res) => res.redirectLocation === "/");
  assert.ok(successResponse, "une requête doit réussir");
  assert.equal(successResponse.statusCode, 302);

  const conflictResponse = results.find((res) => res.view === "register");
  assert.ok(conflictResponse, "l'autre requête doit afficher le formulaire");
  assert.equal(conflictResponse.statusCode, 409);
  assert.ok(
    conflictResponse?.data?.errors?.includes("Ce nom d'utilisateur est déjà utilisé."),
    "le message d'erreur doit indiquer le doublon",
  );
  assert.equal(
    conflictResponse?.data?.values?.username,
    username,
    "le nom d'utilisateur saisi doit être renvoyé",
  );

  const rows = await all(
    "SELECT COUNT(*) AS total FROM users WHERE username=? COLLATE NOCASE",
    [username],
  );
  const total = Number(rows[0]?.total ?? 0);
  assert.equal(total, 1, "un seul compte doit être créé");
});
