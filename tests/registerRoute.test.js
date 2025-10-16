import test from "node:test";
import assert from "node:assert/strict";

import authRouter from "../routes/auth.js";
import { initDb, run, all } from "../db.js";
import { getRecaptchaConfig } from "../utils/captcha.js";

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

function buildRegisterRequest({ username, password, captchaToken }) {
  return {
    body: { username, password, captchaToken },
    headers: {},
    ip: "127.0.0.1",
    session: {},
    locals: {},
  };
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

  const originalFetch = globalThis.fetch;
  const originalSiteKey = process.env.RECAPTCHA_SITE_KEY;
  const originalSecret = process.env.RECAPTCHA_SECRET;

  process.env.RECAPTCHA_SITE_KEY = "test-key";
  process.env.RECAPTCHA_SECRET = "test-secret";

  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { success: true };
      },
    };
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalSiteKey === undefined) {
      delete process.env.RECAPTCHA_SITE_KEY;
    } else {
      process.env.RECAPTCHA_SITE_KEY = originalSiteKey;
    }
    if (originalSecret === undefined) {
      delete process.env.RECAPTCHA_SECRET;
    } else {
      process.env.RECAPTCHA_SECRET = originalSecret;
    }
  });

  assert.ok(getRecaptchaConfig(), "la configuration du captcha doit être disponible");

  const username = `test-concurrent-${Date.now()}`;
  const password = "P@ssword123";

  await run("DELETE FROM users WHERE username=? COLLATE NOCASE", [username]);

  t.after(async () => {
    await run("DELETE FROM users WHERE username=? COLLATE NOCASE", [username]);
  });

  const requestFactory = () =>
    buildRegisterRequest({ username, password, captchaToken: "token-ok" });

  const results = await Promise.all([
    dispatchRegister(requestFactory()),
    dispatchRegister(requestFactory()),
  ]);

  assert.equal(fetchCalls.length, 2, "les deux requêtes doivent valider le captcha");

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
