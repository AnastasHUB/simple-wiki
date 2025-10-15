import sanitizeHtml from "sanitize-html";
import { renderMarkdown } from "./markdownRenderer.js";

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
    "math",
    "semantics",
    "annotation",
    "mrow",
    "mi",
    "mn",
    "mo",
    "msup",
    "msub",
    "mfrac",
    "msqrt",
    "mtext",
    "mspace",
    "mtable",
    "mtr",
    "mtd",
    "mstyle",
    "munderover",
    "munder",
    "mover",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "title", "target", "rel", "class"],
    code: ["class"],
    pre: ["class", "spellcheck"],
    span: ["class", "aria-hidden"],
    div: ["class"],
    math: ["xmlns"],
    annotation: ["encoding"],
    mstyle: ["displaystyle"],
    mspace: ["width"],
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
  const rendered = renderMarkdown(String(content));
  return sanitizeHtml(rendered, PREVIEW_SANITIZE_OPTIONS).trim();
}
