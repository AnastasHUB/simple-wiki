import test from "node:test";
import assert from "node:assert/strict";

import { initDb, run, get, all } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  ensureAchievementBadges,
  evaluateUserAchievements,
  getAchievementDefinitions,
  createAchievementBadge,
  updateAchievementBadge,
  deleteAchievementBadge,
} from "../utils/achievementService.js";

async function createTestUser(username) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO users(snowflake_id, username, password)
     VALUES(?,?,?)`,
    [snowflake, username, "password"],
  );
  return get("SELECT id FROM users WHERE username=?", [username]);
}

async function listUserAchievementKeys(userId) {
  const rows = await all(
    `SELECT b.automatic_key
       FROM user_badges ub
       JOIN badges b ON b.id = ub.badge_id
      WHERE ub.user_id = ? AND b.automatic_key IS NOT NULL`,
    [userId],
  );
  return rows
    .map((row) => (typeof row.automatic_key === "string" ? row.automatic_key.trim() : ""))
    .filter(Boolean);
}

test("membership achievements are awarded according to account age", async () => {
  await initDb();
  await ensureAchievementBadges();

  const username = `member_${Date.now()}`;
  const user = await createTestUser(username);
  try {
    await run(
      `UPDATE users SET created_at = datetime('now', '-10 days') WHERE id = ?`,
      [user.id],
    );

    await evaluateUserAchievements(user.id);

    const heldAfterTenDays = await listUserAchievementKeys(user.id);
    assert.ok(heldAfterTenDays.includes("membership_days_7"));
    assert.ok(!heldAfterTenDays.includes("membership_days_365"));

    await run(
      `UPDATE users SET created_at = datetime('now', '-400 days') WHERE id = ?`,
      [user.id],
    );

    await evaluateUserAchievements(user.id);

    const heldAfterYear = await listUserAchievementKeys(user.id);
    assert.ok(heldAfterYear.includes("membership_days_7"));
    assert.ok(heldAfterYear.includes("membership_days_365"));
  } finally {
    await run("DELETE FROM user_badges WHERE user_id=?", [user.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  }
});

test("page achievements unlock when enough articles are created", async () => {
  await initDb();
  await ensureAchievementBadges();

  const username = `author_${Date.now()}`;
  const user = await createTestUser(username);
  const createdPageSlugs = [];

  const createPageForUser = async (index) => {
    const slugId = `test-${Date.now()}-${index}`;
    const snowflake = generateSnowflake();
    createdPageSlugs.push(slugId);
    await run(
      `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status)
       VALUES(?,?,?,?,?,?,?)`,
      [snowflake, slugId, slugId, `Titre ${index}`, "Contenu", username, "published"],
    );
    const page = await get("SELECT id FROM pages WHERE slug_id=?", [slugId]);
    await run(
      `INSERT INTO page_revisions(snowflake_id, page_id, revision, title, content, author_id)
       VALUES(?,?,?,?,?,?)`,
      [generateSnowflake(), page.id, 1, `Titre ${index}`, "Contenu", user.id],
    );
  };

  try {
    await createPageForUser(1);
    await evaluateUserAchievements(user.id);
    let held = await listUserAchievementKeys(user.id);
    assert.ok(held.includes("page_count_1"));
    assert.ok(!held.includes("page_count_5"));

    for (let index = 2; index <= 5; index += 1) {
      await createPageForUser(index);
    }

    await evaluateUserAchievements(user.id);
    held = await listUserAchievementKeys(user.id);
    assert.ok(held.includes("page_count_1"));
    assert.ok(held.includes("page_count_5"));
  } finally {
    if (createdPageSlugs.length) {
      const placeholders = createdPageSlugs.map(() => "?").join(", ");
      await run(`DELETE FROM pages WHERE slug_id IN (${placeholders})`, createdPageSlugs);
    }
    await run("DELETE FROM user_badges WHERE user_id=?", [user.id]);
    await run("DELETE FROM page_revisions WHERE author_id=?", [user.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  }
});

test("achievement definitions expose immutable metadata", async () => {
  const definitions = getAchievementDefinitions();
  assert.ok(Array.isArray(definitions));
  assert.ok(definitions.length >= 100);
  definitions.push({ key: "invalid" });
  const secondCall = getAchievementDefinitions();
  assert.notEqual(definitions.length, secondCall.length);
});

test("custom success badges can be created, updated, and reassigned", async (t) => {
  await initDb();
  await ensureAchievementBadges();

  const badge = await createAchievementBadge({
    criterionKey: "page_count_2",
    name: "Auteur assidu",
    description: "A publié deux articles.",
    emoji: "📗",
  });

  t.after(async () => {
    await deleteAchievementBadge(badge.snowflakeId);
  });

  const username = `success_${Date.now()}`;
  const user = await createTestUser(username);
  const createdPageSlugs = [];

  const createPageForUser = async (index) => {
    const slugId = `success-test-${Date.now()}-${index}`;
    const snowflake = generateSnowflake();
    createdPageSlugs.push(slugId);
    await run(
      `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, status)
       VALUES(?,?,?,?,?,?,?)`,
      [snowflake, slugId, slugId, `Titre ${index}`, "Contenu", username, "published"],
    );
    const page = await get("SELECT id FROM pages WHERE slug_id=?", [slugId]);
    await run(
      `INSERT INTO page_revisions(snowflake_id, page_id, revision, title, content, author_id)
       VALUES(?,?,?,?,?,?)`,
      [generateSnowflake(), page.id, 1, `Titre ${index}`, "Contenu", user.id],
    );
  };

  t.after(async () => {
    if (createdPageSlugs.length) {
      const placeholders = createdPageSlugs.map(() => "?").join(", ");
      await run(`DELETE FROM pages WHERE slug_id IN (${placeholders})`, createdPageSlugs);
    }
    await run("DELETE FROM page_revisions WHERE author_id=?", [user.id]);
    await run("DELETE FROM user_badges WHERE user_id=?", [user.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  });

  await createPageForUser(1);
  await createPageForUser(2);

  await evaluateUserAchievements(user.id);
  let heldKeys = await listUserAchievementKeys(user.id);
  assert.ok(heldKeys.includes("page_count_2"));

  const updatedBadge = await updateAchievementBadge(badge.snowflakeId, {
    criterionKey: "page_count_3",
    name: "Auteur confirmé",
    emoji: "📘",
  });
  assert.equal(updatedBadge.automaticKey, "page_count_3");

  heldKeys = await listUserAchievementKeys(user.id);
  assert.ok(!heldKeys.includes("page_count_2"));
  assert.ok(!heldKeys.includes("page_count_3"));

  await createPageForUser(3);
  await evaluateUserAchievements(user.id);
  heldKeys = await listUserAchievementKeys(user.id);
  assert.ok(heldKeys.includes("page_count_3"));
});
