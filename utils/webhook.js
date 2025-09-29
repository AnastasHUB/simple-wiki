import fetch, { FormData } from "node-fetch";
import { Blob } from "buffer";
import { logEvent } from "../db.js";
import { buildArticleMarkdownDescription } from "./articleFormatter.js";
import { getSiteSettings } from "./settingsService.js";

const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\//i;
const MAX_MESSAGE_CONTENT_LENGTH = 2000;
const MAX_EMBED_TITLE_LENGTH = 256;
const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
const MAX_EMBED_FOOTER_LENGTH = 2048;
const MAX_EMBED_FIELDS = 25;
const MAX_EMBEDS = 10;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampText(value, maxLength) {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatFieldValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => formatFieldValue(item))
      .filter(Boolean);
    return items.join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => {
        const formatted = formatFieldValue(val);
        return formatted ? `• **${key}** : ${formatted}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

function buildFields(data) {
  if (!data) return [];
  const fields = Object.entries(data)
    .map(([name, value]) => {
      const formatted = formatFieldValue(value);
      if (!formatted) return null;
      const trimmed =
        formatted.length > 1024 ? formatted.slice(0, 1021).trimEnd() + "…" : formatted;
      const fieldName = clampText(String(name ?? ""), 256);
      if (!fieldName) return null;
      return { name: fieldName, value: trimmed };
    })
    .filter(Boolean);

  return fields.slice(0, MAX_EMBED_FIELDS);
}

function formatMetaLines(meta) {
  if (!meta) return [];
  return Object.entries(meta)
    .map(([key, value]) => {
      const formatted = formatFieldValue(value);
      if (!formatted) return null;
      return formatted.includes("\n")
        ? `**${key} :**\n${formatted}`
        : `**${key} :** ${formatted}`;
    })
    .filter(Boolean);
}

function formatPageSummary(page, url, options = {}) {
  if (!page) return "";
  const { includeTitle = true, includeLink = true } = options;
  const lines = [];
  if (page.title && includeTitle) {
    lines.push(`**Titre :** ${page.title}`);
  }
  const link = url || (page.slug_id ? `/wiki/${page.slug_id}` : "");
  if (link && includeLink) {
    lines.push(`**Lien :** ${link}`);
  } else if (page.slug_id) {
    lines.push(`**Identifiant :** ${page.slug_id}`);
  }
  return lines.join("\n");
}

function isValidDiscordWebhookUrl(url) {
  return typeof url === "string" && DISCORD_WEBHOOK_RE.test(url.trim());
}

function normalizeAttachment(file, index) {
  if (!isRecord(file)) return null;

  const sourceBuffer =
    file.buffer instanceof Buffer
      ? file.buffer
      : ArrayBuffer.isView(file.buffer)
        ? Buffer.from(
            file.buffer.buffer,
            file.buffer.byteOffset,
            file.buffer.byteLength,
          )
        : typeof file.buffer === "string"
          ? Buffer.from(file.buffer, file.encoding || "utf8")
          : null;

  if (!sourceBuffer?.length) return null;

  const filename =
    typeof file.filename === "string" && file.filename.trim().length
      ? file.filename.trim()
      : `file-${index + 1}`;
  const contentType =
    typeof file.contentType === "string" && file.contentType.trim().length
      ? file.contentType.trim()
      : "application/octet-stream";

  return {
    buffer: sourceBuffer,
    filename,
    contentType,
  };
}

function createRequestInit(payload, attachments) {
  if (attachments.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    attachments.forEach((file, idx) => {
      const blob = new Blob([file.buffer], {
        type: file.contentType || "application/octet-stream",
      });
      form.append(`files[${idx}]`, blob, file.filename);
    });
    return { method: "POST", body: form };
  }

  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function parseRetryAfter(headers) {
  const retryAfterHeader = headers?.get?.("retry-after");
  if (!retryAfterHeader) return null;

  const numericValue = Number(retryAfterHeader);
  if (Number.isFinite(numericValue) && numericValue >= 0) {
    return numericValue * 1000;
  }

  const dateValue = Date.parse(retryAfterHeader);
  if (Number.isFinite(dateValue)) {
    return Math.max(0, dateValue - Date.now());
  }

  return null;
}

async function dispatch(url, payload, attachments = [], options = {}) {
  if (!isValidDiscordWebhookUrl(url)) return { ok: false, skipped: true };

  let endpoint;
  try {
    endpoint = new URL(url);
  } catch (err) {
    console.warn("Unable to send webhook", err?.message || err);
    return { ok: false, error: err };
  }

  if (options.threadId && !endpoint.searchParams.has("thread_id")) {
    endpoint.searchParams.set("thread_id", String(options.threadId));
  }
  if (options.waitForDelivery && !endpoint.searchParams.has("wait")) {
    endpoint.searchParams.set("wait", "true");
  }

  const normalizedAttachments = attachments
    .map((file, index) => normalizeAttachment(file, index))
    .filter(Boolean);

  const endpointUrl = endpoint.toString();
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_RETRIES) {
    attempt += 1;
    try {
      const requestInit = createRequestInit(payload, normalizedAttachments);
      const response = await fetch(endpointUrl, requestInit);

      if (response.status === 204 || response.ok) {
        return { ok: true };
      }

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers);
        const waitFor = retryAfter ?? BASE_RETRY_DELAY_MS * attempt;
        await sleep(waitFor);
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
        await sleep(BASE_RETRY_DELAY_MS * attempt);
        continue;
      }

      const bodyText = await response.text().catch(() => "");
      const reason = bodyText ? `${response.status} ${response.statusText}: ${bodyText}` : `${response.status} ${response.statusText}`;
      console.warn("Unable to send webhook", reason);
      return { ok: false, status: response.status };
    } catch (err) {
      lastError = err;
      if (attempt >= MAX_RETRIES) {
        console.warn("Unable to send webhook", err?.message || err);
        return { ok: false, error: err };
      }
      await sleep(BASE_RETRY_DELAY_MS * attempt);
    }
  }

  if (lastError) {
    console.warn("Unable to send webhook", lastError?.message || lastError);
  }
  return { ok: false, error: lastError };
}

async function sendEvent(channel, title, data = {}, options = {}) {
  const settings = await getSiteSettings();
  const url =
    channel === "admin" ? settings.adminWebhook : settings.feedWebhook;
  const meta = { ...(data?.extra || {}) };
  for (const [key, value] of Object.entries(data || {})) {
    if (["page", "comment", "user", "description", "extra"].includes(key))
      continue;
    meta[key] = value;
  }

  const descriptionSeed =
    typeof data?.description === "string" && data.description.trim().length
      ? data.description.trim()
      : channel === "feed" && data?.page?.title
        ? `**${data.page.title}**`
        : data?.description || "";

  const sections = [];
  if (descriptionSeed) {
    sections.push(descriptionSeed);
  }

  const normalizedDescription =
    typeof descriptionSeed === "string" ? descriptionSeed.toLowerCase() : "";
  const normalizedTitle =
    typeof data?.page?.title === "string" ? data.page.title.toLowerCase() : "";
  const descriptionContainsTitle =
    normalizedDescription && normalizedTitle
      ? normalizedDescription.includes(normalizedTitle)
      : false;
  const descriptionContainsUrl =
    Boolean(descriptionSeed) && Boolean(data?.url)
      ? descriptionSeed.includes(data.url)
      : false;

  const pageSummary = formatPageSummary(data?.page, data?.url, {
    includeTitle: !descriptionContainsTitle,
    includeLink: !descriptionContainsUrl,
  });
  if (pageSummary) {
    sections.push(pageSummary);
  }

  const metaLines = formatMetaLines(meta);
  if (metaLines.length) {
    sections.push(metaLines.join("\n"));
  }

  const description = clampText(
    sections.filter(Boolean).join("\n\n"),
    MAX_EMBED_DESCRIPTION_LENGTH,
  );

  const baseEmbed = {
    timestamp: new Date().toISOString(),
    color:
      typeof options.embedColor === "number"
        ? options.embedColor
        : channel === "admin"
          ? 0x5865f2
          : 0x57f287,
    description,
    fields: buildFields({
      Commentaire: data.comment,
      Utilisateur: data.user,
    }),
  };

  const embedTitle = clampText(String(title ?? "").trim(), MAX_EMBED_TITLE_LENGTH);
  if (embedTitle) {
    baseEmbed.title = embedTitle;
  }

  if (!description) {
    delete baseEmbed.description;
  }

  if (!baseEmbed.fields?.length) {
    delete baseEmbed.fields;
  }

  if (settings.footerText || options.embedFooterText) {
    baseEmbed.footer = {
      text: clampText(
        options.embedFooterText || settings.footerText,
        MAX_EMBED_FOOTER_LENGTH,
      ),
    };
  }

  if (isRecord(options.embedAuthor)) {
    baseEmbed.author = {
      name: clampText(options.embedAuthor.name ?? "", 256),
      url: options.embedAuthor.url,
      icon_url: options.embedAuthor.icon_url || options.embedAuthor.iconUrl,
    };
    if (!baseEmbed.author.name) {
      delete baseEmbed.author;
    }
  }

  const normalizedContent =
    typeof options.content === "string"
      ? clampText(options.content, MAX_MESSAGE_CONTENT_LENGTH)
      : undefined;

  const payload = {
    content: normalizedContent,
    username:
      typeof options.username === "string" && options.username.trim().length
        ? clampText(options.username.trim(), 80)
        : undefined,
    avatar_url:
      typeof options.avatarUrl === "string" && options.avatarUrl.trim().length
        ? options.avatarUrl.trim()
        : undefined,
    allowed_mentions: isRecord(options.allowedMentions)
      ? options.allowedMentions
      : undefined,
    components: Array.isArray(options.components) ? options.components : undefined,
    embeds: [baseEmbed],
  };

  const embedImageName =
    typeof options.embedImage === "string" && options.embedImage.trim().length
      ? options.embedImage.trim()
      : null;
  if (embedImageName) {
    baseEmbed.image = { url: `attachment://${embedImageName}` };
  }

  if (Array.isArray(options.extraEmbeds) && options.extraEmbeds.length) {
    const extraEmbeds = options.extraEmbeds
      .filter(isRecord)
      .map((embed) => ({ ...embed }));
    if (extraEmbeds.length) {
      payload.embeds.push(
        ...extraEmbeds.slice(0, Math.max(0, MAX_EMBEDS - payload.embeds.length)),
      );
    }
  }

  payload.embeds = payload.embeds.slice(0, MAX_EMBEDS);

  const attachments = Array.isArray(options.attachments)
    ? options.attachments
    : [];

  await logEvent({
    channel,
    type: title,
    payload: { data, options },
    ip: data?.extra?.ip || null,
    username: data?.user || null,
  });
  await dispatch(url, payload, attachments, {
    threadId: options.threadId,
    waitForDelivery: Boolean(options.waitForDelivery),
  });
}

export async function sendAdminEvent(title, data = {}, options = {}) {
  await sendEvent("admin", title, data, options);
}

export async function sendFeedEvent(title, data = {}, options = {}) {
  if (title === "Nouvel article") {
    const { articleContent, includeArticleScreenshot, ...restOptions } =
      options;
    const content = articleContent ?? data?.page?.content;
    const description = buildArticleMarkdownDescription({
      title: data?.page?.title,
      content,
      author: data?.author,
      tags: data?.tags,
      url: data?.url,
    });

    const payloadData = { ...data, description };
    await sendEvent("feed", title, payloadData, restOptions);
    return;
  }

  const { articleContent, includeArticleScreenshot, ...restOptions } = options;
  await sendEvent("feed", title, data, restOptions);
}
