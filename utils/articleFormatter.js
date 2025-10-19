import TurndownService from "turndown";
import sanitizeHtml from "sanitize-html";
import { linkifyInternal } from "./linkify.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-",
});

turndown.remove(["script", "style", "iframe"]);

turndown.addRule("strikethrough", {
  filter: ["s", "del"],
  replacement: (content) => `~~${content}~~`,
});

turndown.addRule("fencedCodeBlockWithLanguage", {
  filter: (node) =>
    node.nodeName === "PRE" &&
    node.firstChild &&
    node.firstChild.nodeName === "CODE",
  replacement: (_content, node) => {
    const codeNode = node.firstChild;
    const rawClassName = codeNode.getAttribute("class") || "";
    const languageMatch = rawClassName.match(/(?:language|lang)-([\w+#-]+)/i);
    let language = languageMatch ? languageMatch[1].toLowerCase() : "";
    language = language.replace(/[^a-z0-9+#-]/g, "");
    if (language === "javascript") language = "js";
    if (language === "typescript") language = "ts";
    if (language === "c++") language = "cpp";
    if (language === "c#") language = "csharp";

    const codeText = codeNode.textContent || "";
    const trimmed = codeText.replace(/^\n+/u, "").replace(/\s+$/u, "");
    const openingFence = language ? "```" + language : "```";
    const closingFence = "```";
    return `\n\n${openingFence}\n${trimmed}\n${closingFence}\n\n`;
  },
});

export const CONTENT_SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "img",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "div",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "details",
    "summary",
    "span",
    "blockquote",
    "mark",
    "hr",
    "input",
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
    pre: ["class"],
    img: [
      "src",
      "alt",
      "title",
      "width",
      "height",
      "loading",
      "decoding",
      "class",
      "srcset",
    ],
    div: ["class", "style"],
    details: ["class", "open"],
    summary: ["class"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    span: ["class", "aria-hidden", "style"],
    ul: ["class"],
    ol: ["class"],
    li: ["class"],
    input: ["type", "checked", "disabled", "class"],
    math: ["xmlns"],
    annotation: ["encoding"],
    mstyle: ["displaystyle"],
    mspace: ["width"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto"],
    img: ["http", "https", "data"],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform(
      "a",
      { target: "_blank", rel: "noreferrer noopener" },
      true,
    ),
  },
  allowedStyles: {
    "*": {
      position: [/^(?:static|relative|absolute)$/i],
      display: [/^(?:inline|inline-block|block|flex)$/i],
      top: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      right: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      bottom: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      left: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      height: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      width: [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "min-width": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "max-width": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "min-height": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "max-height": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      margin: [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)?(?:\s+-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)?){0,3}$/i,
      ],
      "margin-left": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "margin-right": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "margin-top": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "margin-bottom": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      padding: [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)?(?:\s+-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)?){0,3}$/i,
      ],
      "padding-left": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "padding-right": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "padding-top": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "padding-bottom": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "vertical-align": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "font-size": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      "line-height": [/^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)$/i],
      transform: [/^translate[XY]\(-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\)$/i],
      "border": [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\s+solid\s+#[0-9a-f]{3,6}$/i,
      ],
      "border-top": [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\s+solid\s+#[0-9a-f]{3,6}$/i,
      ],
      "border-right": [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\s+solid\s+#[0-9a-f]{3,6}$/i,
      ],
      "border-bottom": [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\s+solid\s+#[0-9a-f]{3,6}$/i,
      ],
      "border-left": [
        /^-?\d+(?:\.\d+)?(?:em|ex|ch|rem|px|%)\s+solid\s+#[0-9a-f]{3,6}$/i,
      ],
      "text-align": [/^(?:left|right|center)$/i],
      overflow: [/^(?:visible|hidden)$/i],
    },
  },
};

const MAX_EMBED_DESCRIPTION_LENGTH = 4096;

function sanitizeContent(content) {
  if (!content) return "";
  return sanitizeHtml(String(content), CONTENT_SANITIZE_OPTIONS).trim();
}

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => String(tag || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  return String(tags)
    .split(/[\n,]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function trimForEmbed(text, maxLength = MAX_EMBED_DESCRIPTION_LENGTH) {
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return text;
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function convertHtmlToDiscordMarkdown(content, options = {}) {
  if (!content) return "";

  const { alreadySanitized = false } = options;
  const normalized = alreadySanitized
    ? String(content)
    : linkifyInternal(String(content));
  const sanitized = sanitizeContent(normalized);
  if (!sanitized) return "";

  const markdown = turndown.turndown(sanitized).trim();
  return markdown;
}

export function buildArticleMarkdownDescription({
  title,
  content,
  author,
  tags,
  url,
}, options = {}) {
  const { maxLength = MAX_EMBED_DESCRIPTION_LENGTH } = options;
  const markdownBody = convertHtmlToDiscordMarkdown(content);
  const fallback = "L'article est prêt à être découvert !";

  const sections = [];
  if (title) sections.push(`**${title}**`);

  const metaParts = [];
  if (author) metaParts.push(`✍️ ${author}`);
  if (url) metaParts.push(url);

  const normalizedTags = normalizeTags(tags);
  if (metaParts.length || normalizedTags.length) {
    const metaLines = [];
    if (metaParts.length) metaLines.push(metaParts.join(" • "));
    if (normalizedTags.length)
      metaLines.push(normalizedTags.map((tag) => `#${tag}`).join("  "));
    sections.push(metaLines.join("\n"));
  }

  const body = markdownBody || fallback;
  sections.push(body);

  const description = sections.filter(Boolean).join("\n\n");
  return trimForEmbed(description, maxLength);
}
