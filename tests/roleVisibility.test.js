import test from "node:test";
import assert from "node:assert/strict";
import { initDb, run, get } from "../db.js";
import {
  fetchPageWithStats,
  fetchPaginatedPages,
  countPagesByTag,
  fetchPagesByTag,
  setPageVisibilityRoles,
  setTagVisibilityRoles,
} from "../utils/pageService.js";
import { generateSnowflake } from "../utils/snowflake.js";
import { EVERYONE_ROLE_SNOWFLAKE } from "../utils/defaultRoles.js";

await initDb();

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

test("page and tag visibility honor role restrictions", async () => {
  const roleSnowflake = generateSnowflake();
  const roleName = uniqueName("Role");
  await run(
    "INSERT INTO roles(snowflake_id, name, is_system) VALUES(?,?,0)",
    [roleSnowflake, roleName],
  );

  const slugId = uniqueName("restricted-page");
  const pageSnowflake = generateSnowflake();
  const insertResult = await run(
    "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status) VALUES(?,?,?,?,?,?,?)",
    [
      pageSnowflake,
      slugId,
      slugId,
      "Contenu restreint",
      "Secrets de test",
      "Testeur",
      "published",
    ],
  );
  const pageId = insertResult.lastID;
  assert.ok(pageId, "la page devrait être créée");
  await setPageVisibilityRoles(pageId, [roleSnowflake]);

  const tagName = uniqueName("tag");
  const tagSnowflake = generateSnowflake();
  await run("INSERT INTO tags(name, snowflake_id) VALUES(?,?)", [tagName, tagSnowflake]);
  const tagRow = await get("SELECT id FROM tags WHERE name=?", [tagName]);
  assert.ok(tagRow?.id, "le tag devrait exister");
  await run(
    "INSERT INTO page_tags(page_id, tag_id, snowflake_id) VALUES(?,?,?)",
    [pageId, tagRow.id, generateSnowflake()],
  );
  await setTagVisibilityRoles(tagRow.id, [roleSnowflake]);

  const publicPage = await fetchPageWithStats(slugId, null, {
    allowedRoleSnowflakes: [EVERYONE_ROLE_SNOWFLAKE],
  });
  assert.equal(publicPage, null, "la page ne devrait pas être visible publiquement");

  const adminBypassPage = await fetchPageWithStats(slugId, null, {
    allowedRoleSnowflakes: null,
  });
  assert.ok(
    adminBypassPage,
    "la page devrait rester visible lorsque la restriction est ignorée",
  );

  const allowedPage = await fetchPageWithStats(slugId, null, {
    allowedRoleSnowflakes: [roleSnowflake],
  });
  assert.ok(allowedPage, "la page devrait être visible pour le rôle autorisé");

  const publicListing = await fetchPaginatedPages({
    ip: null,
    limit: 5,
    offset: 0,
    allowedRoleSnowflakes: [EVERYONE_ROLE_SNOWFLAKE],
  });
  assert.ok(
    publicListing.every((row) => row.slug_id !== slugId),
    "la page restreinte ne doit pas apparaître dans la liste publique",
  );

  const adminBypassListing = await fetchPaginatedPages({
    ip: null,
    limit: 5,
    offset: 0,
    allowedRoleSnowflakes: null,
  });
  assert.ok(
    adminBypassListing.some((row) => row.slug_id === slugId),
    "la page doit apparaître lorsque la visibilité n'est pas filtrée",
  );

  const allowedListing = await fetchPaginatedPages({
    ip: null,
    limit: 5,
    offset: 0,
    allowedRoleSnowflakes: [roleSnowflake],
  });
  assert.ok(
    allowedListing.some((row) => row.slug_id === slugId),
    "la page doit apparaître pour les rôles autorisés",
  );

  const publicTagCount = await countPagesByTag(tagName, {
    allowedRoleSnowflakes: [EVERYONE_ROLE_SNOWFLAKE],
  });
  assert.equal(publicTagCount, 0, "les pages restreintes ne doivent pas compter publiquement");

  const adminBypassTagCount = await countPagesByTag(tagName, {
    allowedRoleSnowflakes: null,
  });
  assert.equal(
    adminBypassTagCount,
    1,
    "le comptage doit inclure les pages lorsqu'il n'y a pas de filtrage",
  );

  const allowedTagPages = await fetchPagesByTag({
    tagName,
    ip: null,
    limit: 5,
    offset: 0,
    allowedRoleSnowflakes: [roleSnowflake],
  });
  assert.ok(
    allowedTagPages.some((row) => row.slug_id === slugId),
    "le tag doit retourner la page pour les rôles autorisés",
  );

  const adminBypassTagPages = await fetchPagesByTag({
    tagName,
    ip: null,
    limit: 5,
    offset: 0,
    allowedRoleSnowflakes: null,
  });
  assert.ok(
    adminBypassTagPages.some((row) => row.slug_id === slugId),
    "le tag doit retourner la page lorsqu'aucune restriction n'est appliquée",
  );

  await run("DELETE FROM page_tags WHERE page_id=?", [pageId]);
  await run("DELETE FROM tags WHERE id=?", [tagRow.id]);
  await run("DELETE FROM page_role_visibility WHERE page_id=?", [pageId]);
  await run("DELETE FROM tag_role_visibility WHERE tag_id=?", [tagRow.id]);
  await run("DELETE FROM pages WHERE id=?", [pageId]);
  await run("DELETE FROM roles WHERE snowflake_id=?", [roleSnowflake]);
});
