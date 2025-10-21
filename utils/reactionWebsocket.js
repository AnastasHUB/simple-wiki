import { WebSocketServer } from "ws";

const REACTION_SOCKET_PATH = "/ws/reactions";
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAGE_SUBSCRIPTIONS = 8;
const MAX_COMMENT_SUBSCRIPTIONS = 400;
const SOCKET_HANDLED_FLAG = Symbol.for("simpleWiki.websocketHandled");

const clients = new Set();
let heartbeatTimer = null;

function sanitizeSlug(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 128);
}

function sanitizeCommentId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 128);
}

function parseSubscriptionList(values, limit, sanitizer) {
  const result = new Set();
  if (!values) {
    return result;
  }
  const source = Array.isArray(values) ? values : [values];
  for (const entry of source) {
    if (result.size >= limit) {
      break;
    }
    const sanitized = sanitizer(entry);
    if (sanitized) {
      result.add(sanitized);
    }
  }
  return result;
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  try {
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.warn("Failed to send WebSocket payload", error);
  }
}

function sendError(ws, message) {
  sendJson(ws, { type: "error", message: message || "Requête invalide" });
}

function cleanupClient(ws) {
  clients.delete(ws);
  if (ws && typeof ws.terminate === "function" && ws.readyState !== ws.CLOSED) {
    try {
      ws.terminate();
    } catch {
      // ignore termination errors
    }
  }
}

function ensureHeartbeat() {
  if (heartbeatTimer) {
    return;
  }
  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (!ws || ws.readyState !== ws.OPEN) {
        cleanupClient(ws);
        continue;
      }
      if (ws.isAlive === false) {
        cleanupClient(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (error) {
        console.warn("Unable to ping reaction WebSocket client", error);
        cleanupClient(ws);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
}

function normalizeReactionEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const key =
    typeof entry.key === "string"
      ? entry.key
      : typeof entry.id === "string"
      ? entry.id
      : null;
  if (!key) {
    return null;
  }
  const count = Number.isFinite(entry.count) ? Number(entry.count) : 0;
  return {
    key,
    id: key,
    count,
  };
}

function normalizeBroadcastPayload(update) {
  if (!update || typeof update !== "object") {
    return null;
  }
  const target = update.target === "comment" ? "comment" : update.target === "page" ? "page" : null;
  if (!target) {
    return null;
  }
  const normalized = {
    target,
    reactions: Array.isArray(update.reactions)
      ? update.reactions.map((item) => normalizeReactionEntry(item)).filter(Boolean)
      : [],
  };
  const slug = sanitizeSlug(
    typeof update.slug === "string"
      ? update.slug
      : typeof update.page === "string"
      ? update.page
      : typeof update.pageSlug === "string"
      ? update.pageSlug
      : "",
  );
  if (slug) {
    normalized.slug = slug;
  }
  if (target === "page") {
    if (!normalized.slug) {
      return null;
    }
  } else if (target === "comment") {
    const commentId = sanitizeCommentId(
      typeof update.commentId === "string"
        ? update.commentId
        : typeof update.comment === "string"
        ? update.comment
        : "",
    );
    if (!commentId) {
      return null;
    }
    normalized.commentId = commentId;
  }
  return normalized;
}

function isClientSubscribed(ws, payload) {
  if (!ws || !ws.subscriptions || !payload) {
    return false;
  }
  const slugValue = typeof payload.slug === "string" ? payload.slug : null;
  const slug = slugValue ? sanitizeSlug(slugValue) : null;
  if (slug && ws.subscriptions.pages.has(slug)) {
    return true;
  }
  if (payload.target === "comment") {
    const commentId = sanitizeCommentId(payload.commentId);
    return commentId ? ws.subscriptions.comments.has(commentId) : false;
  }
  return false;
}

function handleSetSubscriptions(ws, message) {
  const pages = parseSubscriptionList(message.pages, MAX_PAGE_SUBSCRIPTIONS, sanitizeSlug);
  const comments = parseSubscriptionList(message.comments, MAX_COMMENT_SUBSCRIPTIONS, sanitizeCommentId);
  ws.subscriptions = {
    pages,
    comments,
  };
  sendJson(ws, {
    type: "subscriptionAck",
    pages: Array.from(pages),
    comments: Array.from(comments),
  });
}

function handleClientMessage(ws, raw) {
  if (typeof raw !== "string") {
    sendError(ws, "Format de message inattendu");
    return;
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    sendError(ws, "Message JSON invalide");
    return;
  }
  if (!message || typeof message !== "object") {
    sendError(ws, "Message invalide");
    return;
  }
  switch (message.type) {
    case "setSubscriptions":
      handleSetSubscriptions(ws, message);
      break;
    case "ping":
      sendJson(ws, { type: "pong" });
      break;
    default:
      sendError(ws, "Commande inconnue");
      break;
  }
}

function extractInitialSubscriptions(request) {
  try {
    const url = new URL(request.url, "http://localhost");
    const pages = parseSubscriptionList(url.searchParams.getAll("page"), MAX_PAGE_SUBSCRIPTIONS, sanitizeSlug);
    const comments = parseSubscriptionList(
      url.searchParams.getAll("comment"),
      MAX_COMMENT_SUBSCRIPTIONS,
      sanitizeCommentId,
    );
    return { pages, comments };
  } catch {
    return { pages: new Set(), comments: new Set() };
  }
}

export function setupReactionWebSocket(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request[SOCKET_HANDLED_FLAG]) {
      return;
    }
    const { url } = request;
    if (!url || !url.startsWith(REACTION_SOCKET_PATH)) {
      return;
    }

    request[SOCKET_HANDLED_FLAG] = true;

    sessionMiddleware(request, {}, (err) => {
      if (err) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });
  });

  wss.on("connection", (ws, request) => {
    ws.isAlive = true;
    const initial = extractInitialSubscriptions(request);
    ws.subscriptions = {
      pages: initial.pages,
      comments: initial.comments,
    };
    clients.add(ws);
    ensureHeartbeat();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      handleClientMessage(ws, typeof raw === "string" ? raw : raw.toString());
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  wss.on("close", () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });
}

