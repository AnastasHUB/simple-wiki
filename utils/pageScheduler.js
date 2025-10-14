import { all, run } from "../db.js";
import { sendAdminEvent, sendFeedEvent } from "./webhook.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
let intervalHandle = null;

function normalizeIsoTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

export async function publishScheduledPages({ now = new Date() } = {}) {
  const nowIso = normalizeIsoTimestamp(now);
  const duePages = await all(
    `
    SELECT p.id,
           p.snowflake_id,
           p.slug_id,
           p.slug_base,
           p.title,
           p.content,
           p.author,
           p.publish_at,
           GROUP_CONCAT(t.name, ',') AS tagsCsv
      FROM pages p
      LEFT JOIN page_tags pt ON pt.page_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
     WHERE p.status = 'scheduled'
       AND p.publish_at IS NOT NULL
       AND datetime(p.publish_at) <= datetime(?)
     GROUP BY p.id
  `,
    [nowIso],
  );

  if (!Array.isArray(duePages) || !duePages.length) {
    return 0;
  }

  await run(
    `UPDATE pages
        SET status = 'published',
            updated_at = CURRENT_TIMESTAMP
      WHERE status = 'scheduled'
        AND publish_at IS NOT NULL
        AND datetime(publish_at) <= datetime(?)`,
    [nowIso],
  );

  for (const page of duePages) {
    const tags = page.tagsCsv || "";
    try {
      await sendAdminEvent("Page programmée publiée", {
        page: {
          title: page.title,
          slug_id: page.slug_id,
          slug_base: page.slug_base,
          snowflake_id: page.snowflake_id,
        },
        extra: {
          status: "published",
          publish_at: page.publish_at,
          triggered_at: nowIso,
        },
      });
      await sendFeedEvent(
        "Nouvel article",
        {
          page: {
            title: page.title,
            slug_id: page.slug_id,
            snowflake_id: page.snowflake_id,
            content: page.content,
          },
          author: page.author || "Anonyme",
          url: `/wiki/${page.slug_id}`,
          tags,
        },
        { articleContent: page.content },
      );
    } catch (err) {
      console.error("Failed to notify scheduled publication", {
        slug: page.slug_id,
        error: err,
      });
    }
  }

  return duePages.length;
}

export function startScheduledPublicationJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const parsedInterval = Number(intervalMs);
  const normalizedInterval =
    Number.isFinite(parsedInterval) && parsedInterval >= 5000
      ? parsedInterval
      : DEFAULT_INTERVAL_MS;
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
  intervalHandle = setInterval(() => {
    publishScheduledPages().catch((err) => {
      console.error("Failed to publish scheduled pages", err);
    });
  }, normalizedInterval);
  return intervalHandle;
}
