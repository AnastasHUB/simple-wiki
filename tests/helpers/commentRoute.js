import pagesRouter from "../../routes/pages.js";
import { run, get } from "../../db.js";
import { generateSnowflake } from "../../utils/snowflake.js";

export function findRouteHandlers(path, method = "post") {
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

export function createResponseRecorder(onDone) {
  const headers = new Map();
  const res = {
    statusCode: 200,
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

  res.redirect = function redirect(url) {
    if (typeof url === "number") {
      this.statusCode = url;
      return this;
    }
    if (this.statusCode === 200) {
      this.statusCode = 302;
    }
    this.redirectedTo = url;
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

  res.json = function json(payload) {
    this.body = payload;
    if (typeof onDone === "function") {
      onDone();
    }
    return this;
  };

  return res;
}

export const commentHandlers = findRouteHandlers("/wiki/:slugid/comments");
export const commentHandler = commentHandlers.at(-1);

if (!commentHandler) {
  throw new Error("Impossible de localiser le gestionnaire de commentaire");
}

export function dispatchComment(req, handler = commentHandler) {
  return new Promise((resolve, reject) => {
    let recorder;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(recorder);
    };
    recorder = createResponseRecorder(finish);
    try {
      handler(req, recorder, (err) => {
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
    } catch (err) {
      settled = true;
      reject(err);
    }
  });
}

export function buildCommentRequest({
  slug,
  body,
  permissions = { can_comment: true },
}) {
  return {
    params: { slugid: slug },
    body,
    permissionFlags: permissions,
    session: {},
    clientIp: "127.0.0.1",
    clientUserAgent: "test-agent",
    get: () => "",
    accepts: () => true,
    protocol: "http",
    originalUrl: `/wiki/${slug}/comments`,
  };
}

export async function createTestPage(slug) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  return get(`SELECT id FROM pages WHERE slug_id=?`, [slug]);
}

export async function cleanupTestPage(slug) {
  const page = await get(`SELECT id FROM pages WHERE slug_id=?`, [slug]);
  if (page) {
    await run(`DELETE FROM comment_attachments WHERE comment_snowflake_id IN (SELECT snowflake_id FROM comments WHERE page_id=?)`, [page.id]);
    await run(`DELETE FROM comments WHERE page_id=?`, [page.id]);
  }
  await run(`DELETE FROM pages WHERE slug_id=?`, [slug]);
}
