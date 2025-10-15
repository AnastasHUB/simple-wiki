import test from "node:test";
import assert from "node:assert/strict";

import { initDb, run, get } from "../db.js";
import { generateSnowflake } from "../utils/snowflake.js";
import {
  listAvailableReactions,
  combineReactionState,
  togglePageReaction,
  getPageReactionState,
  toggleCommentReaction,
  getCommentReactionState,
} from "../utils/reactionService.js";
import {
  createReactionOption,
  updateReactionOption,
  deleteReactionOption,
} from "../utils/reactionOptions.js";

async function createPage(slug) {
  const snowflake = generateSnowflake();
  await run(
    `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author)
     VALUES(?,?,?,?,?,?)`,
    [snowflake, slug, slug, `Titre ${slug}`, "Contenu", "Auteur"],
  );
  return get("SELECT id FROM pages WHERE slug_id=?", [slug]);
}

async function insertComment(pageId, snowflake = generateSnowflake()) {
  await run(
    `INSERT INTO comments(snowflake_id, page_id, author, body, status, edit_token, author_is_admin)
     VALUES(?,?,?,?,?,?,0)`,
    [snowflake, pageId, "Testeur", "Commentaire", "approved", generateSnowflake()],
  );
  return snowflake;
}

async function cleanupPage(slug) {
  await run("DELETE FROM pages WHERE slug_id=?", [slug]);
}

async function cleanupComment(snowflake) {
  await run("DELETE FROM comments WHERE snowflake_id=?", [snowflake]);
}

test("page reactions toggle per IP", async (t) => {
  await initDb();
  const slug = `page-reaction-${Date.now()}`;
  const page = await createPage(slug);

  t.after(async () => {
    await cleanupPage(slug);
  });

  const ip = "127.0.0.9";
  await togglePageReaction({ pageId: page.id, reactionKey: "heart", ip });

  const options = await listAvailableReactions();
  let state = await getPageReactionState(page.id, ip);
  let display = combineReactionState(options, state);
  const heart = display.find((reaction) => reaction.id === "heart");
  assert.ok(heart);
  assert.equal(heart.count, 1);
  assert.equal(heart.reacted, true);

  await togglePageReaction({ pageId: page.id, reactionKey: "heart", ip });
  state = await getPageReactionState(page.id, ip);
  display = combineReactionState(options, state);
  const heartAfter = display.find((reaction) => reaction.id === "heart");
  assert.ok(heartAfter);
  assert.equal(heartAfter.count, 0);
  assert.equal(heartAfter.reacted, false);
});

test("comment reactions aggregate counts across multiple IPs", async (t) => {
  await initDb();
  const slug = `comment-reaction-${Date.now()}`;
  const page = await createPage(slug);
  const commentSnowflake = await insertComment(page.id);

  t.after(async () => {
    await cleanupComment(commentSnowflake);
    await cleanupPage(slug);
  });

  const ipOne = "10.0.0.1";
  const ipTwo = "10.0.0.2";

  await toggleCommentReaction({
    commentSnowflakeId: commentSnowflake,
    reactionKey: "idea",
    ip: ipOne,
  });
  await toggleCommentReaction({
    commentSnowflakeId: commentSnowflake,
    reactionKey: "idea",
    ip: ipTwo,
  });

  const options = await listAvailableReactions();
  let state = await getCommentReactionState(commentSnowflake, ipOne);
  let display = combineReactionState(options, state);
  const idea = display.find((reaction) => reaction.id === "idea");
  assert.ok(idea);
  assert.equal(idea.count, 2);
  assert.equal(idea.reacted, true);

  await toggleCommentReaction({
    commentSnowflakeId: commentSnowflake,
    reactionKey: "idea",
    ip: ipOne,
  });

  state = await getCommentReactionState(commentSnowflake, ipOne);
  display = combineReactionState(options, state);
  const ideaAfter = display.find((reaction) => reaction.id === "idea");
  assert.ok(ideaAfter);
  assert.equal(ideaAfter.count, 1);
  assert.equal(ideaAfter.reacted, false);
});

test("custom reactions can be created, updated, and removed", async (t) => {
  await initDb();
  const slug = `custom-reaction-${Date.now()}`;
  const page = await createPage(slug);
  const customKey = `essai-${Date.now()}`;

  t.after(async () => {
    await deleteReactionOption(customKey);
    await cleanupPage(slug);
  });

  await createReactionOption({ id: customKey, label: "Expérience", emoji: "🧪" });
  let reactions = await listAvailableReactions();
  let custom = reactions.find((reaction) => reaction.id === customKey);
  assert.ok(custom);
  assert.equal(custom.emoji, "🧪");

  await updateReactionOption(customKey, {
    label: "Expérience visuelle",
    emoji: "",
    imageUrl: "https://example.com/reactions/experiment.png",
  });

  reactions = await listAvailableReactions();
  custom = reactions.find((reaction) => reaction.id === customKey);
  assert.ok(custom);
  assert.equal(custom.label, "Expérience visuelle");
  assert.equal(custom.emoji, "");
  assert.equal(custom.imageUrl, "https://example.com/reactions/experiment.png");

  const ip = "203.0.113.42";
  await togglePageReaction({ pageId: page.id, reactionKey: customKey, ip });
  let state = await getPageReactionState(page.id, ip);
  let display = combineReactionState(await listAvailableReactions(), state);
  custom = display.find((reaction) => reaction.id === customKey);
  assert.ok(custom);
  assert.equal(custom.count, 1);
  assert.equal(custom.reacted, true);

  await deleteReactionOption(customKey);
  reactions = await listAvailableReactions();
  assert.ok(!reactions.some((reaction) => reaction.id === customKey));

  state = await getPageReactionState(page.id, ip);
  display = combineReactionState(reactions, state);
  assert.ok(!display.some((reaction) => reaction.id === customKey));
});
