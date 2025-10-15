import sanitizeHtml from "sanitize-html";
import { CONTENT_SANITIZE_OPTIONS } from "./articleFormatter.js";
import { renderMarkdown } from "./markdownRenderer.js";

const basePreAttributes =
  CONTENT_SANITIZE_OPTIONS.allowedAttributes?.pre ?? [];

const PREVIEW_SANITIZE_OPTIONS = {
  ...CONTENT_SANITIZE_OPTIONS,
  allowedAttributes: {
    ...CONTENT_SANITIZE_OPTIONS.allowedAttributes,
    pre: Array.from(new Set([...basePreAttributes, "spellcheck"])),
  },
};

export function buildPreviewHtml(content) {
  if (!content) return "";
  const rendered = renderMarkdown(String(content));
  return sanitizeHtml(rendered, PREVIEW_SANITIZE_OPTIONS).trim();
}
