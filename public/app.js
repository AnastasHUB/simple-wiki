(function () {
  const toggleBtn = document.getElementById("sidebarToggle");
  const overlayHit = document.getElementById("overlayHit"); // zone cliquable à droite
  const drawer = document.querySelector(".nav-drawer");
  const links = document.querySelectorAll("#vnav a");
  const closeButtons = document.querySelectorAll("[data-close-nav]");
  const html = document.documentElement;

  const clearOverlayBounds = () => {
    if (!overlayHit) return;
    overlayHit.style.removeProperty("--overlay-left");
  };

  const scheduleOverlaySync = () => {
    if (!overlayHit || !drawer) {
      return;
    }
    if (!html.classList.contains("drawer-open")) {
      clearOverlayBounds();
      return;
    }
    const styles = window.getComputedStyle(drawer);
    const leftValue = parseFloat(styles.left) || 0;
    const overlayLeft = Math.min(
      window.innerWidth,
      Math.max(0, leftValue + drawer.offsetWidth),
    );
    overlayHit.style.setProperty("--overlay-left", `${overlayLeft}px`);
  };

  const setExpanded = (expanded) => {
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggleBtn.setAttribute(
      "aria-label",
      expanded ? "Fermer le menu" : "Ouvrir le menu",
    );
    const icon = toggleBtn.querySelector(".icon");
    if (icon) {
      icon.textContent = expanded ? "✕" : "☰";
    }
  };

  const openDrawer = () => {
    html.classList.add("drawer-open");
    setExpanded(true);
    scheduleOverlaySync();
  };
  const closeDrawer = () => {
    if (!html.classList.contains("drawer-open")) {
      return;
    }
    html.classList.remove("drawer-open");
    setExpanded(false);
    clearOverlayBounds();
  };

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      html.classList.contains("drawer-open") ? closeDrawer() : openDrawer();
    });
    setExpanded(html.classList.contains("drawer-open"));
  }

  overlayHit && overlayHit.addEventListener("click", closeDrawer);
  closeButtons.forEach((btn) => btn.addEventListener("click", closeDrawer));
  links.forEach((a) => a.addEventListener("click", closeDrawer));

  scheduleOverlaySync();

  window.addEventListener("resize", scheduleOverlaySync, { passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDrawer();
    }
  });

  const mq = window.matchMedia("(min-width: 1025px)");
  if (mq.addEventListener) {
    mq.addEventListener("change", (event) => {
      if (event.matches) {
        closeDrawer();
      }
    });
  } else if (mq.addListener) {
    // Safari < 14
    mq.addListener((event) => {
      if (event.matches) {
        closeDrawer();
      }
    });
  }
})();

document.addEventListener("DOMContentLoaded", () => {
  initAmbientBackdrop();
  initNotifications();
  enhanceIconButtons();
  initLikeForms();
  initMarkdownEditor();
  initCodeHighlighting();
  initLiveStatsCard();
});

function enhanceIconButtons() {
  document.querySelectorAll(".btn[data-icon]").forEach((btn) => {
    if (btn.querySelector(".btn-icon")) {
      return;
    }

    const icon = btn.getAttribute("data-icon");
    if (!icon) {
      return;
    }

    const iconSpan = document.createElement("span");
    iconSpan.className = "btn-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = icon;
    btn.prepend(iconSpan);
  });
}

function initNotifications() {
  const layer = document.getElementById("notificationLayer");
  const dataEl = document.getElementById("initial-notifications");
  if (!layer || !dataEl) return;

  let notifications = [];
  try {
    notifications = JSON.parse(dataEl.textContent || "[]");
  } catch (err) {
    console.warn("Notifications JSON invalide", err);
  }

  notifications.forEach((notif, index) => {
    setTimeout(() => {
      spawnNotification(layer, notif);
    }, index * 120);
  });
}

function spawnNotification(layer, notif) {
  if (!notif?.message) return;

  const type = notif.type || "info";
  const timeout = Math.max(1500, Number(notif.timeout) || 5000);
  const item = document.createElement("div");
  item.className = `notification ${type}`;

  const icon = document.createElement("div");
  icon.className = "notification-icon";
  icon.textContent = getNotificationIcon(type);
  item.appendChild(icon);

  const body = document.createElement("div");
  body.className = "notification-body";

  const title = document.createElement("div");
  title.className = "notification-title";
  title.textContent = getNotificationTitle(type);
  body.appendChild(title);

  const message = document.createElement("div");
  message.className = "notification-message";
  const messageText = document.createElement("span");
  messageText.textContent = notif.message;
  message.appendChild(messageText);

  if (notif.action && typeof notif.action.href === "string") {
    const actionLink = document.createElement("a");
    actionLink.className = "notification-action";
    actionLink.href = notif.action.href;
    actionLink.textContent =
      typeof notif.action.label === "string" && notif.action.label
        ? notif.action.label
        : "Ouvrir";
    actionLink.rel = "noopener";
    message.appendChild(actionLink);
  }

  body.appendChild(message);

  item.appendChild(body);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "notification-close";
  close.setAttribute("aria-label", "Fermer la notification");
  close.textContent = "✕";
  item.appendChild(close);

  let removing = false;
  const remove = () => {
    if (removing || !item.isConnected) {
      return;
    }

    removing = true;
    item.classList.remove("show");

    const fallback = setTimeout(() => {
      if (item.isConnected) {
        item.remove();
      }
    }, 300);

    item.addEventListener(
      "transitionend",
      () => {
        clearTimeout(fallback);
        item.remove();
      },
      { once: true },
    );
  };

  close.addEventListener("click", remove);

  layer.appendChild(item);
  requestAnimationFrame(() => {
    item.classList.add("show");
  });

  setTimeout(remove, timeout);
}

function initLikeForms() {
  const forms = document.querySelectorAll("form[data-like-form-for]");
  if (!forms.length) {
    return;
  }

  forms.forEach((form) => {
    if (form.dataset.likeFormBound === "true") {
      return;
    }

    form.dataset.likeFormBound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handleLikeSubmit(event, form);
    });
  });
}