export function broadcastReactionUpdate(update) {
  const payload = normalizeBroadcastPayload(update);
  if (!payload) {
    return 0;
  }
  const message = JSON.stringify({ type: "reactionUpdate", payload });
  let delivered = 0;
  for (const ws of clients) {
    if (!ws || ws.readyState !== ws.OPEN) {
      continue;
    }
    if (!isClientSubscribed(ws, payload)) {
      continue;
    }
    try {
      ws.send(message);
      delivered += 1;
    } catch (error) {
      console.warn("Failed to deliver reaction update", error);
      clients.delete(ws);
    }
  }
  return delivered;
}

function normalizeLikePayload(update) {
  if (!update || typeof update !== "object") {
    return null;
  }
  const slug = sanitizeSlug(
    typeof update.slug === "string"
      ? update.slug
      : typeof update.page === "string"
      ? update.page
      : typeof update.pageSlug === "string"
      ? update.pageSlug
      : "",
  );
  if (!slug) {
    return null;
  }
  const likes = Number.isFinite(update.likes) ? Number(update.likes) : 0;
  const payload = { slug, likes };
  if (Object.prototype.hasOwnProperty.call(update, "liked")) {
    payload.liked = Boolean(update.liked);
  }
  return payload;
}

export function broadcastLikeUpdate(update) {
  const payload = normalizeLikePayload(update);
  if (!payload) {
    return 0;
  }
  const message = JSON.stringify({ type: "likeUpdate", payload });
  let delivered = 0;
  for (const ws of clients) {
    if (!ws || ws.readyState !== ws.OPEN) {
      continue;
    }
    if (!isClientSubscribed(ws, payload)) {
      continue;
    }
    try {
      ws.send(message);
      delivered += 1;
    } catch (error) {
      console.warn("Failed to deliver like update", error);
      clients.delete(ws);
    }
  }
  return delivered;
}
