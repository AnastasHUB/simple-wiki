import test from "node:test";
import assert from "node:assert/strict";
import adminRouter from "../routes/admin.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

const trendsLayer = adminRouter.stack.find(
  (layer) => layer.route && layer.route.path === "/stats/trends.json",
);

if (!trendsLayer) {
  throw new Error("Impossible de localiser la route /admin/stats/trends.json pour les tests");
}

const routeHandlers = trendsLayer.route.stack.map((stackLayer) => stackLayer.handle);
const permissionMiddleware = routeHandlers.find((handler) => handler.length >= 3);
const trendsHandler =
  routeHandlers.find((handler) => handler.length < 3) || routeHandlers.at(-1);

if (!permissionMiddleware || !trendsHandler) {
  throw new Error("Les gestionnaires de la route des tendances sont introuvables");
}

function createResponseRecorder() {
  const headers = new Map();
  return {
    statusCode: 200,
    headers,
    body: undefined,
    redirectLocation: null,
    finished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(field, value) {
      headers.set(String(field).toLowerCase(), value);
      return this;
    },
    get(field) {
      return headers.get(String(field).toLowerCase());
    },
    json(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.finished = true;
      return this;
    },
    redirect(location) {
      this.redirectLocation = location;
      this.finished = true;
      return this;
    },
  };
}

function buildRequest({ range = 14, permissions, acceptsJson = true } = {}) {
  const safePermissions = permissions || {
    is_admin: true,
    can_view_stats: true,
    can_view_stats_basic: true,
  };
  return {
    method: "GET",
    path: "/admin/stats/trends.json",
    query: { range: String(range) },
    permissionFlags: safePermissions,
    session: { user: safePermissions },
    accepts: acceptsJson ? () => "json" : () => "html",
    get: () => "",
  };
}

async function dispatchAuthorized({ range, permissions } = {}) {
  const req = buildRequest({ range, permissions });
  const res = createResponseRecorder();
  await new Promise((resolve, reject) => {
    try {
      permissionMiddleware(req, res, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
  await trendsHandler(req, res);
  return res;
}

function isoDayFromOffset(offsetDays) {
  const now = new Date();
  const anchor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  anchor.setUTCDate(anchor.getUTCDate() - offsetDays);
  return anchor.toISOString().slice(0, 10);
}

async function createPageFixture() {
  const slug = `stats-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Page ${slug}`, "Contenu", "Admin"],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id = ?", [slug]);
  if (!page) {
    throw new Error("Impossible de créer la page de test pour les tendances");
  }
  return page.id;
}

async function seedViewData(pageId) {
  for (let offset = 1; offset <= 9; offset += 1) {
    const day = isoDayFromOffset(offset);
    await run(
      `INSERT INTO page_view_daily(page_id, day, views, snowflake_id)
       VALUES(?,?,?,?)`,
      [pageId, day, offset * 3, generateSnowflake()],
    );
  }
  const todayIso = isoDayFromOffset(0);
  await run(
    `INSERT INTO page_views(page_id, ip, viewed_at) VALUES(?,?,?)`,
    [pageId, "127.0.0.1", `${todayIso}T08:00:00Z`],
  );
  await run(
    `INSERT INTO page_views(page_id, ip, viewed_at) VALUES(?,?,?)`,
    [pageId, "192.0.2.55", `${todayIso}T11:30:00Z`],
  );
}

test("l'endpoint refuse les requêtes sans permission", async () => {
  await initDb();
  const req = buildRequest({ permissions: { can_view_stats: false }, acceptsJson: true });
  const res = createResponseRecorder();
  let nextCalled = false;
  permissionMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 403);
  assert.deepEqual(res.body, {
    error: "forbidden",
    message: "Vous n'avez pas la permission d'effectuer cette action.",
  });
});

test("l'endpoint renvoie les tendances de vues avec le schéma attendu", async () => {
  await initDb();
  const pageId = await createPageFixture();
  await seedViewData(pageId);

  const permissions = {
    is_admin: true,
    can_view_stats: true,
    can_view_stats_basic: true,
  };

  const res14 = await dispatchAuthorized({ range: 14, permissions });
  assert.strictEqual(res14.statusCode, 200);
  assert.ok(res14.body);
  assert.strictEqual(res14.body.range.days, 14);
  assert.strictEqual(res14.body.points.length, 14);
  assert.strictEqual(res14.body.range.from, isoDayFromOffset(13));
  assert.strictEqual(res14.body.range.to, isoDayFromOffset(0));
  assert.ok(typeof res14.body.generatedAt === "string");
  assert.ok(res14.get("cache-control"));

  const pointsMap = new Map(res14.body.points.map((point) => [point.date, point.views]));
  for (let offset = 1; offset <= 9; offset += 1) {
    assert.strictEqual(pointsMap.get(isoDayFromOffset(offset)), offset * 3);
  }
  assert.strictEqual(pointsMap.get(isoDayFromOffset(0)), 2);
  const computedTotal = res14.body.points.reduce(
    (sum, point) => sum + Number(point.views || 0),
    0,
  );
  assert.strictEqual(res14.body.totals.views, computedTotal);

  const res7 = await dispatchAuthorized({ range: 7, permissions });
  assert.strictEqual(res7.statusCode, 200);
  assert.strictEqual(res7.body.range.days, 7);
  assert.strictEqual(res7.body.points.length, 7);
  assert.strictEqual(res7.body.range.from, isoDayFromOffset(6));
  assert.strictEqual(res7.body.range.to, isoDayFromOffset(0));

  assert.deepEqual(
    res7.body.points.map((point) => point.date),
    res14.body.points.slice(-7).map((point) => point.date),
  );
  assert.strictEqual(res7.body.points.at(-1).views, pointsMap.get(isoDayFromOffset(0)));
});
