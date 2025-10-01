import { generateSnowflake } from "./snowflake.js";

const DEFAULT_TIMEOUT = 5000;

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  const href =
    typeof action.href === "string" && action.href.trim()
      ? action.href.trim()
      : null;
  if (!href) {
    return null;
  }
  const label =
    typeof action.label === "string" && action.label.trim()
      ? action.label.trim()
      : null;
  return { href, label };
}

export function pushNotification(
  req,
  { type = "info", message, timeout = DEFAULT_TIMEOUT, action = null } = {},
) {
  if (!req?.session || !message) {
    return;
  }
  if (!req.session.notifications) {
    req.session.notifications = [];
  }
  req.session.notifications.push({
    id: generateSnowflake(),
    type,
    message,
    timeout: Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT,
    action: normalizeAction(action),
  });
}

export function consumeNotifications(req) {
  if (
    !req?.session?.notifications ||
    !Array.isArray(req.session.notifications)
  ) {
    return [];
  }
  const notifications = req.session.notifications.slice();
  req.session.notifications = [];
  return notifications;
}
