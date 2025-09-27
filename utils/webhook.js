import fetch, { FormData } from "node-fetch";
import { Blob } from "buffer";
import { get, logEvent } from "../db.js";
import { renderEventScreenshot } from "./screenshot.js";

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
  const payload = {
    embeds: [
      {
        title,
        timestamp: new Date().toISOString(),
        color: channel === "admin" ? 0x5865f2 : 0x57f287,
        description:
          data?.page?.title && channel === "feed"
            ? `**${data.page.title}**`
            : data?.description || "",
        fields: buildFields({
          Page: data.page,
          Commentaire: data.comment,
          Utilisateur: data.user,
          Meta: meta,
        }),
      },
    ],
  };

  const attachments = [];
  if (options.includeScreenshot !== false) {
    const buffer = await renderEventScreenshot(title, data);
    if (buffer) {
      const filename = `event-${Date.now()}.png`;
      attachments.push({ buffer, filename, contentType: "image/png" });
      payload.embeds[0].image = { url: `attachment://${filename}` };
    }
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
  await sendEvent("feed", title, data, options);
}
