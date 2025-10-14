import { createTwoFilesPatch } from "diff";
import diff2html from "diff2html";
import sanitizeHtml from "sanitize-html";

const DEFAULT_RENDER_OPTIONS = {
  inputFormat: "diff",
  showFiles: false,
  matching: "lines",
  outputFormat: "side-by-side",
};

const DIFF_SANITIZE_OPTIONS = {
  allowedTags: [
    "a",
    "b",
    "body",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "hr",
    "html",
    "i",
    "ins",
    "del",
    "kbd",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "section",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target"],
    div: ["class", "data-lang"],
    span: ["class"],
    table: ["class"],
    td: ["class"],
    th: ["class"],
    tr: ["class"],
    ol: ["class"],
    ul: ["class"],
    code: ["class"],
    pre: ["class"],
    ins: ["class"],
    del: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
};

export function renderMarkdownDiff({
  oldContent = "",
  newContent = "",
  oldLabel = "Ancienne révision",
  newLabel = "Nouvelle révision",
  diffOptions = {},
} = {}) {
  const safeOld = typeof oldContent === "string" ? oldContent : "";
  const safeNew = typeof newContent === "string" ? newContent : "";
  const fromLabel = typeof oldLabel === "string" ? oldLabel : "Ancienne";
  const toLabel = typeof newLabel === "string" ? newLabel : "Nouvelle";

  const patch = createTwoFilesPatch(fromLabel, toLabel, safeOld, safeNew, "", "", {
    context: 3,
  });
  const diffHtml = diff2html.html(patch, {
    ...DEFAULT_RENDER_OPTIONS,
    ...diffOptions,
  });
  return sanitizeHtml(diffHtml, DIFF_SANITIZE_OPTIONS);
}

export function hasMeaningfulDiff(a = "", b = "") {
  if (typeof a !== "string" || typeof b !== "string") {
    return true;
  }
  return a !== b;
}
