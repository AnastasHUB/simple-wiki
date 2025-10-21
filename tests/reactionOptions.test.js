import test from "node:test";
import assert from "node:assert/strict";

import { initDb, run } from "../db.js";
import { listReactionOptions, createReactionOption } from "../utils/reactionOptions.js";
import { DEFAULT_REACTIONS } from "../utils/reactionHelpers.js";

test("listReactionOptions returns empty array when no records exist", async (t) => {
  await initDb();
  await run("DELETE FROM reaction_options");

  t.after(async () => {
    await run("DELETE FROM reaction_options");
    for (const reaction of DEFAULT_REACTIONS) {
      await createReactionOption({
        id: reaction.id,
        label: reaction.label,
        emoji: reaction.emoji || "",
        imageUrl: reaction.imageUrl || null,
      });
    }
  });

  const reactions = await listReactionOptions();
  assert.ok(Array.isArray(reactions));
  assert.equal(reactions.length, 0);
});
