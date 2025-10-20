import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES,
  COMMENT_ATTACHMENT_MAX_SIZE,
} from "../routes/pages.js";
import { initDb, get } from "../db.js";
import { createCaptchaChallenge } from "../utils/captcha.js";
import {
  dispatchComment,
  buildCommentRequest as buildRequest,
  createTestPage as createPage,
  cleanupTestPage as cleanupPage,
} from "./helpers/commentRoute.js";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "comments");

function attachCaptcha(req) {
  const challenge = createCaptchaChallenge(req);
  if (!challenge) {
    throw new Error("Le captcha devrait être disponible pour les tests");
  }
  const answer = req.session.captchaChallenges?.[challenge.token]?.answer;
  return { challenge, answer };
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

test(
  "la soumission d'un commentaire avec une pièce jointe valide enregistre les métadonnées",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `attachment-ok-${Date.now()}`;
    const page = await createPage(slug);
    let createdFilePath;

    t.after(async () => {
      await cleanupPage(slug);
      if (createdFilePath) {
        await removeFileIfExists(createdFilePath);
      }
    });

    const req = buildRequest({
      slug,
      body: {
        author: "Alice",
        body: "Voici un document.",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    const { challenge, answer } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = answer;

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `test-${Date.now()}.png`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3]));
    createdFilePath = filePath;
    const allowedMime =
      COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES.find((type) => type.startsWith("image/")) ||
      COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES[0];

    req.files = [
      {
        fieldname: "attachments",
        originalname: "capture.png",
        encoding: "7bit",
        mimetype: allowedMime,
        destination: UPLOAD_DIR,
        filename: storedName,
        path: filePath,
        size: 4096,
      },
    ];

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    const comment = await get(
      `SELECT snowflake_id FROM comments WHERE page_id=?`,
      [page.id],
    );
    assert.ok(comment);
    const attachment = await get(
      `SELECT mime_type, file_size, original_name FROM comment_attachments WHERE comment_snowflake_id=?`,
      [comment.snowflake_id],
    );
    assert.ok(attachment);
    assert.strictEqual(attachment.mime_type, allowedMime);
    assert.strictEqual(attachment.original_name, "capture.png");
    assert.strictEqual(Number(attachment.file_size), 4096);
  },
);

test(
  "un type MIME interdit bloque la création du commentaire et nettoie le fichier",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `attachment-mime-${Date.now()}`;
    await createPage(slug);
    let createdFilePath;

    t.after(async () => {
      await cleanupPage(slug);
      if (createdFilePath) {
        await removeFileIfExists(createdFilePath);
      }
    });

    const req = buildRequest({
      slug,
      body: {
        author: "Bob",
        body: "Fichier dangereux.",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    const { challenge, answer } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = answer;

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `danger-${Date.now()}.exe`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    await fs.writeFile(filePath, Buffer.from([1, 2, 3, 4]));
    createdFilePath = filePath;

    req.files = [
      {
        fieldname: "attachments",
        originalname: "virus.exe",
        encoding: "7bit",
        mimetype: "application/x-msdownload",
        destination: UPLOAD_DIR,
        filename: storedName,
        path: filePath,
        size: 2048,
      },
    ];

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(
      messages.includes("Ce type de fichier n'est pas autorisé pour les commentaires."),
    );
    assert.ok(req.session.commentFeedback);

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(Number(commentCount.count), 0);

    await assert.rejects(fs.access(filePath), /ENOENT/);
  },
);

test(
  "un fichier trop volumineux est refusé et retiré du stockage",
  { concurrency: false },
  async (t) => {
    await initDb();
    const slug = `attachment-size-${Date.now()}`;
    await createPage(slug);
    let createdFilePath;

    t.after(async () => {
      await cleanupPage(slug);
      if (createdFilePath) {
        await removeFileIfExists(createdFilePath);
      }
    });

    const req = buildRequest({
      slug,
      body: {
        author: "Charlie",
        body: "Fichier immense.",
        captchaToken: "",
        captcha: "",
        website: "",
      },
    });

    const { challenge, answer } = attachCaptcha(req);
    req.body.captchaToken = challenge.token;
    req.body.captcha = answer;

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `huge-${Date.now()}.bin`;
    const filePath = path.join(UPLOAD_DIR, storedName);
    const oversize = COMMENT_ATTACHMENT_MAX_SIZE + 1024;
    await fs.writeFile(filePath, Buffer.alloc(oversize, 1));
    createdFilePath = filePath;

    req.files = [
      {
        fieldname: "attachments",
        originalname: "huge.bin",
        encoding: "7bit",
        mimetype: COMMENT_ATTACHMENT_ALLOWED_MIME_TYPES[0],
        destination: UPLOAD_DIR,
        filename: storedName,
        path: filePath,
        size: oversize,
      },
    ];

    const res = await dispatchComment(req);

    assert.strictEqual(res.redirectedTo, `/wiki/${slug}#comments`);
    assert.strictEqual(res.statusCode, 302);
    assert.ok(Array.isArray(req.session.notifications));
    const messages = req.session.notifications.map((notif) => notif.message);
    assert.ok(
      messages.some((message) => message.includes("Chaque fichier doit faire moins de")),
    );
    assert.ok(req.session.commentFeedback);

    const commentCount = await get(
      `SELECT COUNT(*) AS count FROM comments WHERE page_id=(SELECT id FROM pages WHERE slug_id=?)`,
      [slug],
    );
    assert.strictEqual(Number(commentCount.count), 0);

    await assert.rejects(fs.access(filePath), /ENOENT/);
  },
);
