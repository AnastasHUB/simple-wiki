import sanitizeHtml from "sanitize-html";
import { linkifyInternal } from "./linkify.js";

const PREVIEW_SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "span",
    "div",
    "blockquote",
    "mark",
    "hr",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "title", "target", "rel"],
    code: ["class"],
    pre: ["class", "spellcheck"],
    span: ["class"],
    div: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform(
      "a",
      { target: "_blank", rel: "noreferrer noopener" },
      true,
    ),
  },
};

export function buildPreviewHtml(content) {
  if (!content) return "";
  const linked = linkifyInternal(String(content));
  return sanitizeHtml(linked, PREVIEW_SANITIZE_OPTIONS).trim();
}
