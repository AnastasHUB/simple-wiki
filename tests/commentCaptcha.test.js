import test from "node:test";
import assert from "node:assert/strict";

import { initDb, get } from "../db.js";
import { createCaptchaChallenge } from "../utils/captcha.js";
import {
  dispatchComment,
  buildCommentRequest as buildRequest,
  createTestPage as createPage,
  cleanupTestPage as cleanupPage,
} from "./helpers/commentRoute.js";

function attachCaptcha(req) {
  const challenge = createCaptchaChallenge(req);
  if (!challenge) {
    throw new Error("Le captcha devrait être disponible pour les tests");
  }
  const answer = req.session.captchaChallenges?.[challenge.token]?.answer;
  return { challenge, answer };
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

    const req = buildRequest({
      slug,
      body: {
        author: "Cap",
        body: "Bonjour le monde",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    const { challenge, answer } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = answer;

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    assert.match(req.session.notifications.at(-1).message, /Merci !/);

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
  "la création de commentaire redirige même si l'envoi du webhook échoue",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `captcha-webhook-fail-${Date.now()}`;
    const page = await createPage(slug);

    t.after(async () => {
      await cleanupPage(slug);
    });

    const req = buildRequest({
      slug,
      body: {
        author: "Cap",
        body: "Webhook en panne",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    let sendAttemptCount = 0;
    req.app = {
      locals: {
        sendAdminEvent: async () => {
          sendAttemptCount += 1;
          throw new Error("Webhook indisponible");
        },
      },
    };

    const { challenge, answer } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = answer;

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(sendAttemptCount, 1);

    const insertedComment = await get(
      `SELECT page_id, author, body, status FROM comments WHERE page_id=?`,
      [page.id],
    );
    assert.ok(insertedComment);
    assert.strictEqual(insertedComment.body, "Webhook en panne");
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

    const req = buildRequest({
      slug,
      body: {
        author: "Cap",
        body: "Message sans captcha",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    const { challenge } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = "réponse incorrecte";

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(
      messages.includes("Merci de répondre correctement à la question anti-spam."),
    );
    assert.ok(req.session.commentFeedback);

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(commentCount.count, 0);
  },
);

test(
  "la validation serveur bloque avant la vérification du captcha en cas d'erreurs",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `captcha-validation-first-${Date.now()}`;
    await createPage(slug);

    t.after(async () => {
      await cleanupPage(slug);
    });

    const req = buildRequest({
      slug,
      body: {
        author: "",
        body: "   ",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    attachCaptcha(req);

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(messages.includes("Le message est requis."));

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(commentCount.count, 0);
  },
);
