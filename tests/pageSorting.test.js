import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ejs from "ejs";

import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import {
  fetchPaginatedPages,
  PAGE_SORT_MODES,
} from "../utils/pageService.js";
import { generateSnowflake } from "../utils/snowflake.js";

await initDb();

function uniqueSlug(prefix = "sort-test") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function createPageFixture({
  createdAt,
  likes = 0,
  views = 0,
  title = "Page de test",
  content = "Contenu de test",
}) {
  const slug = uniqueSlug("sort");
  const snowflake = generateSnowflake();
  const timestamp = createdAt ?? new Date().toISOString();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      snowflake,
      slug,
      slug,
      title,
      content,
      "Testeur",
      "published",
      timestamp,
      timestamp,
    ],
  );
  const pageRow = await get("SELECT id, slug_id FROM pages WHERE snowflake_id = ?", [snowflake]);
  if (!pageRow) {
    throw new Error("La création de page a échoué");
  }
  if (likes > 0) {
    for (let index = 0; index < likes; index += 1) {
      await run(
        "INSERT INTO likes(snowflake_id, page_id, ip) VALUES(?,?,?)",
        [generateSnowflake(), pageRow.id, `198.51.100.${index + 1}`],
      );
    }
  }
  if (views > 0) {
    const day = timestamp.slice(0, 10);
    await run(
      "INSERT INTO page_view_daily(page_id, day, snowflake_id, views) VALUES(?,?,?,?)",
      [pageRow.id, day, generateSnowflake(), views],
    );
  }
  return { id: pageRow.id, slug: pageRow.slug_id };
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    view: null,
    data: null,
    redirectLocation: null,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(field, value) {
      this.headers[field] = value;
      return this;
    },
  };
}

function dispatchRoute(handler, req) {
  const res = createResponseRecorder();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finalize = () => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };
    res.render = function render(view, data) {
      this.view = view;
      this.data = data;
      finalize();
      return this;
    };
    res.redirect = function redirect(location) {
      this.redirectLocation = location;
      finalize();
      return this;
    };
    try {
      handler(req, res, (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        finalize();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function renderIndexView(data) {
  const viewPath = path.join(process.cwd(), "views", "index.ejs");
  return new Promise((resolve, reject) => {
    ejs.renderFile(viewPath, data, {}, (err, html) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(html);
    });
  });
}

test("fetchPaginatedPages respecte le tri demandé", async () => {
  const newestPage = await createPageFixture({
    createdAt: "2199-03-01T00:00:00.000Z",
    likes: 2,
    views: 5,
    title: "Dernière arrivée",
  });
  const viewedPage = await createPageFixture({
    createdAt: "2199-02-01T00:00:00.000Z",
    likes: 1,
    views: 50,
    title: "Très consultée",
  });
  const likedPage = await createPageFixture({
    createdAt: "2199-01-01T00:00:00.000Z",
    likes: 8,
    views: 10,
    title: "Plébiscitée",
  });
  const insertedSlugs = [newestPage.slug, viewedPage.slug, likedPage.slug];

  try {
    const newest = await fetchPaginatedPages({
      ip: null,
      limit: 20,
      offset: 0,
      allowedRoleSnowflakes: null,
      sort: PAGE_SORT_MODES.NEWEST,
    });
    const newestRelevant = newest.filter((row) => insertedSlugs.includes(row.slug_id));
    assert.deepEqual(
      newestRelevant.map((row) => row.slug_id),
      [newestPage.slug, viewedPage.slug, likedPage.slug],
      "Les plus récents devraient être classés par date décroissante",
    );

    const mostViewed = await fetchPaginatedPages({
      ip: null,
      limit: 20,
      offset: 0,
      allowedRoleSnowflakes: null,
      sort: PAGE_SORT_MODES.MOST_VIEWED,
    });
    const mostViewedRelevant = mostViewed.filter((row) => insertedSlugs.includes(row.slug_id));
    assert.deepEqual(
      mostViewedRelevant.map((row) => row.slug_id),
      [viewedPage.slug, likedPage.slug, newestPage.slug],
      "Le tri par vues devrait faire apparaître la page la plus consultée en premier",
    );

    const mostLiked = await fetchPaginatedPages({
      ip: null,
      limit: 20,
      offset: 0,
      allowedRoleSnowflakes: null,
      sort: PAGE_SORT_MODES.MOST_LIKED,
    });
    const mostLikedRelevant = mostLiked.filter((row) => insertedSlugs.includes(row.slug_id));
    assert.deepEqual(
      mostLikedRelevant.map((row) => row.slug_id),
      [likedPage.slug, newestPage.slug, viewedPage.slug],
      "Le tri par likes devrait faire apparaître la page la plus aimée en premier",
    );
  } finally {
    await run(
      `DELETE FROM pages WHERE slug_id IN (${insertedSlugs.map(() => "?").join(", ")})`,
      insertedSlugs,
    );
  }
});

test("la page d'accueil reflète l'option de tri sélectionnée", async () => {
  const page = await createPageFixture({
    createdAt: "2199-04-01T00:00:00.000Z",
    likes: 3,
    views: 15,
    title: "Page pour l'accueil",
  });

  const layer = pagesRouter.stack.find(
    (candidate) => candidate.route && candidate.route.path === "/" && candidate.route.methods.get,
  );
  assert.ok(layer, "La route GET / devrait exister");
  const handler = layer.route.stack[0].handle;

  const req = {
    clientIp: "198.51.100.200",
    query: { sort: PAGE_SORT_MODES.MOST_LIKED },
    session: { user: null },
    permissionFlags: {},
  };

  try {
    const res = await dispatchRoute(handler, req);
    assert.equal(res.view, "index", "La vue index devrait être rendue");
    assert.ok(Array.isArray(res.data?.sortOptions), "Les options de tri devraient être présentes");

    const html = await renderIndexView(res.data);
    const selectedPattern = new RegExp(
      `<option\\s+value=\"${PAGE_SORT_MODES.MOST_LIKED}\"[^>]*selected`,
      "i",
    );
    assert.match(
      html,
      selectedPattern,
      "L'option sélectionnée doit apparaître avec l'attribut selected",
    );
  } finally {
    await run("DELETE FROM pages WHERE slug_id = ?", [page.slug]);
  }
});
