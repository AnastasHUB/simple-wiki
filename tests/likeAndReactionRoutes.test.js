import test from "node:test";
import assert from "node:assert/strict";

import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  setBotDetectionFetchImplementation,
  clearBotDetectionCache,
} from "../utils/ip.js";
import { banUserAction } from "../utils/userActionBans.js";

function findRouteHandler(path, method = "post") {
  const layer = pagesRouter.stack.find((entry) => {
    if (!entry.route) return false;
    if (entry.route.path !== path) return false;
    return Boolean(entry.route.methods?.[method]);
  });
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} introuvable`);
  }
  const handlers = layer.route.stack.map((stackLayer) => stackLayer.handle);
  const lastHandler = handlers.at(-1);
  if (!lastHandler) {
    throw new Error(`Gestionnaire introuvable pour ${method.toUpperCase()} ${path}`);
  }
  return lastHandler;
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
  res.redirect = function redirect(location) {
    if (this.statusCode === 200) {
      this.statusCode = 302;
    }
    headers.set("location", location);
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };
  return res;
}

function dispatch(handler, req) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let recorder;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(recorder);
    };
    recorder = createResponseRecorder(finish);
    try {
      const maybePromise = handler(req, recorder, (err) => {
        if (settled) {
          return;
        }
        if (err) {
          settled = true;
          reject(err);
          return;
        }
        finish();
      });
      if (
        maybePromise &&
        typeof maybePromise.then === "function" &&
        typeof maybePromise.catch === "function"
      ) {
        maybePromise.then(() => {
          finish();
        }, (err) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(err);
        });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function buildJsonRequest({
  slug,
  body = {},
  ip = "198.51.100.10",
  userAgent = "Mozilla/5.0 (compatible; ExampleBot/1.0)",
  sessionUser = { username: "Tester" },
  appLocals = {},
}) {
  const headerStore = new Map([
    ["x-requested-with", "XMLHttpRequest"],
    ["accept", "application/json"],
  ]);
  return {
    params: { slugid: slug },
    body,
    headers: Object.fromEntries(headerStore.entries()),
    get(name) {
      return headerStore.get(String(name).toLowerCase()) || "";
    },
    clientIp: ip,
    clientUserAgent: userAgent,
    session: { user: sessionUser },
    app: { locals: { ...appLocals } },
  };
}

const likeHandler = findRouteHandler("/wiki/:slugid/like");
const reactionHandler = findRouteHandler("/wiki/:slugid/reactions");

test("la route des favoris ignore les erreurs de webhook", async (t) => {
  await initDb();
  setBotDetectionFetchImplementation(async () => ({
    ok: true,
    json: async () => ({ client: { type: "browser" } }),
  }));
  clearBotDetectionCache();

  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  const slug = `like-${Date.now()}`;
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id=?", [slug]);

  t.after(async () => {
    await run("DELETE FROM likes WHERE page_id=?", [page.id]);
    await run("DELETE FROM pages WHERE id=?", [page.id]);
  });

  const errors = [];
  const request = buildJsonRequest({
    slug,
    appLocals: {
      sendAdminEvent: async () => {
        throw new Error("Webhook indisponible");
      },
      logger: {
        error: (...args) => {
          errors.push(args);
        },
      },
    },
  });

  const response = await dispatch(likeHandler, request);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    liked: true,
    likes: 1,
    slug,
    notifications: [
      {
        type: "success",
        message: "Article ajouté à vos favoris.",
        timeout: 3000,
      },
    ],
  });

  const total = await get(
    "SELECT COUNT(*) AS totalLikes FROM likes WHERE page_id=?",
    [page.id],
  );
  assert.equal(total.totalLikes, 1);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Failed to send admin event: Like added/);
});

test("une restriction utilisateur empêche d'ajouter un favori", async (t) => {
  await initDb();
  setBotDetectionFetchImplementation(async () => ({
    ok: true,
    json: async () => ({ client: { type: "browser" } }),
  }));
  clearBotDetectionCache();

  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  const slug = `like-ban-${Date.now()}`;
  const pageSnowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [pageSnowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id=?", [slug]);

  const userSnowflake = generateSnowflake();
  const username = `User${Date.now()}`;
  await run(
    `INSERT INTO users(snowflake_id, username, password)
     VALUES(?,?,?)`,
    [userSnowflake, username, "x"],
  );
  const user = await get("SELECT id FROM users WHERE username=?", [username]);

  t.after(async () => {
    await run("DELETE FROM user_action_bans WHERE user_id=?", [user.id]);
    await run("DELETE FROM likes WHERE page_id=?", [page.id]);
    await run("DELETE FROM pages WHERE id=?", [page.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  });

  await banUserAction({
    userId: user.id,
    scope: "action",
    value: "like",
    reason: "Test",
  });

  const request = buildJsonRequest({
    slug,
    sessionUser: { id: user.id, username },
    appLocals: {
      sendAdminEvent: async () => {},
    },
  });

  const response = await dispatch(likeHandler, request);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.ok, false);
  assert.ok(response.body.ban);
  assert.equal(response.body.ban.subject, "user");
  assert.equal(response.body.message, "Action interdite : Test");
  assert.ok(Array.isArray(response.body.notifications));
  const notificationMessage = response.body.notifications[0]?.message || "";
  assert.ok(!notificationMessage.includes("demande de déban"));
  assert.ok(!response.body.redirect);
});

test("une restriction globale empêche un compte d'ajouter un favori", async (t) => {
  await initDb();
  setBotDetectionFetchImplementation(async () => ({
    ok: true,
    json: async () => ({ client: { type: "browser" } }),
  }));
  clearBotDetectionCache();

  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  const slug = `global-like-${Date.now()}`;
  const pageSnowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [pageSnowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  const page = await get("SELECT id FROM pages WHERE slug_id=?", [slug]);

  const userSnowflake = generateSnowflake();
  const username = `User${Date.now()}-global`;
  await run(
    `INSERT INTO users(snowflake_id, username, password)
     VALUES(?,?,?)`,
    [userSnowflake, username, "x"],
  );
  const user = await get("SELECT id FROM users WHERE username=?", [username]);

  t.after(async () => {
    await run("DELETE FROM user_action_bans WHERE user_id=?", [user.id]);
    await run("DELETE FROM likes WHERE page_id=?", [page.id]);
    await run("DELETE FROM pages WHERE id=?", [page.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  });

  await banUserAction({
    userId: user.id,
    scope: "global",
    reason: "Sanction globale",
  });

  const request = buildJsonRequest({
    slug,
    sessionUser: { id: user.id, username },
    appLocals: {
      sendAdminEvent: async () => {},
    },
  });

  const response = await dispatch(likeHandler, request);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.ok, false);
  assert.ok(response.body.ban);
  assert.equal(response.body.ban.subject, "user");
  assert.equal(response.body.ban.scope, "global");
  assert.equal(response.body.message, "Accès interdit : Sanction globale");
  assert.ok(Array.isArray(response.body.notifications));
  assert.ok(!response.body.redirect);
});

test("la route des réactions gère un échec de webhook", async (t) => {
  await initDb();
  setBotDetectionFetchImplementation(async () => ({
    ok: true,
    json: async () => ({ client: { type: "browser" } }),
  }));
  clearBotDetectionCache();

  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  const slug = `reaction-${Date.now()}`;
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  const page = await get("SELECT id, slug_id FROM pages WHERE slug_id=?", [slug]);

  t.after(async () => {
    await run("DELETE FROM page_reactions WHERE page_id=?", [page.id]);
    await run("DELETE FROM pages WHERE id=?", [page.id]);
    await run("DELETE FROM reaction_options WHERE reaction_key=?", ["heart"]);
  });

  const reactionSnowflake = generateSnowflake();
  await run(
    `INSERT INTO reaction_options(
        snowflake_id,
        reaction_key,
        label,
        emoji,
        image_url,
        display_order
      )
      VALUES(?,?,?,?,?,?)`,
    [reactionSnowflake, "heart", "Réaction cœur", "❤️", null, 1],
  );

  const errors = [];
  const request = buildJsonRequest({
    slug,
    body: { reaction: "heart" },
    appLocals: {
      sendAdminEvent: async () => {
        throw new Error("Webhook indisponible");
      },
      logger: {
        error: (...args) => {
          errors.push(args);
        },
      },
    },
  });

  const response = await dispatch(reactionHandler, request);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.target, "page");
  assert.equal(response.body.slug, slug);
  assert.equal(response.body.reaction, "heart");
  assert.equal(response.body.added, true);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Failed to send admin event: Reaction added/);

  const reactionSummary = response.body.reactions.find(
    (entry) => entry.key === "heart",
  );
  assert.ok(reactionSummary, "La réaction heart doit être présente");
  assert.equal(reactionSummary.count, 1);
  assert.equal(reactionSummary.reacted, true);

  const totals = await get(
    "SELECT COUNT(*) AS totalReactions FROM page_reactions WHERE page_id=?",
    [page.id],
  );
  assert.equal(totals.totalReactions, 1);
});

test("la route des réactions refuse une option supprimée", async (t) => {
  await initDb();
  setBotDetectionFetchImplementation(async () => ({
    ok: true,
    json: async () => ({ client: { type: "browser" } }),
  }));
  clearBotDetectionCache();

  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  const slug = `reaction-deleted-${Date.now()}`;
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  const page = await get("SELECT id, slug_id FROM pages WHERE slug_id=?", [slug]);

  await run("DELETE FROM reaction_options");
  const heartSnowflake = generateSnowflake();
  const starSnowflake = generateSnowflake();
  await run(
    `INSERT INTO reaction_options(
        snowflake_id,
        reaction_key,
        label,
        emoji,
        image_url,
        display_order
      )
      VALUES(?,?,?,?,?,?)`,
    [heartSnowflake, "heart", "Réaction cœur", "❤️", null, 1],
  );
  await run(
    `INSERT INTO reaction_options(
        snowflake_id,
        reaction_key,
        label,
        emoji,
        image_url,
        display_order
      )
      VALUES(?,?,?,?,?,?)`,
    [starSnowflake, "star", "Réaction étoile", "⭐", null, 2],
  );

  t.after(async () => {
    await run("DELETE FROM page_reactions WHERE page_id=?", [page.id]);
    await run("DELETE FROM pages WHERE id=?", [page.id]);
    await run("DELETE FROM reaction_options WHERE reaction_key IN (?, ?)", [
      "heart",
      "star",
    ]);
  });

  await run("DELETE FROM reaction_options WHERE reaction_key=?", ["heart"]);

  const request = buildJsonRequest({
    slug,
    body: { reaction: "heart" },
    appLocals: {
      sendAdminEvent: async () => {},
    },
  });

  const response = await dispatch(reactionHandler, request);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    ok: false,
    message: "Réaction introuvable.",
  });

  const totals = await get(
    "SELECT COUNT(*) AS totalReactions FROM page_reactions WHERE page_id=?",
    [page.id],
  );
  assert.equal(totals.totalReactions, 0);
});
