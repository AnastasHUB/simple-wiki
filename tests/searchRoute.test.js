import test from "node:test";
import assert from "node:assert/strict";
import searchRouter from "../routes/search.js";
import {
  initDb,
  run,
  get,
  isFtsAvailable,
  savePageFts,
} from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

await initDb();

const searchLayer = searchRouter.stack.find(
  (layer) => layer.route && layer.route.path === "/search",
);

if (!searchLayer) {
  throw new Error("Impossible de localiser la route /search pour les tests");
}

const searchHandler = searchLayer.route.stack[0].handle;

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

function dispatchSearchRoute(req) {
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
      searchHandler(req, res, (err) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        finalize();
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureTag(name) {
  const existing = await get("SELECT id FROM tags WHERE name = ?", [name]);
  if (existing) {
    return existing.id;
  }
  await run(
    "INSERT INTO tags(snowflake_id, name) VALUES(?, ?)",
    [generateSnowflake(), name],
  );
  const inserted = await get("SELECT id FROM tags WHERE name = ?", [name]);
  return inserted.id;
}

async function createPageFixture({
  slug,
  title,
  content,
  author,
  publishAt,
  tags,
  status = "published",
}) {
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      generateSnowflake(),
      slug,
      slug,
      title,
      content,
      author,
      status,
      publishAt,
      publishAt,
      publishAt,
    ],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id = ?", [slug]);
  for (const tagName of tags) {
    const tagId = await ensureTag(tagName);
    await run(
      "INSERT OR IGNORE INTO page_tags(page_id, tag_id, snowflake_id) VALUES(?,?,?)",
      [page.id, tagId, generateSnowflake()],
    );
  }

  if (isFtsAvailable()) {
    await savePageFts({
      id: page.id,
      title,
      content,
      slug_id: slug,
      tags: tags.join(" "),
    });
  }

  return page.id;
}

async function createSearchFixtures() {
  const suffix = `${Date.now().toString(36)}${Math.round(Math.random() * 1000).toString(36)}`;
  const keyword = `orbston${suffix}`;
  const tags = {
    alpha: `Alpha-${suffix}`,
    beta: `Beta-${suffix}`,
    gamma: `Gamma-${suffix}`,
  };
  const authors = {
    alice: `Alice-${suffix}`,
    bob: `Bob-${suffix}`,
  };

  const firstSlug = `search-${suffix}-1`;
  const secondSlug = `search-${suffix}-2`;
  const thirdSlug = `search-${suffix}-3`;

  const pageOneId = await createPageFixture({
    slug: firstSlug,
    title: `Guide ${keyword} avancé`,
    content: `Contenu ${keyword} avec un focus approfondi`,
    author: authors.alice,
    publishAt: "2024-01-10T09:00:00.000Z",
    tags: [tags.alpha, tags.beta],
  });

  const pageTwoId = await createPageFixture({
    slug: secondSlug,
    title: `Introduction ${keyword}`,
    content: `Tutoriel ${keyword} pour démarrer rapidement`,
    author: authors.bob,
    publishAt: "2024-01-05T09:00:00.000Z",
    tags: [tags.beta, tags.gamma],
  });

  const pageThreeId = await createPageFixture({
    slug: thirdSlug,
    title: `Notes ${keyword}`,
    content: `Journal ${keyword} et expériences associées`,
    author: authors.alice,
    publishAt: "2023-12-25T09:00:00.000Z",
    tags: [tags.alpha],
  });

  return {
    keyword,
    authors,
    tags,
    pages: {
      first: { id: pageOneId, slug: firstSlug },
      second: { id: pageTwoId, slug: secondSlug },
      third: { id: pageThreeId, slug: thirdSlug },
    },
    pageIds: [pageOneId, pageTwoId, pageThreeId],
    tagNames: Object.values(tags),
  };
}

async function cleanupFixtures(fixtures) {
  if (!fixtures) {
    return;
  }
  const ftsActive = isFtsAvailable();
  for (const pageId of fixtures.pageIds) {
    await run("DELETE FROM pages WHERE id = ?", [pageId]);
    if (ftsActive) {
      await run("DELETE FROM pages_fts WHERE rowid = ?", [pageId]);
    }
  }
  for (const tagName of fixtures.tagNames) {
    const tag = await get("SELECT id FROM tags WHERE name = ?", [tagName]);
    if (tag) {
      await run("DELETE FROM page_tags WHERE tag_id = ?", [tag.id]);
      await run("DELETE FROM tags WHERE id = ?", [tag.id]);
    }
  }
}

function buildReq(query) {
  return {
    method: "GET",
    query,
    path: "/search",
    originalUrl: "/search",
    url: "/search",
    baseUrl: "",
  };
}

test("la recherche supporte filtrage et tri", async (t) => {
  const fixtures = await createSearchFixtures();

  t.after(async () => {
    await cleanupFixtures(fixtures);
  });

  await t.test("filtrage par auteur et date de publication", async () => {
    const req = buildReq({
      q: fixtures.keyword,
      author: fixtures.authors.alice,
      start: "2024-01-01",
    });
    const res = await dispatchSearchRoute(req);
    assert.equal(res.view, "search");
    const slugs = res.data.rows.map((row) => row.slug_id);
    assert.deepEqual(slugs, [fixtures.pages.first.slug]);
    assert.equal(res.data.filters.author, fixtures.authors.alice);
    assert.equal(res.data.filters.startDate, "2024-01-01");
    assert.equal(res.data.filters.sortKey, "relevance");
  });

  await t.test("filtrage combiné sur plusieurs tags", async () => {
    const req = buildReq({
      q: fixtures.keyword,
      tag: [fixtures.tags.alpha, fixtures.tags.beta],
    });
    const res = await dispatchSearchRoute(req);
    assert.equal(res.view, "search");
    const slugs = res.data.rows.map((row) => row.slug_id);
    assert.deepEqual(slugs, [fixtures.pages.first.slug]);
    assert.ok(res.data.filters.displayTags.length >= 2);
    const labels = res.data.filters.displayTags.map((tag) => tag.label).sort();
    assert.deepEqual(labels, [fixtures.tags.alpha, fixtures.tags.beta].sort());
  });

  await t.test("tri explicite par date de publication croissante", async () => {
    const req = buildReq({
      q: fixtures.keyword,
      sort: "published_asc",
    });
    const res = await dispatchSearchRoute(req);
    assert.equal(res.view, "search");
    const slugs = res.data.rows.map((row) => row.slug_id);
    assert.deepEqual(slugs.slice(0, 3), [
      fixtures.pages.third.slug,
      fixtures.pages.second.slug,
      fixtures.pages.first.slug,
    ]);
    assert.equal(res.data.filters.sortKey, "published_asc");
    assert.equal(res.data.pagination.totalItems, 3);
  });
});

test("les pages planifiées déjà éligibles sont visibles avant l'exécution du scheduler", async (t) => {
  const suffix = `${Date.now().toString(36)}${Math.round(Math.random() * 1000).toString(36)}`;
  const keyword = `schedule${suffix}`;
  const slug = `scheduled-${suffix}`;
  const publishAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const author = `Scheduler-${suffix}`;

  const pageId = await createPageFixture({
    slug,
    title: `Planification ${keyword}`,
    content: `Contenu ${keyword} déjà disponible`,
    author,
    publishAt,
    tags: [],
    status: "scheduled",
  });

  t.after(async () => {
    await cleanupFixtures({ pageIds: [pageId], tagNames: [] });
  });

  const res = await dispatchSearchRoute(
    buildReq({
      q: keyword,
    }),
  );

  assert.equal(res.view, "search");
  const slugs = res.data.rows.map((row) => row.slug_id);
  assert.ok(
    slugs.includes(slug),
    "La page planifiée dont la date est passée devrait apparaître dans les résultats",
  );
});
