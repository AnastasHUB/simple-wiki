import test from "node:test";
import assert from "node:assert/strict";
import { initDb, run } from "../db.js";
import { fetchPageWithStats, countPages } from "../utils/pageService.js";
import { publishScheduledPages } from "../utils/pageScheduler.js";
import { generateSnowflake } from "../utils/snowflake.js";

await initDb();

function uniqueSlug() {
  return `scheduled-test-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

test("scheduled pages become visible after publication job", async () => {
  const slugId = uniqueSlug();
  const snowflake = generateSnowflake();
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const publishAt = future.toISOString();
  await run("DELETE FROM pages WHERE slug_id = ?", [slugId]);
  const initialCount = await countPages();

  await run(
    "INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status, publish_at) VALUES(?,?,?,?,?,?,?,?)",
    [
      snowflake,
      slugId,
      slugId,
      "Page programmée",
      "Contenu planifié",
      "Planificateur",
      "scheduled",
      publishAt,
    ],
  );

  const before = await fetchPageWithStats(slugId, null);
  assert.equal(before, null);

  const publishedCount = await publishScheduledPages({
    now: new Date(future.getTime() + 2000),
  });
  assert.equal(publishedCount, 1);

  const after = await fetchPageWithStats(slugId, null);
  assert.ok(after);
  assert.equal(after.status, "published");
  const finalCount = await countPages();
  assert.equal(finalCount, initialCount + 1);

  await run("DELETE FROM pages WHERE slug_id = ?", [slugId]);
  await run("DELETE FROM pages_fts WHERE rowid NOT IN (SELECT id FROM pages)");
});
