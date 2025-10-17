import { WebSocketServer } from "ws";

import {
  ACTIVE_VISITOR_TTL_MS,
  LIVE_VISITOR_DEFAULT_PAGE_SIZE,
  LIVE_VISITOR_PAGE_SIZES,
  getLiveVisitorsSnapshot,
  subscribeLiveVisitorUpdates,
} from "./liveStats.js";

const LIVE_STATS_SOCKET_PATH = "/admin/stats/live";
const HEARTBEAT_INTERVAL_MS = 30000;
const SOCKET_HANDLED_FLAG = Symbol.for("simpleWiki.websocketHandled");

function clampPerPage(value) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return LIVE_VISITOR_DEFAULT_PAGE_SIZE;
  }
  if (LIVE_VISITOR_PAGE_SIZES.includes(numeric)) {
    return numeric;
  }
  const closest = LIVE_VISITOR_PAGE_SIZES.find((size) => size >= numeric);
  return closest ?? LIVE_VISITOR_PAGE_SIZES[LIVE_VISITOR_PAGE_SIZES.length - 1];
}

function normalizePage(value, totalPages) {
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 1;
  }
  return Math.min(Math.max(1, numeric), Math.max(1, totalPages));
}

function buildPaginatedPayload(snapshot, state) {
  const windowSeconds = Math.round(ACTIVE_VISITOR_TTL_MS / 1000);
  const perPage = clampPerPage(state.perPage);
  const totalItems = snapshot.visitors.length;
  const totalPages = Math.max(1, Math.ceil(Math.max(totalItems, 1) / perPage));
  const page = normalizePage(state.page, totalPages);
  const offset = (page - 1) * perPage;
  const visitors = snapshot.visitors.slice(offset, offset + perPage);

  state.page = page;
  state.perPage = perPage;
  state.totalPages = totalPages;
  state.totalItems = totalItems;

  return {
    type: "liveStatsSnapshot",
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    visitors,
    pagination: {
      page,
      perPage,
      totalItems,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      previousPage: page > 1 ? page - 1 : null,
      nextPage: page < totalPages ? page + 1 : null,
    },
    liveVisitorsWindowSeconds: windowSeconds,
  };
}

function sendPayload(ws, state, snapshot) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  const payload = buildPaginatedPayload(snapshot, state);
  ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "error",
      message,
    }),
  );
}

function parseClientMessage(data) {
  if (typeof data !== "string") {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function extractInitialStateFromRequest(req) {
  try {
    const url = new URL(req.url, "http://localhost");
    const page = url.searchParams.get("livePage");
    const perPage = url.searchParams.get("livePerPage");
    return {
      page: Number.parseInt(page, 10) || 1,
      perPage: Number.parseInt(perPage, 10) || LIVE_VISITOR_DEFAULT_PAGE_SIZE,
    };
  } catch {
    return { page: 1, perPage: LIVE_VISITOR_DEFAULT_PAGE_SIZE };
  }
}

export function setupLiveStatsWebSocket(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (request[SOCKET_HANDLED_FLAG]) {
      return;
    }
    const { url } = request;
    if (!url || !url.startsWith(LIVE_STATS_SOCKET_PATH)) {
      return;
    }

    request[SOCKET_HANDLED_FLAG] = true;

    sessionMiddleware(request, {}, (err) => {
      if (err) {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }
      const user = request.session?.user;
      const canView = Boolean(
        user?.can_view_stats && user?.can_view_stats_detailed,
      );
      if (!canView) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
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
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    const state = {
      page: 1,
      perPage: LIVE_VISITOR_DEFAULT_PAGE_SIZE,
      totalPages: 1,
      totalItems: 0,
    };

    Object.assign(state, extractInitialStateFromRequest(request));

    const unsubscribe = subscribeLiveVisitorUpdates(
      (snapshot) => {
        sendPayload(ws, state, snapshot);
      },
      { immediate: false },
    );

    ws.on("message", (raw) => {
      const message = parseClientMessage(typeof raw === "string" ? raw : raw.toString());
      if (!message) {
        sendError(ws, "Requête invalide");
        return;
      }

      switch (message.type) {
        case "requestSnapshot": {
          const snapshot = getLiveVisitorsSnapshot(Date.now());
          sendPayload(ws, state, snapshot);
          break;
        }
        case "setPagination": {
          if (message.page !== undefined) {
            state.page = Number.parseInt(message.page, 10) || state.page;
          }
          if (message.perPage !== undefined) {
            state.perPage = Number.parseInt(message.perPage, 10) || state.perPage;
          }
          const snapshot = getLiveVisitorsSnapshot(Date.now());
          sendPayload(ws, state, snapshot);
          break;
        }
        default:
          sendError(ws, "Commande inconnue");
      }
    });

    ws.on("close", () => {
      unsubscribe();
    });

    ws.on("error", () => {
      unsubscribe();
    });

    sendPayload(ws, state, getLiveVisitorsSnapshot(Date.now()));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }
}
