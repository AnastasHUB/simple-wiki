import { get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

export function normalizeTagInput(input = "") {
  if (Array.isArray(input)) {
    return Array.from(
      new Set(
        input
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
          .map((value) => value.toLowerCase()),
      ),
    );
  }

  if (typeof input !== "string") {
    return [];
  }

  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => value.toLowerCase()),
    ),
  );
}

export async function upsertTags(pageId, input = "") {
  const names = normalizeTagInput(input);
  if (!pageId) {
    return names;
  }

  for (const name of names) {
    await run("INSERT OR IGNORE INTO tags(name, snowflake_id) VALUES(?,?)", [
      name,
      generateSnowflake(),
    ]);
    const tag = await get("SELECT id FROM tags WHERE name=?", [name]);
    if (!tag?.id) {
      continue;
    }
    await run(
      "INSERT OR IGNORE INTO page_tags(snowflake_id, page_id, tag_id) VALUES(?,?,?)",
      [generateSnowflake(), pageId, tag.id],
    );
  }

  return names;
}

export async function recordRevision(pageId, title, content, authorId = null) {
  if (!pageId) {
    return null;
  }

  const row = await get(
    "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM page_revisions WHERE page_id=?",
    [pageId],
  );
  const next = row?.next || 1;
  const snowflake = generateSnowflake();
  await run(
    "INSERT INTO page_revisions(snowflake_id, page_id, revision, title, content, author_id) VALUES(?,?,?,?,?,?)",
    [snowflake, pageId, next, title, content, authorId],
  );
  return next;
}
