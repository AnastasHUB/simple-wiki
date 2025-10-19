import test from "node:test";
import assert from "node:assert/strict";

import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  createBadge,
  listBadgesWithAssignments,
  assignBadgeToUser,
  revokeBadgeFromUser,
  deleteBadge,
  listBadgesForUserId,
  getBadgeBySnowflake,
} from "../utils/badgeService.js";

async function createUser(username) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO users(snowflake_id, username, password)
     VALUES(?,?,?)`,
    [snowflake, username, "password"],
  );
  return get("SELECT id FROM users WHERE username=?", [username]);
}

test("badges can be created, attribued, and revoked", async (t) => {
  await initDb();
  const username = `user_badge_${Date.now()}`;
  const user = await createUser(username);

  t.after(async () => {
    await run("DELETE FROM user_badges WHERE user_id=?", [user.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  });

  const badge = await createBadge({
    name: `Badge ${Date.now()}`,
    description: "Badge de test",
    emoji: "🏅",
  });

  assert.ok(badge);
  assert.ok(badge.snowflakeId);

  t.after(async () => {
    await deleteBadge(badge.snowflakeId);
  });

  const badgesBefore = await listBadgesWithAssignments();
  const created = badgesBefore.find((item) => item.snowflakeId === badge.snowflakeId);
  assert.ok(created);
  assert.equal(created.assignmentCount, 0);

  const assignment = await assignBadgeToUser({
    badgeSnowflakeId: badge.snowflakeId,
    username,
    assignedByUserId: null,
  });

  assert.ok(assignment);
  assert.equal(assignment.user.username, username);

  const userBadges = await listBadgesForUserId(user.id);
  assert.equal(userBadges.length, 1);
  assert.equal(userBadges[0].name, badge.name);

  const badgesAfter = await listBadgesWithAssignments();
  const updated = badgesAfter.find((item) => item.snowflakeId === badge.snowflakeId);
  assert.ok(updated);
  assert.equal(updated.assignmentCount, 1);
  assert.equal(updated.assignees.length, 1);

  const revoked = await revokeBadgeFromUser({
    badgeSnowflakeId: badge.snowflakeId,
    username,
  });
  assert.equal(revoked, true);

  const badgeAfterRevoke = await getBadgeBySnowflake(badge.snowflakeId);
  assert.ok(badgeAfterRevoke);

  const userBadgesAfter = await listBadgesForUserId(user.id);
  assert.equal(userBadgesAfter.length, 0);
});

test("a user can hold multiple badges", async (t) => {
  await initDb();
  const username = `user_multiple_badges_${Date.now()}`;
  const user = await createUser(username);

  t.after(async () => {
    await run("DELETE FROM user_badges WHERE user_id=?", [user.id]);
    await run("DELETE FROM users WHERE id=?", [user.id]);
  });

  const badgeNames = [
    `Badge multiple ${Date.now()}`,
    `Badge secondaire ${Date.now() + 1}`,
  ];

  const badges = await Promise.all(
    badgeNames.map((name) =>
      createBadge({
        name,
        description: "Badge de test",
        emoji: "🏅",
      }),
    ),
  );

  t.after(async () => {
    for (const badge of badges) {
      await deleteBadge(badge.snowflakeId);
    }
  });

  for (const badge of badges) {
    const assignment = await assignBadgeToUser({
      badgeSnowflakeId: badge.snowflakeId,
      username,
      assignedByUserId: null,
    });

    assert.equal(assignment.user.username, username);
  }

  const userBadges = await listBadgesForUserId(user.id);
  assert.equal(userBadges.length, badges.length);

  const retrievedNames = userBadges.map((badge) => badge.name).sort();
  const expectedNames = badges.map((badge) => badge.name).sort();
  assert.deepEqual(retrievedNames, expectedNames);
});

test("badge image URLs must be absolute", async () => {
  await initDb();

  await assert.rejects(
    () =>
      createBadge({
        name: `Badge relatif ${Date.now()}`,
        description: "Badge avec image relative",
        emoji: "",
        imageUrl: "/images/test.png",
      }),
    /http:\/\/ ou https:\/\//,
  );
});