function initLiveStatsCard() {
  const card = document.querySelector("[data-live-stats-card]");
  if (!card) {
    return;
  }

  const endpoint = card.getAttribute("data-endpoint") || "/admin/stats/live";
  const pageParam = card.getAttribute("data-page-param") || "livePage";
  const perPageParam =
    card.getAttribute("data-per-page-param") || "livePerPage";
  const tableWrap = card.querySelector("[data-live-table]");
  const tbody = card.querySelector("[data-live-table-body]");
  const emptyMessage = card.querySelector("[data-live-empty]");
  const footer = card.querySelector("[data-live-footer]");
  const pageInfo = card.querySelector("[data-live-page-info]");
  const prevButton = card.querySelector("[data-live-prev]");
  const nextButton = card.querySelector("[data-live-next]");
  const perPageSelect = card.querySelector("[data-live-per-page]");
  const refreshSelect = card.querySelector("[data-live-refresh]");
  const windowLabel = card.querySelector("[data-live-window-label]");
  const statusEl = card.querySelector("[data-live-status]");

  if (
    !tbody ||
    !pageInfo ||
    !prevButton ||
    !nextButton ||
    !perPageSelect ||
    !refreshSelect ||
    !windowLabel ||
    !statusEl
  ) {
    return;
  }

  if (typeof window.WebSocket !== "function") {
    console.error("WebSocket n'est pas pris en charge par ce navigateur.");
    statusEl.textContent = "Dernière mise à jour : WebSocket non disponible";
    statusEl.classList.add("live-stats-status-error");
    return;
  }

  const locale = document.documentElement.lang || undefined;
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parseNumber = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const state = {
    page: parseNumber(card.getAttribute("data-live-page"), 1),
    perPage: parseNumber(
      card.getAttribute("data-live-per-page"),
      parseNumber(perPageSelect.value, 10),
    ),
    totalPages: parseNumber(card.getAttribute("data-live-total-pages"), 1),
    totalItems: parseNumber(card.getAttribute("data-live-total-items"), 0),
    refreshMs: parseNumber(refreshSelect.value, 5000),
    timerId: null,
    socket: null,
    reconnectTimerId: null,
    reconnectDelay: 1000,
    loading: false,
  };

  let destroyed = false;

  const setHidden = (element, hidden) => {
    if (!element) return;
    if (hidden) {
      element.setAttribute("hidden", "");
    } else {
      element.removeAttribute("hidden");
    }
  };

  const pluralize = (count, singular, plural) => {
    return `${count} ${count === 1 ? singular : plural}`;
  };

  const formatWindowLabel = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) {
      return "quelques secondes";
    }
    if (value >= 60) {
      const minutes = Math.max(1, Math.round(value / 60));
      return `${minutes} minute${minutes > 1 ? "s" : ""}`;
    }
    const secs = Math.max(1, Math.round(value));
    return `${secs} seconde${secs > 1 ? "s" : ""}`;
  };

  const updateWindowLabel = (seconds) => {
    windowLabel.textContent = `Basé sur l'activité des ${formatWindowLabel(seconds)} précédentes.`;
  };

  const parseTimestamp = (timestamp) => {
    if (!timestamp) {
      return null;
    }
    if (typeof timestamp === "string") {
      const date = new Date(timestamp);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  };

  const updateStatus = (timestamp, isError = false) => {
    if (isError) {
      statusEl.textContent = "Dernière mise à jour : échec de la connexion";
      statusEl.classList.add("live-stats-status-error");
      return;
    }
    statusEl.classList.remove("live-stats-status-error");
    if (!timestamp) {
      statusEl.textContent = "Dernière mise à jour : --";
      return;
    }
    const date = parseTimestamp(timestamp);
    if (!date) {
      statusEl.textContent = "Dernière mise à jour : --";
      return;
    }
    statusEl.textContent = `Dernière mise à jour : ${timeFormatter.format(date)}`;
  };

  const renderVisitors = (visitors) => {
    tbody.innerHTML = "";
    if (!Array.isArray(visitors) || !visitors.length) {
      return;
    }

    visitors.forEach((visitor) => {
      const row = document.createElement("tr");

      const ipCell = document.createElement("td");
      const ipCode = document.createElement("code");
      ipCode.textContent = visitor?.ip || "";
      ipCell.appendChild(ipCode);
      row.appendChild(ipCell);

      const typeCell = document.createElement("td");
      const statusPill = document.createElement("span");
      statusPill.className = `status-pill ${visitor?.isBot ? "suspicious" : "clean"}`;
      statusPill.textContent = visitor?.isBot ? "Bot" : "Visiteur";
      typeCell.appendChild(statusPill);

      if (visitor?.isBot && visitor?.botReason) {
        typeCell.appendChild(document.createElement("br"));
        const reason = document.createElement("small");
        reason.className = "text-muted";
        reason.textContent = visitor.botReason;
        typeCell.appendChild(reason);
      }

      if (visitor?.userAgent) {
        typeCell.appendChild(document.createElement("br"));
        const ua = document.createElement("small");
        ua.className = "text-muted";
        ua.textContent = visitor.userAgent;
        typeCell.appendChild(ua);
      }

      row.appendChild(typeCell);

      const pathCell = document.createElement("td");
      const pathLink = document.createElement("a");
      const pathValue = visitor?.path || "";
      pathLink.href = pathValue || "#";
      pathLink.textContent = pathValue || "—";
      pathCell.appendChild(pathLink);
      row.appendChild(pathCell);

      const timeCell = document.createElement("td");
      const timeEl = document.createElement("time");
      if (visitor?.lastSeenIso) {
        timeEl.setAttribute("datetime", visitor.lastSeenIso);
      }
      const relative = visitor?.lastSeenRelative || "";
      timeEl.textContent = relative ? `il y a ${relative}` : "—";
      timeCell.appendChild(timeEl);
      row.appendChild(timeCell);

      tbody.appendChild(row);
    });
  };

  const applyPagination = (pagination) => {
    if (!pagination) {
      return;
    }

    state.page = Math.max(1, parseNumber(pagination.page, state.page));
    state.perPage = Math.max(1, parseNumber(pagination.perPage, state.perPage));
    state.totalPages = Math.max(
      1,
      parseNumber(pagination.totalPages, state.totalPages),
    );
    state.totalItems = Math.max(
      0,
      parseNumber(pagination.totalItems, state.totalItems),
    );

    card.setAttribute("data-live-page", state.page);
    card.setAttribute("data-live-per-page", state.perPage);
    card.setAttribute("data-live-total-pages", state.totalPages);
    card.setAttribute("data-live-total-items", state.totalItems);

    if (perPageSelect) {
      perPageSelect.value = String(state.perPage);
    }

    if (pageInfo) {
      pageInfo.textContent = `Page ${state.page} sur ${state.totalPages} · ${pluralize(state.totalItems, "actif", "actifs")}`;
    }

    if (prevButton) {
      prevButton.disabled = !pagination.hasPrevious;
    }
    if (nextButton) {
      nextButton.disabled = !pagination.hasNext;
    }
  };

  const updateVisibility = (hasVisitors) => {
    setHidden(emptyMessage, hasVisitors);
    setHidden(tableWrap, !hasVisitors);
    setHidden(footer, !hasVisitors);
  };

  const canSend = () =>
    state.socket && state.socket.readyState === WebSocket.OPEN;

  const sendMessage = (message) => {
    if (!canSend()) {
      return false;
    }
    try {
      state.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error("Impossible d'envoyer le message de statistiques en direct", error);
      return false;
    }
  };

  const clearReconnectTimer = () => {
    if (state.reconnectTimerId) {
      window.clearTimeout(state.reconnectTimerId);
      state.reconnectTimerId = null;
    }
  };

  const scheduleReconnect = () => {
    if (destroyed || document.hidden) {
      return;
    }
    clearReconnectTimer();
    const delay = Math.min(state.reconnectDelay, 30000);
    state.reconnectTimerId = window.setTimeout(() => {
      state.reconnectTimerId = null;
      connect();
    }, delay);
    state.reconnectDelay = Math.min(delay * 2, 30000);
    updateStatus(null, true);
  };

  const requestSnapshot = () => {
    if (sendMessage({ type: "requestSnapshot" })) {
      state.loading = true;
    }
  };

  const pushPagination = () => {
    if (sendMessage({
      type: "setPagination",
      page: state.page,
      perPage: state.perPage,
    })) {
      state.loading = true;
    }
  };

  const handleSnapshot = (payload) => {
    const visitors = Array.isArray(payload?.visitors) ? payload.visitors : [];
    renderVisitors(visitors);
    updateVisibility(visitors.length > 0);
    if (payload?.pagination) {
      applyPagination(payload.pagination);
    }
    if (payload?.liveVisitorsWindowSeconds !== undefined) {
      const seconds = Number(payload.liveVisitorsWindowSeconds);
      card.setAttribute("data-live-window-seconds", seconds);
      updateWindowLabel(seconds);
    }
    updateStatus(payload?.generatedAt || Date.now());
    state.loading = false;
    restartTimer();
  };

  const handleSocketMessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload) {
        return;
      }
      if (payload.type === "liveStatsSnapshot") {
        handleSnapshot(payload);
      } else if (payload.type === "error") {
        console.error("Erreur des statistiques en direct", payload.message);
        updateStatus(null, true);
      }
    } catch (error) {
      console.error("Réception de données invalides pour les statistiques en direct", error);
    }
  };

  const buildSocketUrl = () => {
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set(pageParam, String(state.page));
    url.searchParams.set(perPageParam, String(state.perPage));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  };

  const connect = () => {
    if (destroyed) {
      return;
    }
    clearReconnectTimer();
    if (state.socket) {
      try {
        state.socket.close();
      } catch (error) {
        console.warn("Impossible de fermer l'ancienne connexion WebSocket", error);
      }
      state.socket = null;
    }
    let socket;
    try {
      socket = new WebSocket(buildSocketUrl());
    } catch (error) {
      console.error("Échec de l'initialisation de la connexion WebSocket", error);
      scheduleReconnect();
      return;
    }

    state.socket = socket;
    state.loading = true;

    socket.addEventListener("open", () => {
      state.reconnectDelay = 1000;
      updateStatus(Date.now());
      requestSnapshot();
    });

    socket.addEventListener("message", handleSocketMessage);

    socket.addEventListener("close", () => {
      state.socket = null;
      state.loading = false;
      if (!destroyed) {
        scheduleReconnect();
      }
    });

    socket.addEventListener("error", (event) => {
      console.error("Erreur WebSocket pour les statistiques en direct", event);
      updateStatus(null, true);
      try {
        socket.close();
      } catch (error) {
        console.warn("Impossible de fermer la connexion WebSocket", error);
      }
    });
  };

  const restartTimer = () => {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (!Number.isFinite(state.refreshMs) || state.refreshMs < 500) {
      return;
    }
    state.timerId = window.setInterval(() => {
      if (!state.loading) {
        requestSnapshot();
      }
    }, state.refreshMs);
  };

  const handlePerPageChange = () => {
    const value = parseNumber(perPageSelect.value, state.perPage);
    if (value === state.perPage) {
      return;
    }
    state.perPage = value;
    state.page = 1;
    pushPagination();
  };

  const handlePrev = () => {
    if (prevButton.disabled) {
      return;
    }
    const targetPage = Math.max(1, state.page - 1);
    state.page = targetPage;
    pushPagination();
  };

  const handleNext = () => {
    if (nextButton.disabled) {
      return;
    }
    const targetPage = state.page + 1;
    state.page = targetPage;
    pushPagination();
  };

  const handleRefreshChange = () => {
    state.refreshMs = parseNumber(refreshSelect.value, state.refreshMs);
    restartTimer();
  };

  perPageSelect.addEventListener("change", handlePerPageChange);
  prevButton.addEventListener("click", handlePrev);
  nextButton.addEventListener("click", handleNext);
  refreshSelect.addEventListener("change", handleRefreshChange);

  const handleVisibilityChange = () => {
    if (document.hidden) {
      if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = null;
      }
      return;
    }
    if (!state.socket || state.socket.readyState === WebSocket.CLOSED) {
      connect();
    }
    requestSnapshot();
    restartTimer();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  const cleanup = () => {
    destroyed = true;
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    clearReconnectTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    perPageSelect.removeEventListener("change", handlePerPageChange);
    prevButton.removeEventListener("click", handlePrev);
    nextButton.removeEventListener("click", handleNext);
    refreshSelect.removeEventListener("change", handleRefreshChange);
    if (state.socket) {
      try {
        state.socket.close();
      } catch (error) {
        console.warn("Impossible de fermer la connexion WebSocket lors du nettoyage", error);
      }
      state.socket = null;
    }
    window.removeEventListener("beforeunload", cleanup);
  };

  window.addEventListener("beforeunload", cleanup);

  const initialWindowSeconds = parseNumber(
    card.getAttribute("data-live-window-seconds"),
    120,
  );
  card.setAttribute("data-live-window-seconds", initialWindowSeconds);
  updateWindowLabel(initialWindowSeconds);
  updateStatus(null);
  updateVisibility(state.totalItems > 0);
  applyPagination({
    page: state.page,
    perPage: state.perPage,
    totalPages: state.totalPages,
    totalItems: state.totalItems,
    hasPrevious: state.page > 1,
    hasNext: state.page < state.totalPages,
  });

  connect();
  restartTimer();
}
function initAmbientBackdrop() {
  const scene = document.querySelector(".theme-liquid .background-scene");
  if (!scene) {
    return;
  }

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (motionQuery.matches) {
    return;
  }

  let frame = null;

  const update = (x, y) => {
    scene.style.setProperty("--pointer-x", `${x}px`);
    scene.style.setProperty("--pointer-y", `${y}px`);
  };

  const scheduleUpdate = (x, y) => {
    if (typeof x !== "number" || typeof y !== "number") {
      return;
    }
    if (frame) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      update(x, y);
      frame = null;
    });
  };

  const initialX = window.innerWidth / 2;
  const initialY = window.innerHeight / 2;
  scheduleUpdate(initialX, initialY);

  const handlePointerMove = (event) => {
    scheduleUpdate(event.clientX, event.clientY);
  };

  const handleTouchMove = (event) => {
    const touch = event.touches?.[0];
    if (!touch) {
      return;
    }
    scheduleUpdate(touch.clientX, touch.clientY);
  };

  const resetPosition = () => {
    scheduleUpdate(window.innerWidth / 2, window.innerHeight / 2);
  };

  const attachListeners = () => {
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("pointerleave", resetPosition, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("resize", resetPosition);
  };

  const detachListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerleave", resetPosition);
    window.removeEventListener("touchmove", handleTouchMove);
    window.removeEventListener("resize", resetPosition);
  };

  attachListeners();

  const handlePreferenceChange = (event) => {
    if (event.matches) {
      detachListeners();
      if (frame) {
        cancelAnimationFrame(frame);
      }
      scene.style.removeProperty("--pointer-x");
      scene.style.removeProperty("--pointer-y");
    } else {
      resetPosition();
      attachListeners();
    }
  };

  if (typeof motionQuery.addEventListener === "function") {
    motionQuery.addEventListener("change", handlePreferenceChange);
  } else if (typeof motionQuery.addListener === "function") {
    motionQuery.addListener(handlePreferenceChange);
  }
}

