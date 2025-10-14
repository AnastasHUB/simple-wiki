import sanitizeHtml from "sanitize-html";
import { convertHtmlToDiscordMarkdown } from "./articleFormatter.js";

const DEFAULT_LANGUAGE = "fr-FR";
const FALLBACK_GENERATOR = "Simple Wiki";

const FEED_SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "pre",
    "code",
    "blockquote",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "img",
    "figure",
    "figcaption",
    "hr",
  ]),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ["href", "title", "target", "rel"],
    code: ["class"],
    pre: ["class"],
    img: ["src", "alt", "title"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform(
      "a",
      { target: "_blank", rel: "noreferrer noopener" },
      true,
    ),
  },
};

function escapeXml(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapCdata(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!text.length) {
    return "<![CDATA[]]>";
  }
  return `<![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function normalizeDate(value, fallback = new Date()) {
  if (!value) {
    return fallback;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date;
}

function formatRfc822(value) {
  return normalizeDate(value).toUTCString();
}

export function sanitizeFeedHtml(content) {
  if (!content) return "";
  const sanitized = sanitizeHtml(String(content), FEED_SANITIZE_OPTIONS);
  return sanitized.trim();
}

function balanceMarkdown(excerpt) {
  let balanced = excerpt;

  const fenceMatches = balanced.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    balanced = `${balanced.trimEnd()}\n\u0060\u0060\u0060`;
  }

  const inlineCode = balanced.replace(/```[\s\S]*?```/g, "");
  const inlineBacktickMatches = inlineCode.match(/`/g);
  if (inlineBacktickMatches && inlineBacktickMatches.length % 2 === 1) {
    balanced = `${balanced}\u0060`;
  }

  const boldMatches = balanced.replace(/\*\*[^*]+\*\*/g, "").match(/\*\*/g);
  if (boldMatches && boldMatches.length % 2 === 1) {
    balanced = `${balanced}**`;
  }

  return balanced;
}

export function buildFeedExcerpt(markdown, maxLength = 280) {
  const text = String(markdown || "").trim();
  if (!text.length) return "";
  if (text.length <= maxLength) return text;

  const sliced = text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
  return balanceMarkdown(sliced);
}

export function buildFeedMarkdown(content) {
  return convertHtmlToDiscordMarkdown(content);
}

function buildItemXml(item) {
  const parts = [];
  parts.push(`<title>${wrapCdata(item.title || "Article")}</title>`);
  if (item.link) {
    parts.push(`<link>${escapeXml(item.link)}</link>`);
  }
  if (item.guid) {
    const isPermaLink = item.guidIsPermaLink !== false;
    const guidAttr = isPermaLink ? "" : " isPermaLink=\"false\"";
    parts.push(`<guid${guidAttr}>${escapeXml(item.guid)}</guid>`);
  }
  if (item.pubDate) {
    parts.push(`<pubDate>${formatRfc822(item.pubDate)}</pubDate>`);
  }
  if (item.updated) {
    parts.push(`<atom:updated>${formatRfc822(item.updated)}</atom:updated>`);
  }
  if (item.author) {
    parts.push(`<author>${wrapCdata(item.author)}</author>`);
  }
  if (Array.isArray(item.categories)) {
    for (const category of item.categories) {
      if (!category) continue;
      parts.push(`<category>${wrapCdata(category)}</category>`);
    }
  }
  if (item.description) {
    parts.push(`<description>${wrapCdata(item.description)}</description>`);
  }
  if (item.content) {
    parts.push(`<content:encoded>${wrapCdata(item.content)}</content:encoded>`);
  }
  return `    <item>\n      ${parts.join("\n      ")}\n    </item>`;
}

export function buildRssFeed({
  siteTitle,
  siteLink,
  siteDescription,
  items = [],
  language = DEFAULT_LANGUAGE,
  generator = FALLBACK_GENERATOR,
  lastBuildDate,
  atomLink,
}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const fallbackDate =
    lastBuildDate || normalizedItems[0]?.updated || normalizedItems[0]?.pubDate;
  const channelParts = [
    `<title>${wrapCdata(siteTitle || "Flux RSS")}</title>`,
    siteLink ? `<link>${escapeXml(siteLink)}</link>` : null,
    `<description>${wrapCdata(siteDescription || siteTitle || "Flux RSS")}</description>`,
    `<language>${escapeXml(language || DEFAULT_LANGUAGE)}</language>`,
    `<lastBuildDate>${formatRfc822(fallbackDate || new Date())}</lastBuildDate>`,
    `<generator>${wrapCdata(generator || FALLBACK_GENERATOR)}</generator>`,
  ].filter(Boolean);

  if (atomLink) {
    channelParts.push(
      `<atom:link href="${escapeXml(atomLink)}" rel="self" type="application/rss+xml" />`,
    );
  }

  const itemsXml = normalizedItems.map((item) => buildItemXml(item)).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">\n  <channel>\n    ${channelParts.join("\n    ")}\n${itemsXml ? itemsXml + "\n" : ""}  </channel>\n</rss>\n`;
}
