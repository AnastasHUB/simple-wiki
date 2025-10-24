import sanitizeHtml from "sanitize-html";

const TEXT_SANITIZE_OPTIONS = {
  allowedTags: [],
  allowedAttributes: {},
};

function toAbsoluteUrl(baseUrl, value, protocol = "http") {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `${protocol}:${trimmed}`;
  }
  if (trimmed.startsWith("/")) {
    return `${baseUrl}${trimmed}`;
  }
  return `${baseUrl}/${trimmed.replace(/^\.\//, "")}`;
}

function extractPlainText(html) {
  if (!html) {
    return "";
  }
  const sanitized = sanitizeHtml(String(html), TEXT_SANITIZE_OPTIONS);
  return sanitized.replace(/\s+/g, " ").trim();
}

function truncateWithEllipsis(text, maxLength) {
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return text;
  }
  if (text.length <= maxLength) {
    return text;
  }
  const slice = text.slice(0, maxLength - 1).trimEnd();
  return `${slice}…`;
}

function findFirstImageUrl(content, { baseUrl, protocol }) {
  if (!content) return null;
  const match = /<img[^>]*src=["']([^"']+)["']/i.exec(content);
  if (!match) return null;
  return toAbsoluteUrl(baseUrl, match[1], protocol);
}

export function buildPageMeta({
  page,
  baseUrl,
  siteName = "",
  logoUrl = "",
  tags = [],
  protocol = "http",
  descriptionLength = 280,
} = {}) {
  if (!page) {
    return {};
  }
  const pageUrl = page.slug_id ? `${baseUrl}/wiki/${page.slug_id}` : baseUrl;
  const plainText = extractPlainText(page.content || "");
  const description = truncateWithEllipsis(plainText, descriptionLength);
  const firstImage = findFirstImageUrl(page.content, { baseUrl, protocol });
  const fallbackImage = toAbsoluteUrl(baseUrl, logoUrl, protocol);
  const image = firstImage || fallbackImage || null;

  const publishedTime = page.created_at
    ? new Date(page.created_at).toISOString()
    : null;
  const modifiedTime = page.updated_at
    ? new Date(page.updated_at).toISOString()
    : null;

  return {
    title: page.title || siteName || "Wiki",
    description,
    url: pageUrl,
    type: "article",
    image,
    siteName: siteName || "",
    publishedTime,
    modifiedTime,
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    twitterCard: image ? "summary_large_image" : "summary",
  };
}