async function handleLikeSubmit(event, form) {
  const submitter =
    event.submitter || form.querySelector('button[type="submit"]');
  if (submitter) {
    submitter.disabled = true;
    submitter.classList.add("is-loading");
  }

  try {
    const response = await fetch(form.action, {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
      body: new FormData(form),
    });

    const contentType = response.headers.get("content-type") || "";
    const expectJson = contentType.includes("application/json");
    const data = expectJson ? await response.json() : null;

    if (!response.ok || data?.ok === false) {
      const message =
        data?.message || "Impossible de mettre à jour vos favoris.";
      const error = new Error(message);
      if (Array.isArray(data?.notifications) && data.notifications.length) {
        error.notifications = data.notifications;
      }
      if (data?.redirect) {
        error.redirect = data.redirect;
      }
      throw error;
    }

    if (!data || typeof data.likes === "undefined") {
      throw new Error("Réponse inattendue du serveur.");
    }

    updateLikeUi(data.slug || form.dataset.likeFormFor, {
      liked: Boolean(data.liked),
      likes: Number(data.likes),
    });

    notifyClient(data.notifications);
  } catch (err) {
    const notifications =
      Array.isArray(err.notifications) && err.notifications.length
        ? err.notifications
        : [
            {
              type: "error",
              message: err.message || "Une erreur est survenue.",
              timeout: 4000,
            },
          ];
    notifyClient(notifications);
    if (err.redirect) {
      setTimeout(() => {
        window.location.href = err.redirect;
      }, 150);
    }
  } finally {
    if (submitter) {
      submitter.disabled = false;
      submitter.classList.remove("is-loading");
    }
  }
}

