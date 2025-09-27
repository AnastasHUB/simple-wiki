import { randomUUID } from "crypto";

const DEFAULT_TIMEOUT = 5000;

export function pushNotification(req, { type = "info", message, timeout = DEFAULT_TIMEOUT } = {}) {
  if (!req?.session || !message) {
    return;
  }
  if (!req.session.notifications) {
    req.session.notifications = [];
  }
  req.session.notifications.push({
    id: randomUUID(),
    type,
    message,
    timeout: Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT,
  });
}

export function consumeNotifications(req) {
  if (!req?.session?.notifications || !Array.isArray(req.session.notifications)) {
    return [];
  }
  const notifications = req.session.notifications.slice();
  req.session.notifications = [];
  return notifications;
}
