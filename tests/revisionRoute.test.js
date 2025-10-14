import test from "node:test";
import assert from "node:assert/strict";
import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

const revisionLayer = pagesRouter.stack.find(
  (layer) => layer.route && layer.route.path === "/wiki/:slugid/revisions/:revisionId",
);

if (!revisionLayer) {
  throw new Error("Impossible de localiser la route de révision pour les tests");
}

const [requireAdminHandler, revisionHandler] = revisionLayer.route.stack.map(
  (layer) => layer.handle,
);

function createResponseRecorder() {
  const recorder = {
    statusCode: 200,
    body: null,
    view: null,
    data: null,
    locals: {},
  };
  recorder.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  recorder.render = function render(view, data) {
    this.view = view;
    this.data = data;
    return this;
  };
  recorder.send = function send(body) {
    this.body = body;
    return this;
  };
  recorder.redirect = function redirect(location) {
    this.redirectLocation = location;
    return this;
  };
  return recorder;
}

function dispatchRevisionRoute(req, res) {
  return new Promise((resolve, reject) => {
    const finalize = () => resolve(res);
    const fail = (err) => reject(err);
    const next = (err) => {
      if (err) {
        fail(err);
      } else {
        finalize();
      }
    };
    try {
      requireAdminHandler(req, res, (err) => {
        if (err) {
          fail(err);
          return;
        }
        try {
          res.render = function render(view, data) {
            this.view = view;
            this.data = data;
            finalize();
            return this;
          };
          res.send = function send(body) {
            this.body = body;
            finalize();
            return this;
          };
          revisionHandler(req, res, next);
        } catch (handlerErr) {
          fail(handlerErr);
        }
      });
    } catch (outerErr) {
      fail(outerErr);
    }
  });
}

async function createPageWithRevisions({ slug, revisions }) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu initial", "auteur"],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id=?", [slug]);
  for (const revision of revisions) {
    await run(
      `INSERT INTO page_revisions(page_id, revision, snowflake_id, title, content, author_id)
       VALUES(?,?,?,?,?,NULL)`,
      [page.id, revision.number, generateSnowflake(), revision.title, revision.content],
    );
  }
  return page.id;
}

async function cleanupPage(pageId, slug) {
  await run("DELETE FROM page_revisions WHERE page_id=?", [pageId]);
  await run("DELETE FROM pages WHERE id=?", [pageId]);
  await run("DELETE FROM pages WHERE slug_id=?", [slug]);
}

test("la route des révisions produit un diff et gère les cas limites", async (t) => {
  await initDb();
  const slug = `test-revision-${Date.now()}`;
  const pageId = await createPageWithRevisions({
    slug,
    revisions: [
      { number: 1, title: "R1", content: "Ligne 1\nLigne 2" },
      { number: 2, title: "R2", content: "Ligne 1\nLigne 2 modifiée" },
    ],
  });

  t.after(async () => {
    await cleanupPage(pageId, slug);
  });

  await t.test("diff explicite entre deux révisions", async () => {
    const req = {
      params: { slugid: slug, revisionId: "2" },
      query: { compare: "1" },
      session: { user: { is_admin: true } },
      locals: {},
    };
    const res = createResponseRecorder();
    await dispatchRevisionRoute(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.view, "revision");
    assert.ok(res.data.diffHtml, "le diff doit être présent");
    assert.strictEqual(res.data.compareRevision.revision, 1);
  });

  await t.test("fallback sur la révision précédente quand compare est absent", async () => {
    const req = {
      params: { slugid: slug, revisionId: "2" },
      query: {},
      session: { user: { is_admin: true } },
      locals: {},
    };
    const res = createResponseRecorder();
    await dispatchRevisionRoute(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.view, "revision");
    assert.ok(res.data.compareRevision, "une révision de comparaison doit être chargée");
    assert.strictEqual(res.data.compareRevision.revision, 1);
  });

  await t.test("retour 404 quand la révision de comparaison est inconnue", async () => {
    const req = {
      params: { slugid: slug, revisionId: "2" },
      query: { compare: "999" },
      session: { user: { is_admin: true } },
      locals: {},
    };
    const res = createResponseRecorder();
    await dispatchRevisionRoute(req, res);
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body || "", /introuvable/i);
  });

  await t.test("aucun diff lorsqu'il n'existe pas de révision précédente", async () => {
    const slugSolo = `test-revision-solo-${Date.now()}`;
    const soloPageId = await createPageWithRevisions({
      slug: slugSolo,
      revisions: [{ number: 1, title: "R1", content: "Unique" }],
    });
    t.after(async () => {
      await cleanupPage(soloPageId, slugSolo);
    });
    const req = {
      params: { slugid: slugSolo, revisionId: "1" },
      query: {},
      session: { user: { is_admin: true } },
      locals: {},
    };
    const res = createResponseRecorder();
    await dispatchRevisionRoute(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.view, "revision");
    assert.strictEqual(res.data.diffHtml, null);
    assert.ok(Array.isArray(res.data.compareOptions));
    assert.strictEqual(res.data.compareOptions.length, 0);
  });
});