function notifyClient(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  const layer = document.getElementById("notificationLayer");
  if (!layer) {
    return;
  }

  notifications.forEach((notif, index) => {
    setTimeout(() => {
      spawnNotification(layer, notif);
    }, index * 80);
  });
}

function updateLikeUi(slug, state) {
  if (!slug) {
    return;
  }

  const likes = Number.isFinite(state.likes) ? state.likes : 0;
  const liked = Boolean(state.liked);

  document
    .querySelectorAll(`[data-like-count-for="${CSS.escape(slug)}"]`)
    .forEach((el) => {
      el.textContent = likes;
    });

  document
    .querySelectorAll(`form[data-like-form-for="${CSS.escape(slug)}"]`)
    .forEach((likeForm) => {
      likeForm.dataset.userLiked = liked ? "true" : "false";
      const button = likeForm.querySelector('button[type="submit"]');
      if (!button) {
        return;
      }

      const icon = liked ? "💔" : "💖";
      button.dataset.icon = icon;
      button.classList.toggle("like", !liked);
      button.classList.toggle("unlike", liked);

      const labelLiked = button.dataset.labelLiked || "Retirer";
      const labelUnliked = button.dataset.labelUnliked || "Like";
      const label = liked ? labelLiked : labelUnliked;
      const textContent = `${label} (${likes})`;

      let textNode = Array.from(button.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE,
      );
      if (!textNode) {
        textNode = document.createTextNode("");
        button.appendChild(textNode);
      }
      textNode.textContent = textContent;

      const iconSpan = button.querySelector(".btn-icon");
      if (iconSpan) {
        iconSpan.textContent = icon;
      } else {
        enhanceIconButtons();
      }
    });
}

