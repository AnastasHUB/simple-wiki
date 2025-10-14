import test from "node:test";
import assert from "node:assert/strict";
import adminRouter from "../routes/admin.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";

const revertLayer = adminRouter.stack.find(
  (layer) =>
    layer.route &&
    layer.route.path === "/pages/:slugid/revisions/:revisionId/revert",
);

if (!revertLayer) {
  throw new Error(
    "Impossible de localiser la route de restauration de révision pour les tests",
  );
}

const [permissionHandler, revertHandler] = revertLayer.route.stack.map(
  (layer) => layer.handle,
);

function createResponseRecorder() {
  const res = {
    statusCode: 200,
    finished: false,
    body: null,
    view: null,
    data: null,
    jsonBody: null,
    redirectLocation: null,
    locals: {},
    headers: {},
  };

  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };

  res.render = function render(view, data) {
    this.view = view;
    this.data = data;
    this.finished = true;
    return this;
  };

  res.json = function json(body) {
    this.jsonBody = body;
    this.finished = true;
    return this;
  };

  res.send = function send(body) {
    this.body = body;
    this.finished = true;
    return this;
  };

  res.redirect = function redirect(location) {
    this.redirectLocation = location;
    this.finished = true;
    return this;
  };

  res.set = function set(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  };

  return res;
}

function createRequest({ slug, revisionId, permissionFlags, sessionUser }) {
  const session = {
    user: sessionUser || null,
    notifications: [],
    csrfToken: "token",
  };

  return {
    method: "POST",
    params: { slugid: slug, revisionId: String(revisionId) },
    session,
    permissionFlags: permissionFlags || {},
    body: { _csrf: "token" },
    headers: {},
    protocol: "http",
    originalUrl: `/admin/pages/${slug}/revisions/${revisionId}/revert`,
    accepts(types) {
      if (Array.isArray(types) && types.length) {
        return types[0];
      }
      return typeof types === "string" ? types : "html";
    },
    get() {
      return "";
    },
  };
}

async function dispatchRevertRoute(req, res) {
  let allowed = false;

  await new Promise((resolve, reject) => {
    try {
      permissionHandler(req, res, (err) => {
        if (err) {
          reject(err);
          return;
        }
        allowed = true;
        resolve();
      });
      if (res.finished && !allowed) {
        resolve();
      }
    } catch (err) {
      reject(err);
    }
  });

  if (!allowed || res.finished) {
    return res;
  }

  await revertHandler(req, res);
  return res;
}

async function createPageWithRevisions({ slug, revisions, title, content }) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, title, content, "auteur"],
  );
  const page = await get(
    "SELECT id, snowflake_id, title, content FROM pages WHERE slug_id=?",
    [slug],
  );
  for (const revision of revisions) {
    await run(
      `INSERT INTO page_revisions(page_id, revision, snowflake_id, title, content, author_id)
       VALUES(?,?,?,?,?,NULL)`,
      [
        page.id,
        revision.number,
        generateSnowflake(),
        revision.title,
        revision.content,
      ],
    );
  }
  return page;
}

async function createTestUser(username) {
  await run(
    "INSERT INTO users(snowflake_id, username, password) VALUES(?,?,?)",
    [generateSnowflake(), username, "password"],
  );
  return get("SELECT id, username FROM users WHERE username=?", [username]);
}

async function cleanupUser(userId) {
  if (userId) {
    await run("DELETE FROM users WHERE id=?", [userId]);
  }
}

async function cleanupPage(pageId, slug, username) {
  await run("DELETE FROM page_revisions WHERE page_id=?", [pageId]);
  await run("DELETE FROM pages WHERE id=?", [pageId]);
  if (typeof username === "string") {
    await run("DELETE FROM event_logs WHERE type='Page reverted' AND username=?", [
      username,
    ]);
  } else {
    await run(
      "DELETE FROM event_logs WHERE type='Page reverted' AND username IS NULL",
    );
  }
}

test("restauration de révision côté admin", async (t) => {
  await initDb();

  const slug = `revert-test-${Date.now()}`;
  const adminRecord = await createTestUser(`admin-test-${Date.now()}`);
  const adminUser = {
    id: adminRecord.id,
    username: adminRecord.username,
    is_admin: false,
  };
  const page = await createPageWithRevisions({
    slug,
    title: "Titre courant",
    content: "Contenu courant",
    revisions: [
      { number: 1, title: "Titre initial", content: "Ancien contenu" },
      { number: 2, title: "Titre courant", content: "Contenu courant" },
    ],
  });

  t.after(async () => {
    await cleanupPage(page.id, slug, adminUser.username);
    await cleanupUser(adminRecord.id);
  });

  const req = createRequest({
    slug,
    revisionId: 1,
    permissionFlags: { can_revert_page_history: true },
    sessionUser: adminUser,
  });
  const res = createResponseRecorder();

  await dispatchRevertRoute(req, res);

  assert.strictEqual(res.redirectLocation, `/wiki/${slug}/history`);
  assert.ok(
    req.session.notifications.some((notif) => notif.type === "success"),
    "Une notification de succès doit être enregistrée",
  );

  const updatedPage = await get(
    "SELECT title, content, slug_base FROM pages WHERE id=?",
    [page.id],
  );
  assert.deepEqual(updatedPage, {
    title: "Titre initial",
    content: "Ancien contenu",
    slug_base: "titre-initial",
  });

  const latestRevision = await get(
    `SELECT revision, title, content
       FROM page_revisions
      WHERE page_id=?
      ORDER BY revision DESC
      LIMIT 1`,
    [page.id],
  );

  assert.strictEqual(latestRevision.revision, 3);
  assert.strictEqual(latestRevision.title, "Titre initial");
  assert.strictEqual(latestRevision.content, "Ancien contenu");

  const logEntry = await get(
    `SELECT type FROM event_logs
      WHERE type='Page reverted' AND username=?
      ORDER BY rowid DESC
      LIMIT 1`,
    [adminUser.username],
  );
  assert.ok(logEntry, "L'action doit être consignée dans les journaux admin");
});

test("la restauration échoue sans la permission adéquate", async (t) => {
  await initDb();

  const slug = `revert-denied-${Date.now()}`;
  const page = await createPageWithRevisions({
    slug,
    title: "Titre courant",
    content: "Contenu courant",
    revisions: [
      { number: 1, title: "Titre initial", content: "Ancien contenu" },
      { number: 2, title: "Titre courant", content: "Contenu courant" },
    ],
  });

  t.after(async () => {
    await cleanupPage(page.id, slug);
  });

  const req = createRequest({ slug, revisionId: 1, permissionFlags: {} });
  const res = createResponseRecorder();

  await dispatchRevertRoute(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.view, "error");

  const persisted = await get(
    "SELECT title, content FROM pages WHERE id=?",
    [page.id],
  );
  assert.strictEqual(persisted.title, "Titre courant");
  assert.strictEqual(persisted.content, "Contenu courant");

  const revisionCount = await get(
    "SELECT COUNT(*) AS c FROM page_revisions WHERE page_id=?",
    [page.id],
  );
  assert.strictEqual(revisionCount.c, 2);
});
