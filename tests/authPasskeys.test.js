import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import authRouter from "../routes/auth.js";
import accountRouter from "../routes/account.js";
import { initDb, run, get } from "../db.js";
import { hashPassword } from "../utils/passwords.js";
import {
  setWebAuthnAdapter,
  resetWebAuthnAdapter,
  toBase64Url,
} from "../utils/webauthn.js";

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
  protocol = "https",
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
    protocol,
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

const passkeyOptionsHandlers = findRouteHandlers(accountRouter, "/security/passkeys/options");
const passkeyRegisterHandlers = findRouteHandlers(accountRouter, "/security/passkeys/register");
const loginPasskeyOptionsHandlers = findRouteHandlers(authRouter, "/login/passkey/options");
const loginPasskeyVerifyHandlers = findRouteHandlers(authRouter, "/login/passkey/verify");

const TEST_CREDENTIAL_ID = Buffer.from("test-credential-id");
const TEST_PUBLIC_KEY = Buffer.from("public-key");

const fakeAdapter = {
  async generateRegistrationOptions() {
    return {
      challenge: "registration-challenge",
      user: { id: "user-handle" },
      excludeCredentials: [],
    };
  },
  async verifyRegistrationResponse({ expectedChallenge }) {
    assert.equal(expectedChallenge, "registration-challenge");
    return {
      verified: true,
      registrationInfo: {
        credentialID: TEST_CREDENTIAL_ID,
        credentialPublicKey: TEST_PUBLIC_KEY,
        counter: 0,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    };
  },
  async generateAuthenticationOptions() {
    return {
      challenge: "authentication-challenge",
      allowCredentials: [
        {
          id: toBase64Url(TEST_CREDENTIAL_ID),
          type: "public-key",
        },
      ],
    };
  },
  async verifyAuthenticationResponse({ expectedChallenge }) {
    assert.equal(expectedChallenge, "authentication-challenge");
    return {
      verified: true,
      authenticationInfo: {
        newCounter: 2,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    };
  },
};

test("enregistrer puis utiliser une passkey pour se connecter", async (t) => {
  await initDb();
  const username = `alice-${randomUUID()}`;
  const passwordHash = await hashPassword("Secret123!");
  await run(
    "INSERT INTO users(username, password, two_factor_enabled, totp_secret) VALUES(?, ?, 1, ?)",
    [username, passwordHash, "totp-secret"],
  );
  const user = await get("SELECT id, username FROM users WHERE username=?", [username]);
  assert.ok(user);

  setWebAuthnAdapter(fakeAdapter);
  t.after(() => {
    resetWebAuthnAdapter();
  });

  const session = { user: { id: user.id, username: user.username }, notifications: [] };
  const reqOptions = createRequest({
    session,
    path: "/account/security/passkeys/options",
    headers: { host: "localhost" },
  });
  const resOptions = await dispatch(passkeyOptionsHandlers, reqOptions);
  assert.equal(resOptions.statusCode, 200);
  assert.ok(session.pendingWebAuthnRegistration);
  assert.equal(resOptions.body?.ok, true);

  const credentialIdBase64 = toBase64Url(TEST_CREDENTIAL_ID);
  const registerReq = createRequest({
    session,
    path: "/account/security/passkeys/register",
    body: {
      credential: {
        id: credentialIdBase64,
        rawId: credentialIdBase64,
        type: "public-key",
        response: {
          transports: ["internal"],
        },
      },
      label: "Clé de test",
    },
    headers: { host: "localhost" },
  });
  const registerRes = await dispatch(passkeyRegisterHandlers, registerReq);
  assert.equal(registerRes.statusCode, 200);
  assert.equal(registerRes.body?.ok, true);
  assert.equal(session.pendingWebAuthnRegistration, undefined);

  const storedCredential = await get(
    "SELECT credential_id, counter, friendly_name FROM user_webauthn_credentials WHERE user_id=?",
    [user.id],
  );
  assert.ok(storedCredential);
  assert.equal(storedCredential.credential_id, credentialIdBase64);
  assert.equal(storedCredential.counter, 0);
  assert.equal(storedCredential.friendly_name, "Clé de test");

  const loginSession = { notifications: [] };
  const loginOptionsReq = createRequest({
    session: loginSession,
    path: "/login/passkey/options",
    body: { username },
    headers: { host: "localhost" },
  });
  const loginOptionsRes = await dispatch(loginPasskeyOptionsHandlers, loginOptionsReq);
  assert.equal(loginOptionsRes.statusCode, 200);
  assert.equal(loginOptionsRes.body?.ok, true);
  assert.ok(loginSession.pendingWebAuthnAuthentication);

  const loginVerifyReq = createRequest({
    session: loginSession,
    path: "/login/passkey/verify",
    body: {
      credential: {
        id: credentialIdBase64,
        rawId: credentialIdBase64,
        type: "public-key",
        response: {
          authenticatorData: "test-data",
          clientDataJSON: "client",
          signature: "signature",
          userHandle: null,
        },
      },
    },
    headers: { host: "localhost" },
  });
  const loginVerifyRes = await dispatch(loginPasskeyVerifyHandlers, loginVerifyReq);
  assert.equal(loginVerifyRes.statusCode, 200);
  assert.equal(loginVerifyRes.body?.ok, true);
  assert.equal(loginVerifyRes.body?.redirect, "/");
  assert.ok(loginSession.user, "l'utilisateur doit être connecté en session");
  assert.equal(loginSession.pendingWebAuthnAuthentication, undefined);

  const updatedCredential = await get(
    "SELECT counter, last_used_at FROM user_webauthn_credentials WHERE credential_id=?",
    [credentialIdBase64],
  );
  assert.equal(updatedCredential.counter, 2);
  assert.ok(updatedCredential.last_used_at);
});
