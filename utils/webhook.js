import fetch, { FormData } from "node-fetch";
import { Blob } from "buffer";
import { get, logEvent } from "../db.js";
import { buildArticleMarkdownDescription } from "./articleFormatter.js";

function buildFields(data) {
  if (!data) return [];
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => {
      let formatted;
      if (typeof value === "string") {
        formatted = value.length > 1024 ? value.slice(0, 1021) + "…" : value;
      } else {
        const json = JSON.stringify(value, null, 2);
        formatted = "```json\n" + (json.length > 1000 ? json.slice(0, 997) + "…" : json) + "\n```";
      }
      return { name, value: formatted };
    });
}

async function dispatch(url, payload, attachments = []) {
  if (!url) return;
  try {
    if (attachments.length) {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      attachments.forEach((file, idx) => {
        const blob = new Blob([file.buffer], { type: file.contentType || "application/octet-stream" });
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
  const settings = await get("SELECT admin_webhook_url, feed_webhook_url FROM settings WHERE id=1");
  const url = channel === "admin" ? settings?.admin_webhook_url : settings?.feed_webhook_url;
  const meta = { ...(data?.extra || {}) };
  for (const [key, value] of Object.entries(data || {})) {
    if (["page", "comment", "user", "description", "extra"].includes(key)) continue;
    meta[key] = value;
  }
  const description =
    typeof data?.description === "string" && data.description.trim().length
      ? data.description.trim()
      : channel === "feed" && data?.page?.title
      ? `**${data.page.title}**`
      : data?.description || "";

  const payload = {
    embeds: [
      {
        title,
        timestamp: new Date().toISOString(),
        color: channel === "admin" ? 0x5865f2 : 0x57f287,
        description,
        fields: buildFields({
          Page: data.page,
          Commentaire: data.comment,
          Utilisateur: data.user,
          Meta: meta,
        }),
      },
    ],
  };

  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
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
    const { articleContent, includeArticleScreenshot, ...restOptions } = options;
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
