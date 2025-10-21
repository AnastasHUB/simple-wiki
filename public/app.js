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
    const rect = drawer.getBoundingClientRect();
    const overlayLeft = Math.min(
      window.innerWidth,
      Math.max(0, rect.left + rect.width),
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

  let mq = null;
  if (typeof window.matchMedia === "function") {
    mq = window.matchMedia("(min-width: 1025px)");
  }

  if (mq?.addEventListener) {
    mq.addEventListener("change", (event) => {
      if (event.matches) {
        closeDrawer();
      }
    });
  } else if (mq?.addListener) {
    // Safari < 14
    mq.addListener((event) => {
      if (event.matches) {
        closeDrawer();
      }
    });
  }
})();

let cachedCsrfToken = null;

function getCsrfToken() {
  if (cachedCsrfToken !== null) {
    return cachedCsrfToken;
  }
  const meta = document.querySelector('meta[name="csrf-token"]');
  cachedCsrfToken = meta ? meta.getAttribute("content") || "" : "";
  return cachedCsrfToken;
}

function initCsrfProtection() {
  const token = getCsrfToken();
  if (!token) {
    return;
  }

  const ensureTokenField = (form) => {
    let input = form.querySelector('input[name="_csrf"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "_csrf";
      form.appendChild(input);
    }
    input.value = token;
  };

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }
      const method = (form.getAttribute("method") || "get").toUpperCase();
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        return;
      }
      ensureTokenField(form);
    },
    true,
  );
}

function applyCsrfHeader(headers = {}) {
  const token = getCsrfToken();
  if (token) {
    headers["X-CSRF-Token"] = token;
  }
  return headers;
}

function initCookieBanner() {
  const banner = document.querySelector("[data-cookie-banner]");
  if (!banner) {
    return;
  }

  const acceptButton = banner.querySelector("[data-cookie-accept]");
  if (!acceptButton) {
    return;
  }

  let isSubmitting = false;

  const hideBanner = () => {
    banner.classList.add("cookie-banner--hidden");
    window.setTimeout(() => {
      if (banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
    }, 240);
  };

  acceptButton.addEventListener("click", async (event) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    isSubmitting = true;
    acceptButton.disabled = true;
    banner.classList.add("cookie-banner--loading");

    try {
      const response = await fetch("/cookies/consent", {
        method: "POST",
        headers: applyCsrfHeader({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({ consent: "accepted" }),
      });

      if (!response.ok) {
        throw new Error(`Réponse ${response.status}`);
      }

      hideBanner();
    } catch (err) {
      console.error("Enregistrement du consentement aux cookies impossible", err);
      acceptButton.disabled = false;
      banner.classList.remove("cookie-banner--loading");
      isSubmitting = false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initCsrfProtection();
  initAmbientBackdrop();
  initNotifications();
  enhanceIconButtons();
  initLikeForms();
  initReactionForms();
  initReactionWebsocket();
  initMarkdownEditor();
  initCodeHighlighting();
  initSearchFilters();
  initLiveStatsCard();
  initIpLinkForm();
  initIpClaimForm();
  initCookieBanner();
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

function initSearchFilters() {
  const form = document.querySelector("[data-search-filters]");
  if (!form) {
    return;
  }

  const requestSubmit = () => {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  };

  form.querySelectorAll("[data-auto-submit]").forEach((element) => {
    element.addEventListener("change", () => {
      requestSubmit();
    });
  });

  const tagSelect = form.querySelector("[data-filter-tags]");
  form.querySelectorAll("[data-remove-tag]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const value = button.getAttribute("data-remove-tag");
      if (!value) {
        requestSubmit();
        return;
      }

      let removed = false;
      if (tagSelect) {
        Array.from(tagSelect.options).forEach((option) => {
          if (option.value === value) {
            option.selected = false;
            removed = true;
          }
        });
      }

      if (!removed) {
        Array.from(form.elements).forEach((element) => {
          if (element instanceof HTMLInputElement && element.name === "tag") {
            if (element.value === value) {
              element.remove();
            }
          }
        });
      }

      requestSubmit();
    });
  });

  const clearButton = form.querySelector("[data-clear-filters]");
  if (clearButton) {
    clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      const resetUrl = clearButton.getAttribute("data-reset-url");
      if (resetUrl) {
        window.location.href = resetUrl;
        return;
      }

      const preserved = new Set(["q"]);
      Array.from(form.elements).forEach((element) => {
        if (!element.name || preserved.has(element.name)) {
          return;
        }
        if (!element.matches("[data-filter-field]")) {
          return;
        }
        if (element instanceof HTMLSelectElement) {
          Array.from(element.options).forEach((option) => {
            option.selected = false;
          });
          element.selectedIndex = -1;
        } else if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox" || element.type === "radio") {
            element.checked = false;
          } else {
            element.value = "";
          }
        } else {
          element.value = "";
        }
      });

      requestSubmit();
    });
  }
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

function initReactionForms() {
  const forms = document.querySelectorAll("form[data-reaction-form]");
  if (!forms.length) {
    return;
  }

  forms.forEach((form) => {
    if (form.dataset.reactionBound === "true") {
      return;
    }

    form.dataset.reactionBound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      handleReactionSubmit(event, form);
    });
  });
}

function initReactionWebsocket() {
  if (typeof window.WebSocket !== "function") {
    return;
  }

  const reactionForms = document.querySelectorAll("form[data-reaction-form]");
  const likeForms = document.querySelectorAll("form[data-like-form-for]");
  if (!reactionForms.length && !likeForms.length) {
    return;
  }

  const MAX_PAGE_SUBSCRIPTIONS = 8;
  const MAX_COMMENT_SUBSCRIPTIONS = 400;

  const pageSlugs = new Set();
  const commentIds = new Set();

  reactionForms.forEach((form) => {
    const target = form.getAttribute("data-reaction-target");
    if (target === "page") {
      const slug = form.getAttribute("data-reaction-slug");
      if (slug && pageSlugs.size < MAX_PAGE_SUBSCRIPTIONS) {
        pageSlugs.add(slug);
      }
    } else if (target === "comment") {
      const commentId = form.getAttribute("data-comment-id");
      if (commentId && commentIds.size < MAX_COMMENT_SUBSCRIPTIONS) {
        commentIds.add(commentId);
      }
    }
  });

  likeForms.forEach((form) => {
    const slug = form.getAttribute("data-like-form-for");
    if (slug && pageSlugs.size < MAX_PAGE_SUBSCRIPTIONS) {
      pageSlugs.add(slug);
    }
  });

  if (!pageSlugs.size && !commentIds.size) {
    return;
  }

  const state = {
    socket: null,
    reconnectDelay: 1000,
    reconnectTimer: null,
  };

  const pages = Array.from(pageSlugs);
  const comments = Array.from(commentIds);

  function buildSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.host;
    const params = new URLSearchParams();
    pages.forEach((slug) => {
      params.append("page", slug);
    });
    comments.forEach((id) => {
      params.append("comment", id);
    });
    const query = params.toString();
    return `${protocol}://${host}/ws/reactions${query ? `?${query}` : ""}`;
  }

  function scheduleReconnect() {
    if (state.reconnectTimer !== null) {
      return;
    }
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (state.reconnectTimer !== null) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    let socket;
    try {
      socket = new WebSocket(buildSocketUrl());
    } catch (error) {
      console.warn("Impossible d'ouvrir la connexion WebSocket des réactions", error);
      scheduleReconnect();
      return;
    }

    state.socket = socket;

    socket.addEventListener("open", () => {
      state.reconnectDelay = 1000;
      try {
        socket.send(
          JSON.stringify({
            type: "setSubscriptions",
            pages,
            comments,
          }),
        );
      } catch (error) {
        console.warn("Impossible d'envoyer les abonnements de réactions", error);
      }
    });

    socket.addEventListener("message", (event) => {
      if (!event.data) {
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") {
        return;
      }
      switch (message.type) {
        case "reactionUpdate":
          if (message.payload) {
            updateReactionUi(message.payload);
          }
          break;
        case "likeUpdate":
          if (message.payload?.slug) {
            updateLikeUi(message.payload.slug, message.payload);
          }
          break;
        case "error":
          if (message.message) {
            console.warn("Erreur du socket de réactions :", message.message);
          }
          break;
        default:
          break;
      }
    });

    const handleClose = () => {
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      if (state.socket === socket) {
        state.socket = null;
      }
      scheduleReconnect();
    };

    const handleError = () => {
      try {
        socket.close();
      } catch {
        // ignore closing errors
      }
    };

    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
  }

  connect();
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

