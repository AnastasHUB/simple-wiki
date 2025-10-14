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

const CONTENT_SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "div",
    "details",
    "summary",
    "span",
    "blockquote",
    "mark",
    "hr",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "title", "target", "rel"],
    code: ["class"],
    pre: ["class"],
    div: ["class"],
    details: ["class", "open"],
    summary: ["class"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
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

function trimForEmbed(text) {
  if (!text) return "";
  if (text.length <= MAX_EMBED_DESCRIPTION_LENGTH) return text;
  return `${text.slice(0, MAX_EMBED_DESCRIPTION_LENGTH - 1)}…`;
}

export function buildArticleMarkdownDescription({
  title,
  content,
  author,
  tags,
  url,
}) {
  const normalizedContent = content ? linkifyInternal(String(content)) : "";
  const sanitizedContent = sanitizeContent(normalizedContent);
  const markdownBody = sanitizedContent
    ? turndown.turndown(sanitizedContent)
    : "";
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
  return trimForEmbed(description);
}
