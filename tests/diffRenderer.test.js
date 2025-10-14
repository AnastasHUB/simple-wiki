import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownDiff, hasMeaningfulDiff } from "../utils/diffRenderer.js";

test("renderMarkdownDiff produit un HTML diff utilisable et nettoyé", () => {
  const html = renderMarkdownDiff({
    oldContent: "Bonjour monde",
    newContent: "Bonjour merveilleux monde",
    oldLabel: "Ancienne",
    newLabel: "Nouvelle",
  });
  assert.ok(html.includes("d2h-file-wrapper"), "le diff devrait contenir la classe standard");
  assert.ok(!html.includes("<script>"), "le diff ne doit pas contenir de scripts");
});

test("hasMeaningfulDiff détecte correctement les différences", () => {
  assert.strictEqual(hasMeaningfulDiff("a", "a"), false);
  assert.strictEqual(hasMeaningfulDiff("a", "b"), true);
  assert.strictEqual(hasMeaningfulDiff("a", null), true);
});
