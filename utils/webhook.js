import fetch, { FormData } from "node-fetch";
import { Blob } from "buffer";
import { logEvent } from "../db.js";
import { buildArticleMarkdownDescription } from "./articleFormatter.js";
import { getSiteSettings } from "./settingsService.js";

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
  return Object.entries(data)
    .map(([name, value]) => {
      const formatted = formatFieldValue(value);
      if (!formatted) return null;
      const trimmed =
        formatted.length > 1024 ? formatted.slice(0, 1021).trimEnd() + "…" : formatted;
      return { name, value: trimmed };
    })
    .filter(Boolean);
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

function formatPageSummary(page, url) {
  if (!page) return "";
  const lines = [];
  if (page.title) {
    lines.push(`**Titre :** ${page.title}`);
  }
  const link = url || (page.slug_id ? `/wiki/${page.slug_id}` : "");
  if (link) {
    lines.push(`**Lien :** ${link}`);
  } else if (page.slug_id) {
    lines.push(`**Identifiant :** ${page.slug_id}`);
  }
  return lines.join("\n");
}

async function dispatch(url, payload, attachments = []) {
  if (!url) return;
  try {
    if (attachments.length) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      attachments.forEach((file, idx) => {
        const blob = new Blob([file.buffer], {
          type: file.contentType || "application/octet-stream",
        });
        form.append(`files[${idx}]`, blob, file.filename);
      });
      await fetch(url, { method: "POST", body: form });
    } else {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    console.warn("Unable to send webhook", err?.message || err);
  }
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

  const pageSummary = formatPageSummary(data?.page, data?.url);
  if (pageSummary) {
    sections.push(pageSummary);
  }

  const metaLines = formatMetaLines(meta);
  if (metaLines.length) {
    sections.push(metaLines.join("\n"));
  }

  const description = sections.filter(Boolean).join("\n\n");

  const payload = {
    embeds: [
      {
        title,
        timestamp: new Date().toISOString(),
        color: channel === "admin" ? 0x5865f2 : 0x57f287,
        description,
        fields: buildFields({
          Commentaire: data.comment,
          Utilisateur: data.user,
        }),
      },
    ],
  };

  const attachments = Array.isArray(options.attachments)
    ? options.attachments
    : [];
  if (options.embedImage) {
    payload.embeds[0].image = { url: `attachment://${options.embedImage}` };
  }

  await logEvent({
    channel,
    type: title,
    payload: { data, options },
    ip: data?.extra?.ip || null,
    username: data?.user || null,
  });
  await dispatch(url, payload, attachments);
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