function getNotificationIcon(type) {
  switch (type) {
    case "success":
      return "✅";
    case "error":
      return "⚠️";
    default:
      return "ℹ️";
  }
}

function getNotificationTitle(type) {
  switch (type) {
    case "success":
      return "Succès";
    case "error":
      return "Erreur";
    default:
      return "Information";
  }
}

let mermaidSetupDone = false;

function initMarkdownEditor() {
  const container = document.querySelector("[data-markdown-editor]");
  if (!container) return;

  const targetSelector = container.getAttribute("data-target");
  const field = targetSelector ? document.querySelector(targetSelector) : null;
  if (!field) return;

  const input = container.querySelector("[data-editor-input]");
  const preview = container.querySelector("[data-editor-preview]");
  const statusElement =
    container.querySelector("[data-editor-status]") ||
    container.parentElement?.querySelector("[data-editor-status]");
  const suggestionsBox = container.querySelector("[data-link-suggestions]");
  const toolbarButtons = Array.from(
    container.querySelectorAll("[data-md-action]")
  );
  const emojiTrigger = container.querySelector("[data-emoji-trigger]");
  const emojiPanel = container.querySelector("[data-emoji-picker]");

  if (!input) {
    field.hidden = false;
    field.removeAttribute("hidden");
    return;
  }

  const renderer = createMarkdownRenderer();
  input.value = field.value || field.textContent || "";
  field.value = input.value;

  let renderFrame = null;
  let suggestionRequestToken = 0;
  let suggestionAbortController = null;
  const suggestionState = {
    items: [],
    activeIndex: -1,
    anchor: null,
    query: "",
  };

  if (suggestionsBox) {
    suggestionsBox.hidden = true;
    if (!suggestionsBox.id) {
      suggestionsBox.id = `link-suggestions-${Math.random()
        .toString(36)
        .slice(2)}`;
    }
    input.setAttribute("aria-controls", suggestionsBox.id);
    suggestionsBox.setAttribute("role", "listbox");
  }

  const numberFormatter =
    typeof Intl !== "undefined" && Intl.NumberFormat
      ? new Intl.NumberFormat("fr-FR")
      : null;

  const EMOJI_SET = [
    "😀",
    "😁",
    "😂",
    "🤣",
    "😃",
    "😄",
    "😅",
    "😆",
    "😉",
    "😊",
    "😋",
    "😍",
    "😘",
    "😗",
    "🤗",
    "🤔",
    "🤨",
    "😐",
    "😑",
    "😶",
    "🙄",
    "😏",
    "😣",
    "😥",
    "😮",
    "🤐",
    "😯",
    "😪",
    "😴",
    "😌",
    "😛",
    "😜",
    "😝",
    "🤤",
    "😒",
    "😓",
    "😔",
    "😕",
    "🙃",
    "🤑",
    "😲",
    "☹️",
    "🙁",
    "😖",
    "😞",
    "😟",
    "😤",
    "😢",
    "😭",
    "😦",
    "😧",
    "😨",
    "😩",
    "🤯",
    "😬",
    "😰",
    "😱",
    "🥵",
    "🥶",
    "😳",
    "🤪",
    "😵",
    "🥴",
    "😠",
    "😡",
    "🤬",
    "😷",
    "🤒",
    "🤕",
    "🤢",
    "🤮",
    "🤧",
    "😇",
    "🥳",
    "🥰",
    "🤠",
    "🤡",
    "🤥",
    "🧐",
    "🤓",
    "😈",
    "👻",
    "💀",
    "🤖",
    "🎃",
    "😺",
    "😸",
    "😹",
    "😻",
    "😼",
    "😽",
    "🙀",
    "😿",
    "😾",
    "👍",
    "👎",
    "🙏",
    "👏",
    "🙌",
    "🤝",
    "💪",
    "🧠",
    "🔥",
    "✨",
    "🌟",
    "⚡",
    "🎯",
    "✅",
    "❗",
  ];

  if (emojiPanel) {
    emojiPanel.innerHTML = "";
    emojiPanel.setAttribute("role", "menu");
    const fragment = document.createDocumentFragment();
    EMOJI_SET.forEach((emoji) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-option";
      button.setAttribute("data-emoji", emoji);
      button.textContent = emoji;
      fragment.appendChild(button);
    });
    emojiPanel.appendChild(fragment);
    emojiPanel.hidden = true;
  }

  function syncField() {
    field.value = input.value;
  }

  function updateStatus() {
    if (!statusElement) return;
    const rawText = (input.value || "").replace(/\r/g, "");
    const trimmed = rawText.trim();
    const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    const characterCount = rawText ? rawText.replace(/\n/g, "").length : 0;
    const formatCount = (count, singular, plural = `${singular}s`) => {
      const formatted = numberFormatter
        ? numberFormatter.format(count)
        : String(count);
      const label = count === 1 ? singular : plural;
      return `${formatted} ${label}`;
    };
    const parts = [
      formatCount(wordCount, "mot"),
      formatCount(characterCount, "caractère", "caractères"),
    ];
    if (wordCount) {
      const readingMinutes = Math.max(1, Math.ceil(wordCount / 200));
      const formatted = numberFormatter
        ? numberFormatter.format(readingMinutes)
        : String(readingMinutes);
      parts.push(`~${formatted} min de lecture`);
    }
    statusElement.textContent = parts.join(" • ");
  }

  function scheduleRender() {
    if (!preview) {
      return;
    }
    if (!renderer) {
      preview.textContent = input.value || "";
      return;
    }
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
    }
    renderFrame = requestAnimationFrame(async () => {
      renderFrame = null;
      let rendered = "";
      try {
        rendered = renderer.render(input.value || "");
      } catch (error) {
        console.warn("Échec du rendu Markdown", error);
        rendered = `<pre class="markdown-error">${escapeHtml(
          input.value || ""
        )}</pre>`;
      }
      preview.innerHTML = rendered;
      highlightCodeBlocks(preview);
      await renderMermaidDiagrams(preview);
    });
  }

  function handleValueChange() {
    syncField();
    updateStatus();
    scheduleRender();
    evaluateSuggestions();
  }

  function getSelection() {
    return {
      start: input.selectionStart || 0,
      end: input.selectionEnd || 0,
    };
  }

  function wrapSelection(prefix, suffix, placeholder = "") {
    const { start, end } = getSelection();
    const value = input.value;
    const selected = value.slice(start, end);
    const insertion = `${prefix}${selected || placeholder}${suffix}`;
    const before = value.slice(0, start);
    const after = value.slice(end);
    input.value = before + insertion + after;
    const focusStart = before.length + prefix.length;
    const focusEnd = focusStart + (selected || placeholder).length;
    if (!selected && placeholder) {
      input.setSelectionRange(focusStart, focusEnd);
    } else {
      input.setSelectionRange(focusEnd, focusEnd);
    }
    handleValueChange();
  }

  function insertTextAtCursor(text, { select = false } = {}) {
    const { start, end } = getSelection();
    const value = input.value;
    const before = value.slice(0, start);
    const after = value.slice(end);
    input.value = before + text + after;
    const caretPosition = before.length + text.length;
    if (select) {
      input.setSelectionRange(before.length, caretPosition);
    } else {
      input.setSelectionRange(caretPosition, caretPosition);
    }
    handleValueChange();
  }

  function insertMultilineBlock(opening, placeholder, closing) {
    const { start, end } = getSelection();
    const value = input.value;
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const content = selected || placeholder;
    const needsLeadingNewline = before && !before.endsWith("\n") ? "\n" : "";
    const needsTrailingNewline =
      after && !after.startsWith("\n") ? "\n" : "";
    const block = `${needsLeadingNewline}${opening}\n${content}\n${closing}${needsTrailingNewline}`;
    input.value = before + block + after;
    const selectionStart =
      before.length +
      needsLeadingNewline.length +
      opening.length +
      1;
    const selectionEnd = selectionStart + content.length;
    if (!selected) {
      input.setSelectionRange(selectionStart, selectionEnd);
    } else {
      const newCaret = selectionEnd + 1;
      input.setSelectionRange(newCaret, newCaret);
    }
    handleValueChange();
  }

  function applyToolbarAction(action) {
    switch (action) {
      case "bold":
        wrapSelection("**", "**", "texte en gras");
        break;
      case "italic":
        wrapSelection("*", "*", "texte en italique");
        break;
      case "code":
        wrapSelection("`", "`", "code");
        break;
      case "strike":
        wrapSelection("~~", "~~", "texte barré");
        break;
      case "heading-2": {
        const { start, end } = getSelection();
        const value = input.value;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const selected = value.slice(start, end) || "Titre";
        const prefix = before && !before.endsWith("\n") ? "\n" : "";
        const insertion = `${prefix}## ${selected}\n`;
        input.value = before + insertion + after;
        const caretStart = before.length + prefix.length + 3;
        const caretEnd = caretStart + selected.length;
        if (!value.slice(start, end)) {
          input.setSelectionRange(caretStart, caretEnd);
        } else {
          input.setSelectionRange(caretEnd + 1, caretEnd + 1);
        }
        handleValueChange();
        break;
      }
      case "heading-3": {
        const { start, end } = getSelection();
        const value = input.value;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const selected = value.slice(start, end) || "Sous-titre";
        const prefix = before && !before.endsWith("\n") ? "\n" : "";
        const insertion = `${prefix}### ${selected}\n`;
        input.value = before + insertion + after;
        const caretStart = before.length + prefix.length + 4;
        const caretEnd = caretStart + selected.length;
        if (!value.slice(start, end)) {
          input.setSelectionRange(caretStart, caretEnd);
        } else {
          input.setSelectionRange(caretEnd + 1, caretEnd + 1);
        }
        handleValueChange();
        break;
      }
      case "quote": {
        const { start, end } = getSelection();
        const value = input.value;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const selected = value.slice(start, end);
        const lines = selected ? selected.split(/\r?\n/) : [""];
        const formatted = lines
          .map((line) => (line ? `> ${line}` : "> "))
          .join("\n");
        input.value = before + formatted + after;
        const caret = before.length + formatted.length;
        input.setSelectionRange(caret, caret);
        handleValueChange();
        break;
      }
      case "link": {
        const { start, end } = getSelection();
        const value = input.value;
        const selected = value.slice(start, end);
        const url = window.prompt("Entrez l'URL du lien :", "https://");
        if (!url) {
          return;
        }
        const label = selected || "Texte du lien";
        const snippet = `[${label}](${url.trim()})`;
        const before = value.slice(0, start);
        const after = value.slice(end);
        input.value = before + snippet + after;
        if (!selected) {
          const caretStart = before.length + 1;
          const caretEnd = caretStart + label.length;
          input.setSelectionRange(caretStart, caretEnd);
        } else {
          const caret = before.length + snippet.length;
          input.setSelectionRange(caret, caret);
        }
        handleValueChange();
        break;
      }
      case "code-block":
        insertMultilineBlock("```", "code", "```");
        break;
      case "spoiler":
        insertMultilineBlock(
          "::: spoiler Titre du spoiler",
          "Contenu du spoiler",
          ":::"
        );
        break;
      case "katex":
        insertMultilineBlock("$$", "c^2 = a^2 + b^2", "$$");
        break;
      case "mermaid":
        insertMultilineBlock("```mermaid", "graph TD;\n  A --> B;", "```");
        break;
      default:
        break;
    }
  }

  function openEmojiPanel() {
    if (!emojiPanel || !emojiTrigger) return;
    emojiPanel.hidden = false;
    emojiTrigger.setAttribute("aria-expanded", "true");
  }

  function closeEmojiPanel() {
    if (!emojiPanel || !emojiTrigger) return;
    emojiPanel.hidden = true;
    emojiTrigger.setAttribute("aria-expanded", "false");
  }

  function toggleEmojiPanel() {
    if (!emojiPanel) return;
    if (emojiPanel.hidden) {
      openEmojiPanel();
    } else {
      closeEmojiPanel();
    }
  }

  function evaluateSuggestions() {
    if (!suggestionsBox) return;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    if (selectionStart == null || selectionEnd == null) {
      hideSuggestions();
      return;
    }
    if (selectionStart !== selectionEnd) {
      hideSuggestions();
      return;
    }
    const before = input.value.slice(0, selectionStart);
    const match = before.match(/:\[\[([^\]\n\r]{0,80})$/);
    if (!match) {
      hideSuggestions();
      return;
    }
    const query = match[1].trim();
    suggestionState.anchor = {
      start: selectionStart - match[0].length,
      end: selectionStart,
    };
    suggestionState.query = query;
    if (!query) {
      hideSuggestions();
      return;
    }
    const requestToken = ++suggestionRequestToken;
    if (suggestionAbortController) {
      suggestionAbortController.abort();
    }
    suggestionAbortController = new AbortController();
    fetch(`/api/pages/suggest?q=${encodeURIComponent(query)}`, {
      signal: suggestionAbortController.signal,
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (requestToken !== suggestionRequestToken) {
          return;
        }
        const items = Array.isArray(data?.results) ? data.results : [];
        showSuggestions(items);
      })
      .catch((error) => {
        if (error.name === "AbortError") {
          return;
        }
        if (requestToken === suggestionRequestToken) {
          hideSuggestions();
        }
      })
      .finally(() => {
        if (requestToken === suggestionRequestToken) {
          suggestionAbortController = null;
        }
      });
  }

  function showSuggestions(items) {
    if (!suggestionsBox) return;
    suggestionState.items = items;
    suggestionState.activeIndex = items.length ? 0 : -1;
    suggestionsBox.innerHTML = "";
    if (!items.length) {
      suggestionsBox.hidden = true;
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "link-suggestion";
      option.setAttribute("data-index", String(index));
      option.setAttribute("role", "option");
      option.innerHTML = `<strong>${escapeHtml(
        item.title || ""
      )}</strong><span>${escapeHtml(item.slug || "")}</span>`;
      fragment.appendChild(option);
    });
    suggestionsBox.appendChild(fragment);
    suggestionsBox.hidden = false;
    updateSuggestionHighlight();
  }

  function hideSuggestions() {
    if (!suggestionsBox) return;
    if (suggestionAbortController) {
      suggestionAbortController.abort();
      suggestionAbortController = null;
    }
    suggestionsBox.hidden = true;
    suggestionsBox.innerHTML = "";
    suggestionState.items = [];
    suggestionState.activeIndex = -1;
    suggestionState.anchor = null;
  }

  function updateSuggestionHighlight() {
    if (!suggestionsBox) return;
    suggestionsBox
      .querySelectorAll("[data-index]")
      .forEach((element) => {
        const index = Number(element.getAttribute("data-index"));
        const active = index === suggestionState.activeIndex;
        element.classList.toggle("is-active", active);
        element.setAttribute("aria-selected", active ? "true" : "false");
      });
  }

  function focusSuggestion(offset) {
    if (!suggestionState.items.length) return;
    const total = suggestionState.items.length;
    suggestionState.activeIndex =
      (suggestionState.activeIndex + offset + total) % total;
    updateSuggestionHighlight();
  }

  function applySuggestionByIndex(index) {
    if (!suggestionState.anchor) return;
    const item = suggestionState.items[index];
    if (!item) return;
    const start = suggestionState.anchor.start;
    const end = input.selectionStart;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const replacement = `:[[${item.title}]]`;
    input.value = before + replacement + after;
    const caret = before.length + replacement.length;
    input.setSelectionRange(caret, caret);
    handleValueChange();
    hideSuggestions();
  }

  function handleSuggestionKeydown(event) {
    if (!suggestionsBox || suggestionsBox.hidden) {
      if (event.key === "Escape") {
        closeEmojiPanel();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusSuggestion(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusSuggestion(-1);
        break;
      case "Enter":
      case "Tab":
        event.preventDefault();
        applySuggestionByIndex(suggestionState.activeIndex);
        break;
      case "Escape":
        hideSuggestions();
        break;
      default:
        break;
    }
  }

  if (toolbarButtons.length) {
    toolbarButtons.forEach((button) => {
      const action = button.getAttribute("data-md-action");
      if (!action) return;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        applyToolbarAction(action);
        closeEmojiPanel();
      });
    });
  }

  if (emojiTrigger && emojiPanel) {
    emojiTrigger.setAttribute("aria-haspopup", "true");
    emojiTrigger.setAttribute("aria-expanded", "false");
    emojiTrigger.addEventListener("click", (event) => {
      event.preventDefault();
      toggleEmojiPanel();
    });
    emojiPanel.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    emojiPanel.addEventListener("click", (event) => {
      const target = event.target.closest("[data-emoji]");
      if (!target) return;
      event.preventDefault();
      const emoji = target.getAttribute("data-emoji");
      if (emoji) {
        insertTextAtCursor(`${emoji} `);
      }
      closeEmojiPanel();
    });
    document.addEventListener("click", (event) => {
      if (!emojiPanel || emojiPanel.hidden) return;
      if (
        event.target === emojiPanel ||
        event.target === emojiTrigger ||
        emojiPanel.contains(event.target)
      ) {
        return;
      }
      closeEmojiPanel();
    });
  }

  if (suggestionsBox) {
    suggestionsBox.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    suggestionsBox.addEventListener("click", (event) => {
      const target = event.target.closest("[data-index]");
      if (!target) return;
      event.preventDefault();
      const index = Number(target.getAttribute("data-index"));
      applySuggestionByIndex(index);
    });
  }

  input.addEventListener("input", handleValueChange);
  input.addEventListener("keydown", handleSuggestionKeydown);
  input.addEventListener("click", () => {
    evaluateSuggestions();
    closeEmojiPanel();
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      hideSuggestions();
      closeEmojiPanel();
    }, 120);
  });

  handleValueChange();
  scheduleRender();
}

