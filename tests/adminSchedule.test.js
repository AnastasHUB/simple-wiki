import test from "node:test";
import assert from "node:assert/strict";
import adminRouter from "../routes/admin.js";
import { initDb, run } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

function findRouteHandlers(path, method = "get") {
  const layer = adminRouter.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[method]);
  });
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} introuvable`);
  }
  return layer.route.stack.map((stackLayer) => stackLayer.handle);
}

function createResponseRecorder(resolve) {
  const res = {
    locals: {},
    statusCode: 200,
    headers: new Map(),
    finished: false,
  };
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.set = function set(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
    return this;
  };
  res.get = function get(name) {
    return this.headers.get(String(name).toLowerCase());
  };
  res.render = function render(view, data) {
    this.view = view;
    this.data = data;
    this.finished = true;
    resolve(this);
  };
  res.redirect = function redirect(url) {
    this.redirectUrl = url;
    this.finished = true;
    resolve(this);
  };
  return res;
}

function buildRequest(overrides = {}) {
  return {
    params: {},
    query: {},
    session: { notifications: [] },
    permissionFlags: { can_schedule_pages: true, ...overrides.permissionFlags },
    accepts: () => "html",
    get: () => "",
    ...overrides,
  };
}

async function dispatchRoute(handlers, reqOptions = {}) {
  const handlersList = handlers.slice();
  return new Promise((resolve, reject) => {
    const req = typeof reqOptions === "object" ? reqOptions : {};
    const res = createResponseRecorder(resolve);
    let index = 0;

    const next = (err) => {
      if (err) {
        reject(err);
        return;
      }
      const handler = handlersList[index++];
      if (!handler) {
        resolve(res);
        return;
      }
      try {
        const result = handler(req, res, next);
        if (result && typeof result.then === "function") {
          result.catch(reject);
        }
      } catch (error) {
        reject(error);
      }
    };

    req.session ??= { notifications: [] };
    req.permissionFlags ??= { can_schedule_pages: true };
    req.params ??= {};
    req.query ??= {};
    req.accepts ??= () => "html";
    req.get ??= () => "";

    next();
  });
}

function uniqueSlug(suffix) {
  return `admin-schedule-${Date.now()}-${suffix}`;
}

const scheduleHandlers = findRouteHandlers("/schedule", "get");

test("la route de planification liste uniquement les pages à venir", async (t) => {
  await initDb();
  const base = uniqueSlug("base");
  const future1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const future2 = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const rows = [
    {
      slug: `${base}-future-a`,
      title: "Programmée A",
      status: "scheduled",
      publishAt: future1,
    },
    {
      slug: `${base}-future-b`,
      title: "Programmée B",
      status: "scheduled",
      publishAt: future2,
    },
    {
      slug: `${base}-past`,
      title: "En retard",
      status: "scheduled",
      publishAt: past,
    },
    {
      slug: `${base}-draft`,
      title: "Brouillon",
      status: "draft",
      publishAt: null,
    },
  ];

  for (const row of rows) {
    await run(
      `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        generateSnowflake(),
        row.slug,
        row.slug,
        row.title,
        `Contenu ${row.slug}`,
        "Auteur",
        row.status,
        row.publishAt,
      ],
    );
  }

  t.after(async () => {
    const placeholders = rows.map(() => "?").join(",");
    await run(`DELETE FROM pages WHERE slug_id IN (${placeholders})`, rows.map((row) => row.slug));
  });

  const req = buildRequest();
  const res = await dispatchRoute(scheduleHandlers, req);

  assert.strictEqual(res.view, "admin/schedule");
  assert.ok(res.data);
  const scheduled = Array.isArray(res.data.scheduledPages)
    ? res.data.scheduledPages
    : [];
  assert.equal(scheduled.length, 2);
  assert.deepEqual(
    scheduled.map((page) => page.slug_id),
    [`${base}-future-a`, `${base}-future-b`],
  );
  scheduled.forEach((page) => {
    assert.ok(page.publishAtLabel);
    assert.ok(page.publishAtRelative);
  });
});
