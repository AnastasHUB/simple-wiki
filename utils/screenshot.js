import sharp from "sharp";

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBody(data) {
  const parts = [];
  if (data?.page?.title) {
    parts.push(`Article: ${data.page.title}`);
  }
  if (data?.page?.slug_id) {
    parts.push(`Slug: ${data.page.slug_id}`);
  }
  if (data?.comment?.preview) {
    parts.push(`Commentaire: ${data.comment.preview}`);
  }
  if (data?.extra?.ip) {
    parts.push(`IP: ${data.extra.ip}`);
  }
  if (data?.user) {
    parts.push(`Utilisateur: ${data.user}`);
  }
  if (!parts.length && data) {
    parts.push(JSON.stringify(data, null, 2));
  }
  return parts.join("\n");
}

export async function renderEventScreenshot(title, data) {
  try {
    const width = 1200;
    const height = 630;
    const body = formatBody(data);
    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="#1e293b" />
            <stop offset="100%" stop-color="#0f172a" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#bg)" />
        <text x="60" y="140" fill="#38bdf8" font-size="60" font-weight="700">${escapeXml(
          title,
        )}</text>
        <foreignObject x="60" y="200" width="1080" height="360">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:30px;color:#e2e8f0;font-family:'Segoe UI',sans-serif;white-space:pre-line;">
            ${escapeXml(body)}
          </div>
        </foreignObject>
      </svg>
    `;
    return sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    console.warn("Unable to render screenshot", err?.message || err);
    return null;
  }
}

function sanitizeContent(content) {
  if (!content) return "";
  return String(content)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export async function renderArticleScreenshot({ title, content, author, tags, url }) {
  try {
    const width = 1200;
    const height = 630;
    const preview = sanitizeContent(content) || "L'article est prêt à être découvert !";
    const limitedPreview = preview.length > 900 ? preview.slice(0, 897) + "…" : preview;
    const metaParts = [];
    if (author) metaParts.push(`✍️ ${author}`);
    if (url) metaParts.push(url);
    const tagList = normalizeTags(tags);
    const tagLine = tagList.length ? tagList.map((t) => `#${t}`).join("  ") : "";

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="article-bg" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="#0f172a" />
            <stop offset="100%" stop-color="#1e3a8a" />
          </linearGradient>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="rgba(15,23,42,0.45)" />
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#article-bg)" />
        <g filter="url(#shadow)">
          <rect x="80" y="80" width="1040" height="470" rx="32" fill="rgba(15,23,42,0.65)" />
          <foreignObject x="120" y="120" width="960" height="390">
            <div xmlns="http://www.w3.org/1999/xhtml" style="color:#f8fafc;font-family:'Segoe UI',sans-serif;">
              <p style="margin:0 0 16px;font-size:26px;letter-spacing:4px;color:#38bdf8;text-transform:uppercase;">Nouvel article</p>
              <h1 style="margin:0 0 12px;font-size:54px;line-height:1.1;">${escapeXml(title || "Article")}</h1>
              ${metaParts.length ? `<p style="margin:0 0 18px;font-size:22px;color:#cbd5f5;">${escapeXml(metaParts.join(" • "))}</p>` : ""}
              ${tagLine ? `<p style="margin:0 0 18px;font-size:20px;color:#93c5fd;">${escapeXml(tagLine)}</p>` : ""}
              <p style="margin:0;font-size:24px;line-height:1.5;color:#e2e8f0;white-space:pre-line;">${escapeXml(limitedPreview)}</p>
            </div>
          </foreignObject>
        </g>
      </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
  } catch (err) {
    console.warn("Unable to render article screenshot", err?.message || err);
    return null;
  }
}
