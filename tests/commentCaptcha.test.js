import test from "node:test";
import assert from "node:assert/strict";

import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { getRecaptchaConfig } from "../utils/captcha.js";

function findRouteHandlers(path, method = "post") {
  const layer = pagesRouter.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[method]);
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

async function createPage(slug) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  return get(`SELECT id FROM pages WHERE slug_id=?`, [slug]);
}

async function cleanupPage(slug) {
  const page = await get(`SELECT id FROM pages WHERE slug_id=?`, [slug]);
  if (page) {
    await run(`DELETE FROM comments WHERE page_id=?`, [page.id]);
  }
  await run(`DELETE FROM pages WHERE slug_id=?`, [slug]);
}

const commentHandlers = findRouteHandlers("/wiki/:slugid/comments");
const commentHandler = commentHandlers.at(-1);

if (!commentHandler) {
  throw new Error("Impossible de localiser le gestionnaire de commentaire");
}

function dispatchComment(req) {
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
      commentHandler(req, recorder, (err) => {
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

function buildRequest({ slug, body, permissions = { can_comment: true } }) {
  return {
    params: { slugid: slug },
    body,
    permissionFlags: permissions,
    session: {},
    clientIp: "127.0.0.1",
    clientUserAgent: "test-agent",
    get: () => "",
    accepts: () => true,
    protocol: "http",
    originalUrl: `/wiki/${slug}/comments`,
  };
}

test(
  "la création de commentaire accepte un captcha valide",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `captcha-ok-${Date.now()}`;
    const page = await createPage(slug);

    t.after(async () => {
      await cleanupPage(slug);
    });

    const originalFetch = globalThis.fetch;
    const originalSiteKey = process.env.RECAPTCHA_SITE_KEY;
    const originalSecret = process.env.RECAPTCHA_SECRET;

    process.env.RECAPTCHA_SITE_KEY = "site-test";
    process.env.RECAPTCHA_SECRET = "secret-test";

    assert.ok(getRecaptchaConfig());

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

    t.after(() => {
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

    const req = buildRequest({
      slug,
      body: {
        author: "Cap",
        body: "Bonjour le monde",
        captchaToken: "token-ok",
        website: "",
      },
    });

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    assert.match(req.session.notifications.at(-1).message, /Merci !/);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(
      fetchCalls[0].url,
      "https://www.google.com/recaptcha/api/siteverify",
    );

    const insertedComment = await get(
      `SELECT page_id, author, body, status FROM comments WHERE page_id=?`,
      [page.id],
    );
    assert.ok(insertedComment);
    assert.strictEqual(insertedComment.body, "Bonjour le monde");
    assert.strictEqual(insertedComment.status, "pending");
  },
);

test(
  "la création de commentaire rejette un captcha invalide",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `captcha-ko-${Date.now()}`;
    await createPage(slug);

    t.after(async () => {
      await cleanupPage(slug);
    });

    const originalFetch = globalThis.fetch;
    const originalSiteKey = process.env.RECAPTCHA_SITE_KEY;
    const originalSecret = process.env.RECAPTCHA_SECRET;

    process.env.RECAPTCHA_SITE_KEY = "site-test";
    process.env.RECAPTCHA_SECRET = "secret-test";

    assert.ok(getRecaptchaConfig());

    const fetchCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { success: false, "error-codes": ["invalid-input-response"] };
        },
      };
    };

    t.after(() => {
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

    const req = buildRequest({
      slug,
      body: {
        author: "Cap",
        body: "Message sans captcha",
        captchaToken: "bad-token",
        website: "",
      },
    });

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(
      messages.includes(
        "Merci de répondre correctement à la question anti-spam (3 + 4).",
      ),
    );
    assert.ok(req.session.commentFeedback);
    assert.strictEqual(fetchCalls.length, 1);

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(commentCount.count, 0);
  },
);

test(
  "la validation serveur bloque avant l'appel reCAPTCHA en cas d'erreurs",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `captcha-validation-first-${Date.now()}`;
    await createPage(slug);

    t.after(async () => {
      await cleanupPage(slug);
    });

    const originalFetch = globalThis.fetch;
    const originalSiteKey = process.env.RECAPTCHA_SITE_KEY;
    const originalSecret = process.env.RECAPTCHA_SECRET;

    process.env.RECAPTCHA_SITE_KEY = "site-test";
    process.env.RECAPTCHA_SECRET = "secret-test";

    assert.ok(getRecaptchaConfig());

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

    t.after(() => {
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

    const req = buildRequest({
      slug,
      body: {
        author: "",
        body: "   ",
        captchaToken: "token-should-not-be-used",
        website: "",
      },
    });

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(messages.includes("Le message est requis."));
    assert.strictEqual(fetchCalls.length, 0);

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(commentCount.count, 0);
  },
);
