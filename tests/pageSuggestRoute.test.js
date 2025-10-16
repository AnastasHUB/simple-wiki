import test from "node:test";
import assert from "node:assert/strict";
import pagesRouter from "../routes/pages.js";
import { initDb, run } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

function findRouteHandlers(path, method = "get") {
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
  res.json = function json(payload) {
    this.body = payload;
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };
  return res;
}

const suggestHandlers = findRouteHandlers("/api/pages/suggest", "get");
const suggestHandler = suggestHandlers.at(-1);

if (!suggestHandler) {
  throw new Error("Impossible de localiser le gestionnaire d'autocomplétion");
}

async function dispatchSuggest(req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (recorder) => {
      if (settled) return;
      settled = true;
      resolve(recorder);
    };
    const recorder = createResponseRecorder(() => finish(recorder));
    try {
      suggestHandler(req, recorder, (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        finish(recorder);
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

async function insertScheduledPage({ slug, title, publishAt }) {
  const snowflake = generateSnowflake();
  const timestamps = publishAt;
  await run(
    `INSERT INTO pages(
      snowflake_id,
      slug_base,
      slug_id,
      title,
      content,
      author,
      status,
      publish_at,
      created_at,
      updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      snowflake,
      slug,
      slug,
      title,
      `Contenu de ${title}`,
      "Auteur Planifié",
      "scheduled",
      publishAt,
      timestamps,
      timestamps,
    ],
  );
}

async function cleanupPages(slugs) {
  if (!Array.isArray(slugs) || !slugs.length) {
    return;
  }
  const placeholders = slugs.map(() => "?").join(",");
  await run(`DELETE FROM pages WHERE slug_id IN (${placeholders})`, slugs);
}

test("l'autocomplétion inclut les pages planifiées déjà publiées et ignore celles à venir", async (t) => {
  await initDb();

  const unique = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`;
  const dueSlug = `suggest-due-${unique}`;
  const futureSlug = `suggest-future-${unique}`;
  const keyword = `Programmation ${unique}`;
  const now = Date.now();
  const dueDate = new Date(now - 60 * 1000).toISOString();
  const futureDate = new Date(now + 60 * 60 * 1000).toISOString();

  await insertScheduledPage({
    slug: dueSlug,
    title: `${keyword} - déjà publiée`,
    publishAt: dueDate,
  });
  await insertScheduledPage({
    slug: futureSlug,
    title: `${keyword} - future`,
    publishAt: futureDate,
  });

  t.after(async () => {
    await cleanupPages([dueSlug, futureSlug]);
  });

  const response = await dispatchSuggest({
    method: "GET",
    query: { q: keyword },
    headers: {},
    session: {},
  });

  assert.equal(response.statusCode, 200);
  assert.ok(response.body?.ok, "la réponse doit indiquer ok");
  const slugs = (response.body?.results || []).map((entry) => entry.slug);
  assert.ok(
    slugs.includes(dueSlug),
    "la page planifiée échue doit apparaître dans les suggestions",
  );
  assert.ok(
    !slugs.includes(futureSlug),
    "la page planifiée future ne doit pas apparaître dans les suggestions",
  );
});
