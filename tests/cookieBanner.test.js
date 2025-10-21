import test from "node:test";
import assert from "node:assert/strict";
import cookieRouter from "../routes/cookies.js";
import {
  COOKIE_ACCEPTED_VALUE,
  cookieConsentMiddleware,
} from "../middleware/cookieConsent.js";

const consentLayer = cookieRouter.stack.find(
  (layer) => layer.route && layer.route.path === "/cookies/consent" && layer.route.methods.post,
);

if (!consentLayer) {
  throw new Error("Impossible de localiser la route POST /cookies/consent pour les tests");
}

const consentHandler = consentLayer.route.stack[0].handle;

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    locals: {},
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    end(payload) {
      this.ended = true;
      this.payload = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[name];
    },
  };
}

test("POST /cookies/consent enregistre le cookie de consentement", () => {
  const req = {
    method: "POST",
    secure: true,
    protocol: "https",
    headers: {
      host: "example.test",
      cookie: "",
    },
    body: { consent: COOKIE_ACCEPTED_VALUE },
  };
  const res = createResponse();

  let thrownError = null;
  try {
    consentHandler(req, res, (err) => {
      if (err) {
        thrownError = err;
      }
    });
  } catch (err) {
    thrownError = err;
  }

  assert.ifError(thrownError);

  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  const setCookieHeader = res.headers["Set-Cookie"];
  assert.ok(setCookieHeader, "L'en-tête Set-Cookie devrait être défini");
  assert.match(setCookieHeader, /cookie_consent=accepted/);
  assert.match(setCookieHeader, /Max-Age=31536000/);
  assert.match(setCookieHeader, /SameSite=Lax/);
  assert.match(setCookieHeader, /Secure/);
});

test("Le middleware cookieConsentMiddleware active la bannière sans consentement", () => {
  const req = { headers: {} };
  const res = { locals: {} };
  let nextCalled = false;

  cookieConsentMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.cookies, {});
  assert.equal(res.locals.showCookieBanner, true);
  assert.equal(res.locals.cookieConsent, null);
  assert.equal(res.locals.cookiePolicyUrl, "/cookies/politique");
});

test("Le middleware cookieConsentMiddleware désactive la bannière après acceptation", () => {
  const req = {
    headers: {
      cookie: `cookie_consent=${COOKIE_ACCEPTED_VALUE}`,
    },
  };
  const res = { locals: {} };

  cookieConsentMiddleware(req, res, () => {});

  assert.equal(res.locals.showCookieBanner, false);
  assert.equal(res.locals.cookieConsent, COOKIE_ACCEPTED_VALUE);
});
