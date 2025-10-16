import test from "node:test";
import assert from "node:assert/strict";
import pagesRouter from "../routes/pages.js";
import { initDb, run, get } from "../db.js";
import { fetchPageComments } from "../utils/pageService.js";
import { generateSnowflake } from "../utils/snowflake.js";

async function createPage(slug) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  return get(`SELECT id FROM pages WHERE slug_id=?`, [slug]);
}

async function deletePage(slug) {
  await run("DELETE FROM pages WHERE slug_id=?", [slug]);
}

async function insertComment({
  pageId,
  snowflake = generateSnowflake(),
  parentSnowflakeId = null,
  author = "Anonyme",
  body = "Commentaire",
  status = "approved",
  editToken = generateSnowflake(),
}) {
  await run(
    `INSERT INTO comments(snowflake_id, page_id, author, body, parent_snowflake_id, status, edit_token, author_is_admin)
     VALUES(?,?,?,?,?,?,?,0)`,
    [snowflake, pageId, author, body, parentSnowflakeId, status, editToken],
  );
  return { snowflake, editToken, parentSnowflakeId };
}

function findRouteHandlers(path, method = "post") {
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

function snapshotTree(nodes) {
  return nodes.map((node) => ({
    id: node.snowflake_id,
    author: node.author,
    depth: node.depth,
    parent: node.parentId || null,
    children: snapshotTree(node.children || []),
  }));
}

test("fetchPageComments renvoie une hiérarchie paginée complète", async (t) => {
  await initDb();
  const slug = `hierarchy-${Date.now()}`;
  const page = await createPage(slug);

  t.after(async () => {
    await deletePage(slug);
  });

  const rootOne = await insertComment({
    pageId: page.id,
    author: "Racine 1",
    body: "Premier", 
  });
  const childOne = await insertComment({
    pageId: page.id,
    parentSnowflakeId: rootOne.snowflake,
    author: "Réponse 1",
    body: "Réponse", 
  });
  const grandchild = await insertComment({
    pageId: page.id,
    parentSnowflakeId: childOne.snowflake,
    author: "Sous-réponse",
    body: "Sous",
  });
  const rootTwo = await insertComment({
    pageId: page.id,
    author: "Racine 2",
    body: "Second",
  });

  const fullTree = await fetchPageComments(page.id, {});
  assert.strictEqual(fullTree.length, 2);
  assert.deepStrictEqual(snapshotTree(fullTree), [
    {
      id: rootOne.snowflake,
      author: "Racine 1",
      depth: 0,
      parent: null,
      children: [
        {
          id: childOne.snowflake,
          author: "Réponse 1",
          depth: 1,
          parent: rootOne.snowflake,
          children: [
            {
              author: "Sous-réponse",
              depth: 2,
              id: grandchild.snowflake,
              parent: childOne.snowflake,
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: rootTwo.snowflake,
      author: "Racine 2",
      depth: 0,
      parent: null,
      children: [],
    },
  ]);

  const paginated = await fetchPageComments(page.id, { limit: 1, offset: 1 });
  assert.strictEqual(paginated.length, 1);
  assert.deepStrictEqual(snapshotTree(paginated), [
    {
      id: rootTwo.snowflake,
      author: "Racine 2",
      depth: 0,
      parent: null,
      children: [],
    },
  ]);
});

test("la modification refuse de créer un cycle parent/enfant", async (t) => {
  await initDb();
  const slug = `hierarchy-edit-${Date.now()}`;
  const page = await createPage(slug);

  t.after(async () => {
    await deletePage(slug);
  });

  const root = await insertComment({ pageId: page.id, author: "Parent" });
  const child = await insertComment({
    pageId: page.id,
    parentSnowflakeId: root.snowflake,
    author: "Enfant",
  });
  const grandchild = await insertComment({
    pageId: page.id,
    parentSnowflakeId: child.snowflake,
    author: "Petit-enfant",
  });

  const handlers = findRouteHandlers("/wiki/:slugid/comments/:commentId/edit");
  const editHandler = handlers.at(-1);
  if (!editHandler) {
    throw new Error("Impossible de localiser le gestionnaire d'édition");
  }

  const req = {
    params: { slugid: slug, commentId: child.snowflake },
    body: {
      author: "Enfant",
      body: "Mise à jour",
      parentId: grandchild.snowflake,
    },
    session: {
      commentTokens: { [child.snowflake]: child.editToken },
    },
    permissionFlags: {},
  };

  const res = {
    statusCode: 200,
    view: null,
    data: null,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    render(view, data) {
      this.view = view;
      this.data = data;
      return this;
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };

  await editHandler(req, res, (err) => {
    if (err) {
      throw err;
    }
  });

  assert.strictEqual(res.redirectUrl, undefined);
  assert.strictEqual(res.view, "comment_edit");
  assert.ok(Array.isArray(res.data?.notifications));
  assert.match(
    res.data.notifications.map((n) => n.message).join("\n"),
    /Impossible de déplacer ce commentaire sous l'un de ses propres descendants/,
  );

  const childRow = await get(
    `SELECT parent_snowflake_id FROM comments WHERE snowflake_id = ?`,
    [child.snowflake],
  );
  assert.strictEqual(childRow.parent_snowflake_id, child.parentSnowflakeId);
});