function createMarkdownRenderer() {
  if (!window.markdownit) {
    return null;
  }
  const md = window.markdownit({
    html: true,
    linkify: true,
    breaks: true,
    highlight: (code, lang) => {
      if (window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) {
            return window.hljs.highlight(code, {
              language: lang,
              ignoreIllegals: true,
            }).value;
          }
          const result = window.hljs.highlightAuto(code);
          return result.value;
        } catch (error) {
          console.warn("Échec de la coloration du code", error);
        }
      }
      return escapeHtml(code);
    },
  });

  if (window.markdownitEmoji) {
    md.use(window.markdownitEmoji);
  }
  if (window.markdownitContainer) {
    md.use(window.markdownitContainer, "spoiler", {
      validate: (params) => /^spoiler(\s+.*)?$/i.test(params.trim()),
      render: (tokens, idx) => {
        const match = tokens[idx].info.trim().match(/^spoiler\s*(.*)$/i);
        if (tokens[idx].nesting === 1) {
          const title = match && match[1] ? match[1].trim() : "Spoiler";
          return `<details class="md-spoiler"><summary>${escapeHtml(
            title || "Spoiler"
          )}</summary>\n<div class="md-spoiler-body">\n`;
        }
        return "</div></details>\n";
      },
    });
  }
  if (window.markdownitKatex && window.katex) {
    md.use(window.markdownitKatex);
  }

  md.core.ruler.after("inline", "wiki-links", (state) => {
    const Token = state.Token;
    state.tokens.forEach((blockToken) => {
      if (blockToken.type !== "inline" || !blockToken.children) {
        return;
      }
      const children = [];
      blockToken.children.forEach((child) => {
        if (child.type !== "text" || !child.content.includes("[[")) {
          children.push(child);
          return;
        }
        const text = child.content;
        const regex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
        let lastIndex = 0;
        let match;
        let matched = false;
        while ((match = regex.exec(text))) {
          matched = true;
          if (match.index > lastIndex) {
            const textToken = new Token("text", "", 0);
            textToken.content = text.slice(lastIndex, match.index);
            children.push(textToken);
          }
          const target = match[1] ? match[1].trim() : "";
          if (!target) {
            const textToken = new Token("text", "", 0);
            textToken.content = match[0];
            children.push(textToken);
            lastIndex = regex.lastIndex;
            continue;
          }
          const label = match[2] ? match[2].trim() : target;
          const open = new Token("link_open", "a", 1);
          open.attrs = [
            ["href", `/lookup/${slugifyForLink(target)}`],
            ["class", "wiki-link"],
            ["target", "_blank"],
            ["rel", "noopener"],
          ];
          const textToken = new Token("text", "", 0);
          textToken.content = label;
          const close = new Token("link_close", "a", -1);
          children.push(open, textToken, close);
          lastIndex = regex.lastIndex;
        }
        if (!matched) {
          children.push(child);
        } else if (lastIndex < text.length) {
          const textToken = new Token("text", "", 0);
          textToken.content = text.slice(lastIndex);
          children.push(textToken);
        }
      });
      blockToken.children = children;
    });
  });

  return md;
}

