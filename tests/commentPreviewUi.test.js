import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadClientScript(window, relativePath) {
  const scriptPath = path.join(__dirname, "..", relativePath);
  const source = await readFile(scriptPath, "utf8");
  window.eval(`${source}\n//# sourceURL=${scriptPath}`);
}

test("la prévisualisation de commentaire est mise à jour dynamiquement", async (t) => {
  const dom = new JSDOM(
    `<!DOCTYPE html>
     <html>
       <head></head>
       <body>
         <form data-comment-preview-form data-preview-endpoint="/wiki/demo/comments/preview">
           <div class="field" data-preview-root>
             <label for="comment-body">Votre message</label>
             <textarea id="comment-body" data-preview-source data-preview-target="#comment-preview"></textarea>
             <p data-preview-status aria-live="polite"></p>
           </div>
           <div class="field" data-preview-container hidden>
             <span class="comment-preview-label">Aperçu</span>
             <div class="comment-preview" id="comment-preview" data-preview-body></div>
           </div>
         </form>
       </body>
     </html>`,
    {
      url: "http://localhost/wiki/demo",
      pretendToBeVisual: true,
    },
  );

  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.AbortController = window.AbortController;
  t.after(() => {
    delete global.window;
    delete global.document;
    delete global.AbortController;
    delete global.fetch;
    delete global.applyCsrfHeader;
  });
  window.applyCsrfHeader = (headers = {}) => headers;
  global.applyCsrfHeader = window.applyCsrfHeader;

  const fetchCalls = [];
  window.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, html: "<p><strong>Bonjour</strong></p>" }),
    };
  };
  global.fetch = window.fetch;

  await loadClientScript(window, "public/comment-preview.js");

  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  if (window.SimpleWiki?.initCommentPreview) {
    window.SimpleWiki.initCommentPreview();
  }
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.ok(window.SimpleWiki);
  assert.strictEqual(typeof window.SimpleWiki.initCommentPreview, "function");

  const field = window.document.querySelector("[data-preview-source]");
  const previewContainer = window.document.querySelector("[data-preview-container]");
  const previewBody = window.document.querySelector("[data-preview-body]");
  const statusElement = window.document.querySelector("[data-preview-status]");

  field.value = "**Bonjour**";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));

  await new Promise((resolve) => window.setTimeout(resolve, 400));
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  assert.ok(fetchCalls.length >= 1);
  assert.strictEqual(fetchCalls[0].url, "/wiki/demo/comments/preview");
  assert.ok(!previewContainer.hidden);
  assert.strictEqual(previewBody.innerHTML, "<p><strong>Bonjour</strong></p>");
  assert.strictEqual(statusElement.dataset.state, "success");
});
