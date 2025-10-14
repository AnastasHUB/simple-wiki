import test from "node:test";
import assert from "node:assert/strict";
import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

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
    body: undefined,
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
  res.json = function json(payload) {
    this.body = payload;
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
  await run("DELETE FROM pages WHERE slug_id=?", [slug]);
}

const handlers = findRouteHandlers("/wiki/:slugid/comments/preview");
const previewHandler = handlers.at(-1);

if (!previewHandler) {
  throw new Error("Impossible de localiser le gestionnaire de prévisualisation");
}

async function dispatchPreview(req) {
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
      previewHandler(req, recorder, (err) => {
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
    body: { body },
    permissionFlags: permissions,
    session: {},
    get: () => "",
    accepts: () => true,
  };
}

test("l'endpoint de prévisualisation renvoie du HTML assaini", async (t) => {
  await initDb();
  const slug = `preview-${Date.now()}`;
  await createPage(slug);

  t.after(async () => {
    await cleanupPage(slug);
  });

  const req = buildRequest({ slug, body: "Bonjour [[Wiki]]" });
  const res = await dispatchPreview(req);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body);
  assert.strictEqual(res.body.ok, true);
  assert.match(res.body.html, /<a href=\"\/lookup\/wiki\"[^>]*>Wiki<\/a>/);
  assert.strictEqual(res.get("cache-control"), "no-store");
});

test("l'endpoint refuse les requêtes sans permission", async (t) => {
  await initDb();
  const slug = `preview-forbidden-${Date.now()}`;
  await createPage(slug);

  t.after(async () => {
    await cleanupPage(slug);
  });

  const req = buildRequest({
    slug,
    body: "Test",
    permissions: { can_comment: false },
  });
  const res = await dispatchPreview(req);

  assert.strictEqual(res.statusCode, 403);
  assert.deepEqual(res.body, {
    ok: false,
    error: "Les commentaires sont désactivés pour votre rôle.",
  });
});

test("l'endpoint valide le corps du commentaire", async (t) => {
  await initDb();
  const slug = `preview-validation-${Date.now()}`;
  await createPage(slug);

  t.after(async () => {
    await cleanupPage(slug);
  });

  const req = buildRequest({ slug, body: "   " });
  const res = await dispatchPreview(req);

  assert.strictEqual(res.statusCode, 400);
  assert.deepEqual(res.body, {
    ok: false,
    errors: ["Le message est requis."],
  });
});