function slugifyForLink(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function escapeHtml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function renderMermaidDiagrams(root) {
  if (!window.mermaid || !root) {
    return;
  }
  ensureMermaidReady();
  const blocks = root.querySelectorAll(
    "pre code.language-mermaid, pre code.lang-mermaid"
  );
  if (!blocks.length) {
    return;
  }
  let index = 0;
  for (const code of Array.from(blocks)) {
    const pre = code.closest("pre");
    if (!pre) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "mermaid-diagram";
    const graphDefinition = code.textContent || "";
    const id = `mermaid-${Date.now()}-${index++}`;
    try {
      const result = await window.mermaid.render(id, graphDefinition);
      wrapper.innerHTML = result.svg || result;
    } catch (error) {
      console.warn("Échec du rendu Mermaid", error);
      const fallback = document.createElement("pre");
      fallback.className = "mermaid-error";
      const fallbackCode = document.createElement("code");
      fallbackCode.textContent = graphDefinition;
      fallback.appendChild(fallbackCode);
      wrapper.appendChild(fallback);
    }
    pre.replaceWith(wrapper);
  }
}

function ensureMermaidReady() {
  if (!window.mermaid || mermaidSetupDone) {
    return;
  }
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "default",
    });
    mermaidSetupDone = true;
  } catch (error) {
    console.warn("Impossible d'initialiser Mermaid", error);
  }
}

function highlightCodeBlocks(root = document) {
  if (!window.hljs || !root) return;
  if (typeof window.hljs.configure === "function") {
    window.hljs.configure({ ignoreUnescapedHTML: true });
  }
  const codes = root.querySelectorAll("pre code");
  codes.forEach((code) => {
    if (code.dataset.highlighted === "true") return;
    try {
      window.hljs.highlightElement(code);
      code.dataset.highlighted = "true";
      const pre = code.closest("pre");
      if (pre) {
        pre.classList.add("hljs");
      }
    } catch (error) {
      console.warn("Impossible de colorer un bloc de code", error);
    }
  });
}

function initCodeHighlighting() {
  highlightCodeBlocks(document);
  const mermaidResult = renderMermaidDiagrams(document);
  if (mermaidResult && typeof mermaidResult.catch === "function") {
    mermaidResult.catch((error) => {
      console.warn("Échec du rendu Mermaid pour la page", error);
    });
  }
}