function initIpClaimForm() {
  const form = document.getElementById("ipClaimForm");
  if (!form || form.dataset.claimFormBound === "true") {
    return;
  }
  form.dataset.claimFormBound = "true";
  const submitButton = form.querySelector("#ipClaimSubmit");
  form.addEventListener("submit", () => {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.setAttribute("aria-busy", "true");
      if (!submitButton.dataset.originalLabel) {
        submitButton.dataset.originalLabel = submitButton.textContent || "";
      }
      submitButton.textContent = "Conversion en cours…";
    }
  });
}

function initIpLinkForm() {
  const form = document.getElementById("ipLinkForm");
  if (!form || form.dataset.linkFormBound === "true") {
    return;
  }
  form.dataset.linkFormBound = "true";
  const submitButton = form.querySelector("#ipLinkSubmit");
  form.addEventListener("submit", () => {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.setAttribute("aria-busy", "true");
      if (!submitButton.dataset.originalLabel) {
        submitButton.dataset.originalLabel = submitButton.textContent || "";
      }
      submitButton.textContent = "Association en cours…";
    }
  });
}
function initAmbientBackdrop() {
  const scene = document.querySelector(".theme-liquid .background-scene");
  if (!scene) {
    return;
  }

  if (typeof window.matchMedia !== "function") {
    return;
  }

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!motionQuery || motionQuery.matches) {
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
      headers: applyCsrfHeader({
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      }),
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

async function handleReactionSubmit(event, form) {
  const submitter = event.submitter || form.querySelector("[data-reaction-option]");
  if (submitter) {
    submitter.disabled = true;
    submitter.classList.add("is-loading");
  }

  try {
    const formData = new FormData(form);
    const reactionKey = submitter?.getAttribute("data-reaction-key");
    if (submitter?.name) {
      formData.set(submitter.name, submitter.value);
    } else if (reactionKey) {
      formData.set("reaction", reactionKey);
    }

    const payload = new URLSearchParams();
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        payload.append(key, value);
      }
    });

    const response = await fetch(form.action, {
      method: "POST",
      headers: applyCsrfHeader({
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      }),
      body: payload,
    });

    const contentType = response.headers.get("content-type") || "";
    const expectJson = contentType.includes("application/json");
    const data = expectJson ? await response.json() : null;

    if (!response.ok || data?.ok === false) {
      const message = data?.message || "Impossible de mettre à jour la réaction.";
      const error = new Error(message);
      if (Array.isArray(data?.notifications) && data.notifications.length) {
        error.notifications = data.notifications;
      }
      if (data?.redirect) {
        error.redirect = data.redirect;
      }
      throw error;
    }

    if (!data || !Array.isArray(data.reactions)) {
      if (!expectJson) {
        window.location.reload();
        return;
      }
      throw new Error("Réponse inattendue du serveur.");
    }

    updateReactionUi(data);
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
  if (!slug || !state) {
    return;
  }

  const likes = Number.isFinite(state.likes) ? Number(state.likes) : 0;
  const hasLikedState = Object.prototype.hasOwnProperty.call(state, "liked");

  document
    .querySelectorAll(`[data-like-count-for="${CSS.escape(slug)}"]`)
    .forEach((el) => {
      el.textContent = likes;
    });

  document
    .querySelectorAll(`form[data-like-form-for="${CSS.escape(slug)}"]`)
    .forEach((likeForm) => {
      const liked = hasLikedState
        ? Boolean(state.liked)
        : likeForm.dataset.userLiked === "true";
      if (hasLikedState) {
        likeForm.dataset.userLiked = liked ? "true" : "false";
      }

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

function updateReactionUi(state) {
  if (!state || !Array.isArray(state.reactions) || !state.target) {
    return;
  }

  const targetType = state.target;
  const identifier =
    targetType === "comment" ? state.commentId || state.comment || "" : state.slug || "";
  if (!identifier) {
    return;
  }

  const selector =
    targetType === "comment"
      ? `form[data-reaction-form][data-reaction-target="comment"][data-comment-id="${CSS.escape(identifier)}"]`
      : `form[data-reaction-form][data-reaction-target="page"][data-reaction-slug="${CSS.escape(identifier)}"]`;

  const forms = document.querySelectorAll(selector);
  if (!forms.length) {
    return;
  }

  const reactionMap = new Map();
  state.reactions.forEach((reaction) => {
    const key = reaction?.key || reaction?.id;
    if (typeof key === "string") {
      reactionMap.set(key, reaction);
    }
  });

  forms.forEach((form) => {
    form.querySelectorAll("[data-reaction-option]").forEach((button) => {
      const key = button.getAttribute("data-reaction-key");
      const reactionState = key ? reactionMap.get(key) : null;
      const count = Number.isFinite(reactionState?.count)
        ? Number(reactionState.count)
        : 0;
      const countElement = button.querySelector("[data-reaction-count]");
      if (countElement) {
        countElement.textContent = count;
      }
      if (reactionState && Object.prototype.hasOwnProperty.call(reactionState, "reacted")) {
        const reacted = Boolean(reactionState.reacted);
        button.classList.toggle("is-active", reacted);
        button.setAttribute("aria-pressed", reacted ? "true" : "false");
      }
    });
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
  const editorWrapper = container.closest("[data-editor-shell]");
  const modeSwitchElement = editorWrapper
    ? editorWrapper.parentElement?.querySelector("[data-editor-mode-switch]")
    : null;
  const visualEditor = editorWrapper?.querySelector("[data-visual-editor]") || null;
  const blockList = editorWrapper?.querySelector("[data-block-list]") || null;
  const blockEmptyState = editorWrapper?.querySelector("[data-block-empty]") || null;
  const blockEditor = editorWrapper?.querySelector("[data-block-editor]") || null;
  const addBlockButtons = editorWrapper
    ? Array.from(editorWrapper.querySelectorAll("[data-add-block]"))
    : [];

  if (!input) {
    field.hidden = false;
    field.removeAttribute("hidden");
    return;
  }

  let renderFrame = null;
  let suggestionRequestToken = 0;
  let suggestionAbortController = null;
  const suggestionState = {
    items: [],
    activeIndex: -1,
    anchor: null,
    query: "",
  };
  const blockState = [];
  let blockIdCounter = 0;
  let visualInitialized = false;
  let lastMarkdownSnapshot = "";
  let isSyncingFromBlocks = false;
  let currentMode = "markdown";

  const renderer = createMarkdownRenderer();
  input.value = field.value || field.textContent || "";
  field.value = input.value;
  lastMarkdownSnapshot = input.value;

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

  const BASE_EMOJI_SET = [
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

  function getCustomReactionEmoji() {
    const element = document.getElementById("custom-reaction-emoji");
    if (!element || !element.textContent) {
      return [];
    }
    try {
      const parsed = JSON.parse(element.textContent);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value)
        .map((value) => value.slice(0, 16));
    } catch (err) {
      console.error("Unable to parse custom reaction emoji", err);
      return [];
    }
  }

  const CUSTOM_REACTION_EMOJI = getCustomReactionEmoji();
  const EMOJI_SET = Array.from(
    new Set([...BASE_EMOJI_SET, ...CUSTOM_REACTION_EMOJI]),
  );

  function nextBlockId() {
    blockIdCounter += 1;
    return `block-${blockIdCounter}`;
  }

  function sanitizeEditableContent(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\s+$/g, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  const CALL_OUT_VARIANTS = ["info", "warning", "success"];
  const CALL_OUT_FALLBACK_TITLES = {
    info: "Information",
    warning: "Avertissement",
    success: "Succès",
  };

  function toTaskItemObject(value) {
    if (value && typeof value === "object") {
      return {
        text:
          typeof value.text === "string"
            ? value.text
            : String(value.text || ""),
        checked: Boolean(value.checked),
      };
    }
    const match = String(value || "").match(/^\[(x|X| )]\s*(.*)$/);
    return {
      text: match ? match[2] || "" : String(value || ""),
      checked: match ? /x/i.test(match[1]) : false,
    };
  }

  function normalizeTaskItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => toTaskItemObject(item))
      .map((item) => ({
        text: item.text.trim(),
        checked: item.checked,
      }))
      .filter((item) => item.text || item.checked);
  }

  function normalizeListItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => {
        if (item && typeof item === "object") {
          return String(item.text || "").trim();
        }
        return String(item || "").trim();
      })
      .filter(Boolean);
  }

  function resolveCalloutVariant(value) {
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      if (CALL_OUT_VARIANTS.includes(lowered)) {
        return lowered;
      }
    }
    return "info";
  }

  function createBlock(type, payload = {}) {
    switch (type) {
      case "heading-1":
      case "heading-2":
      case "heading-3":
      case "heading-4":
      case "paragraph":
        return {
          id: nextBlockId(),
          type,
          text: typeof payload.text === "string" ? payload.text : "",
        };
      case "quote":
        return {
          id: nextBlockId(),
          type,
          text: typeof payload.text === "string" ? payload.text : "",
        };
      case "list": {
        const style =
          payload.style === "ordered"
            ? "ordered"
            : payload.style === "task"
              ? "task"
              : "unordered";
        const items =
          style === "task"
            ? normalizeTaskItems(payload.items)
            : normalizeListItems(payload.items);
        return {
          id: nextBlockId(),
          type,
          items,
          style,
        };
      }
      case "task-list": {
        const items = normalizeTaskItems(payload.items);
        return {
          id: nextBlockId(),
          type: "list",
          items,
          style: "task",
        };
      }
      case "image":
        return {
          id: nextBlockId(),
          type,
          url: typeof payload.url === "string" ? payload.url : "",
          alt: typeof payload.alt === "string" ? payload.alt : "",
          caption: typeof payload.caption === "string" ? payload.caption : "",
        };
      case "code":
        return {
          id: nextBlockId(),
          type,
          code: typeof payload.code === "string" ? payload.code : "",
          language:
            typeof payload.language === "string" ? payload.language : "",
        };
      case "math":
        return {
          id: nextBlockId(),
          type,
          formula:
            typeof payload.formula === "string" && payload.formula
              ? payload.formula
              : "c^2 = a^2 + b^2",
        };
      case "mermaid":
        return {
          id: nextBlockId(),
          type,
          code:
            typeof payload.code === "string" && payload.code
              ? payload.code
              : "graph TD;\n  A --> B;",
        };
      case "table":
        return {
          id: nextBlockId(),
          type,
          content:
            typeof payload.content === "string" && payload.content
              ? payload.content
              : "| Colonne 1 | Colonne 2 |\n| --- | --- |\n| Valeur 1 | Valeur 2 |",
        };
      case "spoiler":
      case "details":
        return {
          id: nextBlockId(),
          type,
          title: typeof payload.title === "string" ? payload.title : "",
          body: typeof payload.body === "string" ? payload.body : "",
        };
      case "callout":
      case "callout-info":
      case "callout-warning":
      case "callout-success": {
        const variant =
          type === "callout"
            ? resolveCalloutVariant(payload.variant)
            : resolveCalloutVariant(type.replace("callout-", ""));
        return {
          id: nextBlockId(),
          type: "callout",
          variant,
          title: typeof payload.title === "string" ? payload.title : "",
          body: typeof payload.body === "string" ? payload.body : "",
        };
      }
      case "separator":
        return {
          id: nextBlockId(),
          type,
        };
      default:
        return null;
    }
  }

  function cloneBlock(block) {
    if (!block) return null;
    return createBlock(block.type, block);
  }

  function blocksToMarkdown(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) {
      return "";
    }
    const parts = [];
    blocks.forEach((block) => {
      if (!block || typeof block !== "object") {
        return;
      }
      let output = "";
      switch (block.type) {
        case "heading-1":
          if (block.text && block.text.trim()) {
            output = `# ${block.text.trim()}`;
          }
          break;
        case "heading-2":
          if (block.text && block.text.trim()) {
            output = `## ${block.text.trim()}`;
          }
          break;
        case "heading-3":
          if (block.text && block.text.trim()) {
            output = `### ${block.text.trim()}`;
          }
          break;
        case "heading-4":
          if (block.text && block.text.trim()) {
            output = `#### ${block.text.trim()}`;
          }
          break;
        case "paragraph":
          if (block.text && block.text.trim()) {
            output = block.text.trim();
          }
          break;
        case "quote":
          if (block.text && block.text.trim()) {
            output = block.text
              .split(/\r?\n/)
              .map((line) => `> ${line}`)
              .join("\n");
          }
          break;
        case "list":
          if (Array.isArray(block.items) && block.items.length) {
            if (block.style === "ordered") {
              output = block.items
                .map((item, index) => `${index + 1}. ${item}`)
                .join("\n");
            } else if (block.style === "task") {
              const lines = [];
              block.items.forEach((item) => {
                if (item && typeof item === "object") {
                  const text = String(item.text || "").trim();
                  if (!text) {
                    return;
                  }
                  const checked = item.checked ? "x" : " ";
                  lines.push(`- [${checked}] ${text}`.trimEnd());
                  return;
                }
                const match = String(item || "").match(/^(\[(?: |x|X)\]\s+)?(.*)$/);
                const content = match ? match[2] : String(item || "");
                const normalized = String(content || "").trim();
                if (!normalized) {
                  return;
                }
                const checked = match && match[1] && /x/i.test(match[1]) ? "x" : " ";
                lines.push(`- [${checked}] ${normalized}`.trimEnd());
              });
              output = lines.join("\n");
            } else {
              output = block.items.map((item) => `- ${item}`).join("\n");
            }
          }
          break;
        case "image":
          if (block.url && block.url.trim()) {
            const alt = block.alt ? block.alt.trim() : "";
            output = `![${alt}](${block.url.trim()})`;
            if (block.caption && block.caption.trim()) {
              output += `\n\n_${block.caption.trim()}_`;
            }
          }
          break;
        case "code":
          if (block.code && block.code.length) {
            const lang = block.language ? ` ${block.language.trim()}` : "";
            output = `\`\`\`${lang}\n${block.code}\n\`\`\``;
          }
          break;
        case "math":
          if (block.formula && block.formula.trim()) {
            output = `$$\n${block.formula.trim()}\n$$`;
          }
          break;
        case "mermaid":
          if (block.code && block.code.trim()) {
            output = `\`\`\`mermaid\n${block.code}\n\`\`\``;
          }
          break;
        case "table":
          if (block.content && block.content.trim()) {
            output = block.content.trim();
          }
          break;
        case "spoiler": {
          const title = block.title && block.title.trim() ? block.title.trim() : "Titre du spoiler";
          const body = block.body ? block.body.trimEnd() : "";
          const lines = [`::: spoiler ${title}`.trimEnd()];
          if (body) {
            lines.push(body);
          }
          lines.push(":::");
          output = lines.join("\n");
          break;
        }
        case "details": {
          const title = block.title && block.title.trim() ? block.title.trim() : "Titre du bloc";
          const body = block.body ? block.body.trimEnd() : "";
          const lines = [`::: details ${title}`.trimEnd()];
          if (body) {
            lines.push(body);
          }
          lines.push(":::");
          output = lines.join("\n");
          break;
        }
        case "callout": {
          const variant = resolveCalloutVariant(block.variant);
          const fallbackTitle = CALL_OUT_FALLBACK_TITLES[variant] || "Information";
          const title = block.title && block.title.trim() ? block.title.trim() : fallbackTitle;
          const body = block.body ? block.body.trimEnd() : "";
          const lines = [`::: ${variant} ${title}`.trimEnd()];
          if (body) {
            lines.push(body);
          }
          lines.push(":::");
          output = lines.join("\n");
          break;
        }
        case "separator":
          output = "---";
          break;
        default:
          break;
      }
      if (output) {
        parts.push(output.trimEnd());
      }
    });
    return parts.join("\n\n").trim();
  }

  function parseMarkdownToBlocks(markdown) {
    const blocks = [];
    if (!markdown) {
      return blocks;
    }
    const lines = String(markdown).replace(/\r/g, "").split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] || "";
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        const info = trimmed.slice(3).trim();
        const buffer = [];
        index += 1;
        while (index < lines.length && !lines[index].startsWith("```")) {
          buffer.push(lines[index]);
          index += 1;
        }
        if (index < lines.length && lines[index].startsWith("```")) {
          index += 1;
        }
        const content = buffer.join("\n");
        const block = /^mermaid\b/i.test(info)
          ? createBlock("mermaid", { code: content })
          : createBlock("code", {
              code: content,
              language: info,
            });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      if (trimmed === "$$") {
        const buffer = [];
        index += 1;
        while (index < lines.length && lines[index].trim() !== "$$") {
          buffer.push(lines[index]);
          index += 1;
        }
        if (index < lines.length && lines[index].trim() === "$$") {
          index += 1;
        }
        const block = createBlock("math", {
          formula: buffer.join("\n").trimEnd(),
        });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      const containerMatch = trimmed.match(/^:::\s*([a-z-]+)(?:\s+(.*))?$/i);
      if (containerMatch) {
        const kind = containerMatch[1].toLowerCase();
        const titleText = containerMatch[2] ? containerMatch[2].trim() : "";
        const bodyLines = [];
        index += 1;
        while (index < lines.length && !/^:::\s*$/i.test(lines[index].trim())) {
          bodyLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length && /^:::\s*$/i.test(lines[index].trim())) {
          index += 1;
        }
        const body = bodyLines.join("\n").trimEnd();
        if (["spoiler", "details"].includes(kind)) {
          const block = createBlock(kind, {
            title: titleText,
            body,
          });
          if (block) {
            blocks.push(block);
          }
          continue;
        }
        if (CALL_OUT_VARIANTS.includes(kind)) {
          const block = createBlock("callout", {
            variant: kind,
            title: titleText,
            body,
          });
          if (block) {
            blocks.push(block);
          }
          continue;
        }
      }
      if (/^####\s+/.test(trimmed)) {
        const block = createBlock("heading-4", {
          text: trimmed.replace(/^####\s+/, ""),
        });
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^###\s+/.test(trimmed)) {
        const block = createBlock("heading-3", {
          text: trimmed.replace(/^###\s+/, ""),
        });
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^##\s+/.test(trimmed)) {
        const block = createBlock("heading-2", {
          text: trimmed.replace(/^##\s+/, ""),
        });
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^#\s+/.test(trimmed)) {
        const block = createBlock("heading-1", {
          text: trimmed.replace(/^#\s+/, ""),
        });
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^(?:-{3,}|\*{3,})$/.test(trimmed)) {
        const block = createBlock("separator");
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^>\s?/.test(trimmed)) {
        const buffer = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          buffer.push(lines[index].replace(/^>\s?/, ""));
          index += 1;
        }
        const block = createBlock("quote", {
          text: buffer.join("\n").trimEnd(),
        });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      if (/^[-*+]\s+\[(?: |x|X)\]\s+/.test(trimmed)) {
        const items = [];
        while (
          index < lines.length &&
          /^[-*+]\s+\[(?: |x|X)\]\s+/.test(lines[index].trim())
        ) {
          const taskLine = lines[index].trim();
          const match = taskLine.match(/^[-*+]\s+\[( |x|X)\]\s+(.*)$/);
          items.push({
            text: match ? match[2] : taskLine.replace(/^[-*+]\s+\[(?: |x|X)\]\s+/, ""),
            checked: match ? /x/i.test(match[1]) : false,
          });
          index += 1;
        }
        const block = createBlock("task-list", {
          items,
        });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
          items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
          index += 1;
        }
        const block = createBlock("list", {
          items,
          style: "ordered",
        });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
          items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
          index += 1;
        }
        const block = createBlock("list", {
          items,
          style: "unordered",
        });
        if (block) {
          blocks.push(block);
        }
        continue;
      }
      const imageMatch = trimmed.match(/^!\[(.*?)]\((.*?)\)$/);
      if (imageMatch) {
        const block = createBlock("image", {
          alt: imageMatch[1] || "",
          url: imageMatch[2] || "",
        });
        if (block) {
          blocks.push(block);
        }
        index += 1;
        continue;
      }
      if (/^\s*\|.+\|\s*$/.test(lines[index] || "")) {
        const tableLines = [lines[index]];
        const nextLine = lines[index + 1] ? lines[index + 1].trim() : "";
        const alignmentPattern = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
        if (alignmentPattern.test(nextLine)) {
          index += 1;
          tableLines.push(lines[index]);
          index += 1;
          while (
            index < lines.length &&
            (lines[index] || "").includes("|") &&
            lines[index].trim()
          ) {
            tableLines.push(lines[index]);
            index += 1;
          }
          const block = createBlock("table", {
            content: tableLines.join("\n").trimEnd(),
          });
          if (block) {
            blocks.push(block);
          }
          continue;
        }
      }
      const paragraphBuffer = [];
      while (index < lines.length && lines[index].trim()) {
        paragraphBuffer.push(lines[index]);
        index += 1;
      }
      const block = createBlock("paragraph", {
        text: paragraphBuffer.join("\n").trimEnd(),
      });
      if (block) {
        blocks.push(block);
      }
    }
    return blocks;
  }

  function updateEmptyState() {
    if (!blockEmptyState) {
      return;
    }
    blockEmptyState.hidden = blockState.length > 0;
  }

  function buildBlockToolbar(block) {
    const toolbar = document.createElement("div");
    toolbar.className = "visual-block-toolbar";

    const handle = document.createElement("span");
    handle.className = "visual-block-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.textContent = "⋮⋮";
    toolbar.appendChild(handle);

    const label = document.createElement("span");
    label.className = "visual-block-label";
    switch (block.type) {
      case "heading-1":
        label.textContent = "Titre (H1)";
        break;
      case "heading-2":
        label.textContent = "Titre (H2)";
        break;
      case "heading-3":
        label.textContent = "Sous-titre (H3)";
        break;
      case "heading-4":
        label.textContent = "Sous-titre (H4)";
        break;
      case "quote":
        label.textContent = "Citation";
        break;
      case "list":
        if (block.style === "ordered") {
          label.textContent = "Liste numérotée";
        } else if (block.style === "task") {
          label.textContent = "Liste de tâches";
        } else {
          label.textContent = "Liste à puces";
        }
        break;
      case "image":
        label.textContent = "Image";
        break;
      case "code":
        label.textContent = "Bloc de code";
        break;
      case "math":
        label.textContent = "Formule KaTeX";
        break;
      case "mermaid":
        label.textContent = "Diagramme Mermaid";
        break;
      case "table":
        label.textContent = "Tableau";
        break;
      case "callout":
        switch (resolveCalloutVariant(block.variant)) {
          case "warning":
            label.textContent = "Bloc d'avertissement";
            break;
          case "success":
            label.textContent = "Bloc de réussite";
            break;
          default:
            label.textContent = "Bloc informatif";
            break;
        }
        break;
      case "details":
        label.textContent = "Bloc détaillé";
        break;
      case "spoiler":
        label.textContent = "Bloc spoiler";
        break;
      case "separator":
        label.textContent = "Séparateur";
        break;
      default:
        label.textContent = "Paragraphe";
        break;
    }
    toolbar.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "visual-block-actions";

    const duplicateBtn = document.createElement("button");
    duplicateBtn.type = "button";
    duplicateBtn.textContent = "Dupliquer";
    duplicateBtn.addEventListener("click", (event) => {
      event.preventDefault();
      duplicateBlock(block.id);
    });
    actions.appendChild(duplicateBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", "Supprimer le bloc");
    deleteBtn.textContent = "Supprimer";
    deleteBtn.addEventListener("click", (event) => {
      event.preventDefault();
      removeBlock(block.id);
    });
    actions.appendChild(deleteBtn);

    toolbar.appendChild(actions);

    return toolbar;
  }

  function buildContentEditableBlock(block, placeholder) {
    const body = document.createElement("div");
    body.className = "visual-block-body";
    body.contentEditable = "true";
    body.dataset.placeholder = placeholder;
    body.textContent = block.text || "";
    body.addEventListener("input", () => {
      const value = sanitizeEditableContent(body.innerText || "");
      updateBlock(block.id, { text: value });
    });
    return body;
  }

  function buildListBlock(block) {
    const fragment = document.createDocumentFragment();
    const currentStyle =
      block.style === "ordered"
        ? "ordered"
        : block.style === "task"
          ? "task"
          : "unordered";

    if (currentStyle === "task") {
      const readCurrentTasks = () =>
        Array.isArray(block.items)
          ? block.items.map((item) => toTaskItemObject(item))
          : [];
      const tasks = readCurrentTasks();
      const items = tasks.length ? tasks : [{ text: "", checked: false }];

      const listContainer = document.createElement("div");
      listContainer.className = "visual-task-list";

      const applyTaskUpdates = (index, updates) => {
        const nextItems = readCurrentTasks();
        while (nextItems.length < index + 1) {
          nextItems.push({ text: "", checked: false });
        }
        const current = nextItems[index] || { text: "", checked: false };
        nextItems[index] = {
          text:
            typeof updates.text === "string"
              ? updates.text
              : current.text,
          checked:
            typeof updates.checked === "boolean"
              ? updates.checked
              : current.checked,
        };
        updateBlock(block.id, { items: nextItems, style: "task" });
      };

      const removeTask = (index) => {
        const nextItems = readCurrentTasks();
        nextItems.splice(index, 1);
        updateBlock(block.id, { items: nextItems, style: "task" });
      };

      items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "visual-task-item";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(item.checked);
        checkbox.addEventListener("change", () => {
          applyTaskUpdates(index, { checked: checkbox.checked });
        });
        row.appendChild(checkbox);

        const textField = document.createElement("input");
        textField.type = "text";
        textField.placeholder = "Nouvelle tâche";
        textField.value = item.text || "";
        textField.addEventListener("input", () => {
          applyTaskUpdates(index, { text: textField.value });
        });
        row.appendChild(textField);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "visual-task-remove";
        removeBtn.textContent = "Retirer";
        removeBtn.addEventListener("click", (event) => {
          event.preventDefault();
          removeTask(index);
        });
        row.appendChild(removeBtn);

        listContainer.appendChild(row);
      });

      fragment.appendChild(listContainer);

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "visual-task-add";
      addBtn.textContent = "Ajouter une tâche";
      addBtn.addEventListener("click", (event) => {
        event.preventDefault();
        const nextItems = readCurrentTasks();
        nextItems.push({ text: "", checked: false });
        updateBlock(block.id, { items: nextItems, style: "task" });
      });
      fragment.appendChild(addBtn);
    } else {
      const textarea = document.createElement("textarea");
      textarea.placeholder =
        currentStyle === "ordered"
          ? "Un élément par ligne (numérotation automatique)"
          : "Un élément par ligne";
      const values = Array.isArray(block.items)
        ? block.items.map((item) =>
            typeof item === "string" ? item : String(item?.text || ""),
          )
        : [];
      textarea.value = values.join("\n");
      textarea.addEventListener("input", () => {
        const items = textarea.value
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
        updateBlock(block.id, { items, style: currentStyle });
      });
      fragment.appendChild(textarea);
    }

    const meta = document.createElement("div");
    meta.className = "visual-block-meta";
    const select = document.createElement("select");
    const unorderedOption = document.createElement("option");
    unorderedOption.value = "unordered";
    unorderedOption.textContent = "Puces";
    const orderedOption = document.createElement("option");
    orderedOption.value = "ordered";
    orderedOption.textContent = "Numérotation";
    const taskOption = document.createElement("option");
    taskOption.value = "task";
    taskOption.textContent = "Liste de tâches";
    select.appendChild(unorderedOption);
    select.appendChild(orderedOption);
    select.appendChild(taskOption);
    select.value = currentStyle;
    select.addEventListener("change", () => {
      if (select.value === "task") {
        const nextItems = Array.isArray(block.items)
          ? block.items.map((item) => toTaskItemObject(item))
          : [];
        if (!nextItems.length) {
          nextItems.push({ text: "", checked: false });
        }
        updateBlock(block.id, { style: "task", items: nextItems });
        return;
      }
      const normalizedItems = Array.isArray(block.items)
        ? block.items
            .map((item) =>
              typeof item === "string"
                ? item.trim()
                : String(item?.text || "").trim(),
            )
            .filter(Boolean)
        : [];
      updateBlock(block.id, {
        style: select.value === "ordered" ? "ordered" : "unordered",
        items: normalizedItems,
      });
    });
    meta.appendChild(select);
    fragment.appendChild(meta);

    const note = document.createElement("p");
    note.className = "visual-block-note";
    if (currentStyle === "ordered") {
      note.textContent =
        "Les numéros sont générés automatiquement à la publication.";
    } else if (currentStyle === "task") {
      note.textContent =
        "Ajoutez des tâches, cochez celles terminées et réorganisez au besoin.";
    } else {
      note.textContent =
        "Ajoutez chaque élément sur une nouvelle ligne pour créer une liste à puces.";
    }
    fragment.appendChild(note);

    return fragment;
  }

  function buildCalloutBlock(block) {
    const container = document.createElement("div");
    container.className = "visual-block-stack";

    const meta = document.createElement("div");
    meta.className = "visual-block-meta";
    const select = document.createElement("select");
    const infoOption = document.createElement("option");
    infoOption.value = "info";
    infoOption.textContent = "Bloc informatif";
    const warningOption = document.createElement("option");
    warningOption.value = "warning";
    warningOption.textContent = "Bloc d'avertissement";
    const successOption = document.createElement("option");
    successOption.value = "success";
    successOption.textContent = "Bloc de réussite";
    select.appendChild(infoOption);
    select.appendChild(warningOption);
    select.appendChild(successOption);
    select.value = resolveCalloutVariant(block.variant);
    select.addEventListener("change", () => {
      updateBlock(block.id, { variant: resolveCalloutVariant(select.value) });
    });
    meta.appendChild(select);
    container.appendChild(meta);

    const titleField = document.createElement("input");
    titleField.type = "text";
    titleField.placeholder = "Titre du bloc";
    titleField.value = block.title || "";
    titleField.addEventListener("input", () => {
      updateBlock(block.id, { title: titleField.value });
    });
    container.appendChild(titleField);

    const bodyField = document.createElement("textarea");
    bodyField.placeholder = "Contenu du bloc";
    bodyField.value = block.body || "";
    bodyField.addEventListener("input", () => {
      updateBlock(block.id, { body: bodyField.value });
    });
    container.appendChild(bodyField);

    const note = document.createElement("p");
    note.className = "visual-block-note";
    note.textContent =
      "Le rendu final mettra en avant ce bloc avec un style adapté.";
    container.appendChild(note);

    return container;
  }

  function buildDisclosureBlock(block, { titlePlaceholder, bodyPlaceholder }) {
    const container = document.createElement("div");
    container.className = "visual-block-stack";

    const titleField = document.createElement("input");
    titleField.type = "text";
    titleField.placeholder = titlePlaceholder;
    titleField.value = block.title || "";
    titleField.addEventListener("input", () => {
      updateBlock(block.id, { title: titleField.value });
    });
    container.appendChild(titleField);

    const bodyField = document.createElement("textarea");
    bodyField.placeholder = bodyPlaceholder;
    bodyField.value = block.body || "";
    bodyField.addEventListener("input", () => {
      updateBlock(block.id, { body: bodyField.value });
    });
    container.appendChild(bodyField);

    return container;
  }

  function buildMathBlock(block) {
    const fragment = document.createDocumentFragment();
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Formule KaTeX";
    textarea.value = block.formula || "";
    textarea.addEventListener("input", () => {
      updateBlock(block.id, { formula: textarea.value });
    });
    fragment.appendChild(textarea);

    const note = document.createElement("p");
    note.className = "visual-block-note";
    note.textContent = "Utilisez la syntaxe KaTeX (ex : c^2 = a^2 + b^2).";
    fragment.appendChild(note);

    return fragment;
  }

  function buildMermaidBlock(block) {
    const fragment = document.createDocumentFragment();
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Diagramme Mermaid";
    textarea.value = block.code || "";
    textarea.addEventListener("input", () => {
      updateBlock(block.id, { code: textarea.value });
    });
    fragment.appendChild(textarea);

    const note = document.createElement("p");
    note.className = "visual-block-note";
    note.textContent =
      "Définissez vos diagrammes Mermaid (ex : graph TD; A --> B;).";
    fragment.appendChild(note);

    return fragment;
  }

  function buildTableBlock(block) {
    const fragment = document.createDocumentFragment();
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Tableau en Markdown";
    textarea.value = block.content || "";
    textarea.addEventListener("input", () => {
      updateBlock(block.id, { content: textarea.value });
    });
    fragment.appendChild(textarea);

    const note = document.createElement("p");
    note.className = "visual-block-note";
    note.textContent =
      "Utilisez les séparateurs | et la deuxième ligne --- pour aligner vos colonnes.";
    fragment.appendChild(note);

    return fragment;
  }

  function buildImageBlock(block) {
    const container = document.createElement("div");
    container.className = "visual-block-meta";

    const urlField = document.createElement("input");
    urlField.type = "url";
    urlField.placeholder = "URL de l'image";
    urlField.value = block.url || "";
    urlField.addEventListener("input", () => {
      updateBlock(block.id, { url: urlField.value.trim() });
    });
    container.appendChild(urlField);

    const altField = document.createElement("input");
    altField.type = "text";
    altField.placeholder = "Texte alternatif";
    altField.value = block.alt || "";
    altField.addEventListener("input", () => {
      updateBlock(block.id, { alt: altField.value });
    });
    container.appendChild(altField);

    const captionField = document.createElement("input");
    captionField.type = "text";
    captionField.placeholder = "Légende (optionnelle)";
    captionField.value = block.caption || "";
    captionField.addEventListener("input", () => {
      updateBlock(block.id, { caption: captionField.value });
    });
    container.appendChild(captionField);

    return container;
  }

  function buildCodeBlock(block) {
    const fragment = document.createDocumentFragment();
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Votre code";
    textarea.value = block.code || "";
    textarea.addEventListener("input", () => {
      updateBlock(block.id, { code: textarea.value });
    });
    fragment.appendChild(textarea);

    const meta = document.createElement("div");
    meta.className = "visual-block-meta";
    const languageField = document.createElement("input");
    languageField.type = "text";
    languageField.placeholder = "Langage (ex: js, python)";
    languageField.value = block.language || "";
    languageField.addEventListener("input", () => {
      updateBlock(block.id, { language: languageField.value.trim() });
    });
    meta.appendChild(languageField);
    fragment.appendChild(meta);

    return fragment;
  }

  function buildBlockElement(block) {
    const element = document.createElement("div");
    element.className = "visual-block";
    element.draggable = true;
    element.dataset.blockId = block.id;
    element.dataset.blockType = block.type;

    const toolbar = buildBlockToolbar(block);
    element.appendChild(toolbar);

    switch (block.type) {
      case "heading-1":
        element.appendChild(
          buildContentEditableBlock(block, "Titre principal"),
        );
        break;
      case "heading-2":
        element.appendChild(
          buildContentEditableBlock(block, "Titre de section"),
        );
        break;
      case "heading-3":
        element.appendChild(
          buildContentEditableBlock(block, "Sous-titre"),
        );
        break;
      case "heading-4":
        element.appendChild(
          buildContentEditableBlock(block, "Titre de niveau 4"),
        );
        break;
      case "quote":
        element.appendChild(
          buildContentEditableBlock(block, "Citation"),
        );
        break;
      case "list":
        element.appendChild(buildListBlock(block));
        break;
      case "image":
        element.appendChild(buildImageBlock(block));
        break;
      case "code":
        element.appendChild(buildCodeBlock(block));
        break;
      case "math":
        element.appendChild(buildMathBlock(block));
        break;
      case "mermaid":
        element.appendChild(buildMermaidBlock(block));
        break;
      case "table":
        element.appendChild(buildTableBlock(block));
        break;
      case "separator": {
        const divider = document.createElement("hr");
        divider.className = "visual-block-separator";
        divider.setAttribute("aria-hidden", "true");
        element.appendChild(divider);
        break;
      }
      case "callout":
        element.appendChild(buildCalloutBlock(block));
        break;
      case "details":
        element.appendChild(
          buildDisclosureBlock(block, {
            titlePlaceholder: "Titre du bloc détaillé",
            bodyPlaceholder: "Contenu détaillé",
          }),
        );
        break;
      case "spoiler":
        element.appendChild(
          buildDisclosureBlock(block, {
            titlePlaceholder: "Titre du spoiler",
            bodyPlaceholder: "Contenu masqué",
          }),
        );
        break;
      default:
        element.appendChild(
          buildContentEditableBlock(block, "Paragraphe"),
        );
        break;
    }

    element.addEventListener("dragstart", (event) => {
      element.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", block.id);
    });

    element.addEventListener("dragend", () => {
      element.classList.remove("is-dragging");
    });

    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      const draggingId = event.dataTransfer.getData("text/plain");
      if (!draggingId || draggingId === block.id) {
        return;
      }
      const draggingElement = blockList?.querySelector(
        `[data-block-id="${draggingId}"]`,
      );
      if (!draggingElement || !blockList) {
        return;
      }
      const bounding = element.getBoundingClientRect();
      const after = event.clientY > bounding.top + bounding.height / 2;
      if (after) {
        blockList.insertBefore(draggingElement, element.nextSibling);
      } else {
        blockList.insertBefore(draggingElement, element);
      }
    });

    element.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggingId = event.dataTransfer.getData("text/plain");
      if (!draggingId || draggingId === block.id) {
        return;
      }
      reorderBlocks(draggingId, block.id, event);
    });

    return element;
  }

  function reorderBlocks(sourceId, targetId, event) {
    const sourceIndex = blockState.findIndex((item) => item.id === sourceId);
    const targetIndex = blockState.findIndex((item) => item.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) {
      return;
    }
    const targetElement = blockList?.querySelector(
      `[data-block-id="${targetId}"]`,
    );
    const after = targetElement
      ? event.clientY >
        targetElement.getBoundingClientRect().top +
          targetElement.getBoundingClientRect().height / 2
      : false;
    const [item] = blockState.splice(sourceIndex, 1);
    let newIndex = targetIndex;
    if (after) {
      newIndex = targetIndex + 1;
    }
    if (sourceIndex < newIndex) {
      newIndex -= 1;
    }
    blockState.splice(newIndex, 0, item);
    renderBlocks();
    syncMarkdownFromBlocks();
  }

  function renderBlocks() {
    if (!blockList) {
      return;
    }
    blockList.innerHTML = "";
    blockState.forEach((block) => {
      if (!block.id) {
        block.id = nextBlockId();
      }
      const element = buildBlockElement(block);
      blockList.appendChild(element);
    });
    updateEmptyState();
  }

  function updateBlock(blockId, updates) {
    const block = blockState.find((item) => item.id === blockId);
    if (!block) {
      return;
    }
    Object.assign(block, updates);
    syncMarkdownFromBlocks();
  }

  function removeBlock(blockId) {
    const index = blockState.findIndex((item) => item.id === blockId);
    if (index === -1) {
      return;
    }
    blockState.splice(index, 1);
    renderBlocks();
    syncMarkdownFromBlocks();
  }

  function duplicateBlock(blockId) {
    const index = blockState.findIndex((item) => item.id === blockId);
    if (index === -1) {
      return;
    }
    const copy = cloneBlock(blockState[index]);
    if (!copy) {
      return;
    }
    blockState.splice(index + 1, 0, copy);
    renderBlocks();
    syncMarkdownFromBlocks();
    window.setTimeout(() => {
      focusBlock(copy.id);
    }, 0);
  }

  function focusBlock(blockId) {
    if (!blockList) {
      return;
    }
    const element = blockList.querySelector(`[data-block-id="${blockId}"]`);
    if (!element) {
      return;
    }
    const editable = element.querySelector("[contenteditable='true']");
    if (editable) {
      editable.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }
    const focusable = element.querySelector("textarea, input, select");
    if (focusable) {
      focusable.focus();
    }
  }

  function ensureVisualFromMarkdown() {
    if (!visualEditor || !blockList) {
      return;
    }
    if (!visualInitialized || lastMarkdownSnapshot !== input.value) {
      const parsed = parseMarkdownToBlocks(input.value || "");
      blockState.length = 0;
      parsed.forEach((block) => {
        if (block) {
          blockState.push(block);
        }
      });
      renderBlocks();
      visualInitialized = true;
      lastMarkdownSnapshot = input.value;
    }
    updateEmptyState();
  }

  function syncMarkdownFromBlocks() {
    if (!blockEditor) {
      return;
    }
    const markdown = blocksToMarkdown(blockState);
    isSyncingFromBlocks = true;
    input.value = markdown;
    field.value = markdown;
    handleValueChange();
    isSyncingFromBlocks = false;
    lastMarkdownSnapshot = markdown;
  }

  function updateModeButtons() {
    if (!modeSwitchElement) {
      return;
    }
    const buttons = Array.from(
      modeSwitchElement.querySelectorAll("[data-editor-mode]"),
    );
    buttons.forEach((button) => {
      const mode = button.getAttribute("data-editor-mode");
      const isActive = mode === currentMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function setEditorMode(mode) {
    const normalized = mode === "visual" ? "visual" : "markdown";
    if (normalized === currentMode) {
      return;
    }
    if (normalized === "visual" && !visualEditor) {
      return;
    }
    currentMode = normalized;
    if (currentMode === "visual") {
      ensureVisualFromMarkdown();
    }
    if (visualEditor) {
      visualEditor.hidden = currentMode !== "visual";
    }
    container.hidden = currentMode !== "markdown";
    updateModeButtons();
    if (currentMode === "markdown") {
      handleValueChange();
      scheduleRender();
    }
  }

  function registerModeSwitch() {
    if (!modeSwitchElement) {
      return;
    }
    const buttons = Array.from(
      modeSwitchElement.querySelectorAll("[data-editor-mode]"),
    );
    buttons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const mode = button.getAttribute("data-editor-mode");
        if (mode) {
          setEditorMode(mode);
        }
      });
    });
  }

  function registerAddBlockButtons() {
    if (!addBlockButtons.length) {
      return;
    }
    addBlockButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const type = button.getAttribute("data-add-block");
        if (!type) {
          return;
        }
        const block = createBlock(type);
        if (!block) {
          return;
        }
        blockState.push(block);
        renderBlocks();
        syncMarkdownFromBlocks();
        window.setTimeout(() => {
          focusBlock(block.id);
        }, 0);
      });
    });
  }

  registerModeSwitch();
  registerAddBlockButtons();
  updateModeButtons();
  if (visualEditor) {
    visualEditor.hidden = currentMode !== "visual";
  }

  const CALLOUT_META = {
    info: {
      fallbackTitle: "Information",
      promptLabel: "informatif",
      placeholder: "Contenu informatif",
    },
    warning: {
      fallbackTitle: "Avertissement",
      promptLabel: "d'avertissement",
      placeholder: "Points importants à noter",
    },
    success: {
      fallbackTitle: "Succès",
      promptLabel: "de réussite",
      placeholder: "Annonce ou résultat positif",
    },
  };

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
    if (!isSyncingFromBlocks) {
      lastMarkdownSnapshot = input.value;
    }
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

  function sanitizeSingleLine(value) {
    return (value || "").replace(/[\r\n]+/g, " ").trim();
  }

  function promptBlockTitle(message, fallback) {
    const response = window.prompt(message, fallback);
    if (response === null) {
      return null;
    }
    const sanitized = sanitizeSingleLine(response);
    return sanitized || fallback;
  }

  function restoreSelection(selection) {
    if (
      !selection ||
      typeof selection.start !== "number" ||
      typeof selection.end !== "number"
    ) {
      return;
    }
    input.focus();
    input.setSelectionRange(selection.start, selection.end);
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

  function insertCalloutBlock(type) {
    const meta = CALLOUT_META[type] || CALLOUT_META.info;
    const selection = getSelection();
    const promptText = `Titre du bloc ${meta.promptLabel} :`;
    const title = promptBlockTitle(promptText, meta.fallbackTitle);
    if (title === null) {
      return;
    }
    restoreSelection(selection);
    insertMultilineBlock(`::: ${type} ${title}`, meta.placeholder, ":::");
  }

  function normalizeListLine(line) {
    const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(\[(?: |x|X)\]\s+)?(.*)$/);
    const indent = match ? match[1] : "";
    const taskMarker = match ? match[2] : "";
    const content = match ? match[3] || "" : line;
    return {
      indent,
      content,
      checked: Boolean(taskMarker && /x/i.test(taskMarker)),
    };
  }

  function applyListAction({ type, placeholder }) {
    const { start, end } = getSelection();
    const value = input.value;
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const hasSelection = Boolean(selected);
    const lines = hasSelection ? selected.split(/\r?\n/) : [""];
    const formattedLines = [];
    let placeholderMeta = null;

    lines.forEach((line, index) => {
      const meta = normalizeListLine(line);
      const usePlaceholder = !hasSelection && index === 0;
      let lineContent = meta.content
        ? meta.content.replace(/^\s+/, "")
        : "";
      if (!lineContent && usePlaceholder) {
        lineContent = placeholder;
      }

      let prefix = "- ";
      switch (type) {
        case "ordered":
          prefix = `${index + 1}. `;
          break;
        case "task":
          prefix = `- [${meta.checked ? "x" : " "}] `;
          break;
        default:
          prefix = "- ";
          break;
      }

      if (
        !placeholderMeta &&
        !hasSelection &&
        usePlaceholder &&
        lineContent === placeholder
      ) {
        placeholderMeta = {
          indentLength: meta.indent.length,
          prefixLength: prefix.length,
        };
      }

      formattedLines.push(`${meta.indent}${prefix}${lineContent}`);
    });

    const formatted = formattedLines.join("\n");

    if (hasSelection) {
      input.value = before + formatted + after;
      const selectionStart = before.length;
      const selectionEnd = selectionStart + formatted.length;
      input.setSelectionRange(selectionStart, selectionEnd);
    } else {
      const needsLeadingNewline = before && !before.endsWith("\n") ? "\n" : "";
      const needsTrailingNewline = after && !after.startsWith("\n") ? "\n" : "";
      const insertion = `${needsLeadingNewline}${formatted}${needsTrailingNewline}`;
      input.value = before + insertion + after;
      if (placeholderMeta) {
        const caretStart =
          before.length +
          needsLeadingNewline.length +
          placeholderMeta.indentLength +
          placeholderMeta.prefixLength;
        const caretEnd = caretStart + placeholder.length;
        input.setSelectionRange(caretStart, caretEnd);
      } else {
        const caret = before.length + insertion.length;
        input.setSelectionRange(caret, caret);
      }
    }

    handleValueChange();
  }

  function insertHorizontalRule() {
    const { start, end } = getSelection();
    const value = input.value;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const needsLeadingNewline = before && !before.endsWith("\n") ? "\n" : "";
    const trailingNewlines =
      after.length === 0 ? "\n" : after.startsWith("\n") ? "\n" : "\n\n";
    const insertion = `${needsLeadingNewline}---${trailingNewlines}`;
    input.value = before + insertion + after;
    const caret = before.length + insertion.length;
    input.setSelectionRange(caret, caret);
    handleValueChange();
  }

  function insertTableTemplate() {
    const template = [
      "| Colonne 1 | Colonne 2 |",
      "| --------- | --------- |",
      "| Valeur 1  | Valeur 2  |",
    ].join("\n");
    const { start, end } = getSelection();
    const value = input.value;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const needsLeadingNewline = before && !before.endsWith("\n") ? "\n" : "";
    const needsTrailingNewline = after && !after.startsWith("\n") ? "\n\n" : "\n";
    const insertion = `${needsLeadingNewline}${template}${needsTrailingNewline}`;
    input.value = before + insertion + after;
    const caretStart = before.length + needsLeadingNewline.length + 2;
    const caretEnd = caretStart + "Colonne 1".length;
    input.setSelectionRange(caretStart, caretEnd);
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
      case "highlight":
        wrapSelection("<mark>", "</mark>", "Texte mis en évidence");
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
      case "image": {
        const { start, end } = getSelection();
        const value = input.value;
        const selected = value.slice(start, end);
        const url = window.prompt("Entrez l'URL de l'image :", "https://");
        if (!url) {
          return;
        }
        let altText = selected || "Description de l'image";
        if (!selected) {
          const altPrompt = window.prompt(
            "Texte alternatif de l'image :",
            altText,
          );
          if (altPrompt === null) {
            return;
          }
          altText = altPrompt || altText;
        }
        const normalizedAlt = altText.trim() || "Image";
        const snippet = `![${normalizedAlt}](${url.trim()})`;
        const before = value.slice(0, start);
        const after = value.slice(end);
        input.value = before + snippet + after;
        if (!selected) {
          const caretStart = before.length + 2;
          const caretEnd = caretStart + normalizedAlt.length;
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
      case "spoiler": {
        const selection = getSelection();
        const title = promptBlockTitle(
          "Titre du bloc spoiler :",
          "Titre du spoiler"
        );
        if (title === null) {
          return;
        }
        restoreSelection(selection);
        insertMultilineBlock(
          `::: spoiler ${title}`,
          "Contenu du spoiler",
          ":::"
        );
        break;
      }
      case "details": {
        const selection = getSelection();
        const title = promptBlockTitle(
          "Titre du bloc détaillé :",
          "Titre du bloc"
        );
        if (title === null) {
          return;
        }
        restoreSelection(selection);
        insertMultilineBlock(
          `::: details ${title}`,
          "Contenu détaillé",
          ":::"
        );
        break;
      }
      case "callout-info":
        insertCalloutBlock("info");
        break;
      case "callout-warning":
        insertCalloutBlock("warning");
        break;
      case "callout-success":
        insertCalloutBlock("success");
        break;
      case "katex":
        insertMultilineBlock("$$", "c^2 = a^2 + b^2", "$$");
        break;
      case "mermaid":
        insertMultilineBlock("```mermaid", "graph TD;\n  A --> B;", "```");
        break;
      case "unordered-list":
        applyListAction({ type: "unordered", placeholder: "Élément de liste" });
        break;
      case "ordered-list":
        applyListAction({
          type: "ordered",
          placeholder: "Élément numéroté",
        });
        break;
      case "task-list":
        applyListAction({ type: "task", placeholder: "Nouvelle tâche" });
        break;
      case "horizontal-rule":
        insertHorizontalRule();
        break;
      case "table":
        insertTableTemplate();
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

  input.addEventListener("input", () => {
    if (!isSyncingFromBlocks) {
      visualInitialized = false;
    }
    handleValueChange();
  });
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
    const containerPlugin = window.markdownitContainer;
    md.use(containerPlugin, "spoiler", {
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

    md.use(containerPlugin, "details", {
      validate: (params) => /^details(\s+.*)?$/i.test(params.trim()),
      render: (tokens, idx) => {
        const match = tokens[idx].info.trim().match(/^details\s*(.*)$/i);
        if (tokens[idx].nesting === 1) {
          const title = match && match[1] ? match[1].trim() : "Détails";
          return `<details class="md-details"><summary>${escapeHtml(
            title || "Détails"
          )}</summary>\n<div class="md-details-body">\n`;
        }
        return "</div></details>\n";
      },
    });

    const calloutConfigs = [
      { name: "info", defaultTitle: "Information" },
      { name: "warning", defaultTitle: "Avertissement" },
      { name: "success", defaultTitle: "Succès" },
    ];

    calloutConfigs.forEach(({ name, defaultTitle }) => {
      const pattern = new RegExp(`^${name}\\s*(.*)$`, "i");
      md.use(containerPlugin, name, {
        validate: (params) => {
          const trimmed = params.trim();
          return pattern.test(trimmed);
        },
        render: (tokens, idx) => {
          const info = tokens[idx].info.trim();
          const match = info.match(pattern);
          if (tokens[idx].nesting === 1) {
            const title = match && match[1] ? match[1].trim() : defaultTitle;
            return `<div class="md-callout md-callout-${name}"><div class="md-callout-title">${escapeHtml(
              title || defaultTitle
            )}</div>\n<div class="md-callout-body">\n`;
          }
          return "</div></div>\n";
        },
      });
    });
  }
  if (window.markdownitKatex && window.katex) {
    md.use(window.markdownitKatex);
  }

  if (window.markdownitTaskLists) {
    md.use(window.markdownitTaskLists, { enabled: true });
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
