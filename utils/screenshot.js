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
