let quillDividerRegistered = false;
let quillCodeBlockRegistered = false;

(function () {
  const toggleBtn = document.getElementById("sidebarToggle");
  const overlayHit = document.getElementById("overlayHit"); // zone cliquable à droite
  const links = document.querySelectorAll("#vnav a");
  const html = document.documentElement;

  const setExpanded = (expanded) => {
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggleBtn.setAttribute(
      "aria-label",
      expanded ? "Fermer le menu" : "Ouvrir le menu",
    );
  };

  const openDrawer = () => {
    html.classList.add("drawer-open");
    setExpanded(true);
  };
  const closeDrawer = () => {
    if (!html.classList.contains("drawer-open")) {
      return;
    }
    html.classList.remove("drawer-open");
    setExpanded(false);
  };

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      html.classList.contains("drawer-open") ? closeDrawer() : openDrawer();
    });
    setExpanded(html.classList.contains("drawer-open"));
  }

  overlayHit && overlayHit.addEventListener("click", closeDrawer);
  links.forEach((a) => a.addEventListener("click", closeDrawer));

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
  initHtmlEditor();
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
    loading: false,
  };

  let requestSerial = 0;
  let activeRequests = 0;

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

  const updateStatus = (timestamp, isError = false) => {
    if (isError) {
      statusEl.textContent = "Dernière mise à jour : échec du rafraîchissement";
      statusEl.classList.add("live-stats-status-error");
      return;
    }
    statusEl.classList.remove("live-stats-status-error");
    if (!timestamp) {
      statusEl.textContent = "Dernière mise à jour : --";
      return;
    }
    statusEl.textContent = `Dernière mise à jour : ${timeFormatter.format(new Date(timestamp))}`;
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

  const fetchData = async (options = {}) => {
    const requestedPage = parseNumber(options.page, state.page);
    const requestedPerPage = parseNumber(options.perPage, state.perPage);
    const params = new URLSearchParams();
    params.set(pageParam, String(requestedPage));
    params.set(perPageParam, String(requestedPerPage));

    const token = ++requestSerial;
    activeRequests += 1;
    state.loading = true;
    try {
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload || payload.ok !== true) {
        throw new Error("Réponse inattendue");
      }

      const visitors = Array.isArray(payload.visitors) ? payload.visitors : [];
      if (token === requestSerial) {
        renderVisitors(visitors);
        updateVisibility(visitors.length > 0);
        applyPagination(payload.pagination || {});
        if (payload.liveVisitorsWindowSeconds !== undefined) {
          const seconds = Number(payload.liveVisitorsWindowSeconds);
          card.setAttribute("data-live-window-seconds", seconds);
          updateWindowLabel(seconds);
        }
        updateStatus(Date.now());
      }
    } catch (error) {
      console.error(
        "Erreur lors du rafraîchissement des statistiques en direct",
        error,
      );
      if (token === requestSerial) {
        updateStatus(null, true);
      }
    } finally {
      activeRequests = Math.max(0, activeRequests - 1);
      state.loading = activeRequests > 0;
    }
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
        fetchData();
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
    fetchData({ page: state.page, perPage: state.perPage });
    restartTimer();
  };

  const handlePrev = () => {
    if (prevButton.disabled) {
      return;
    }
    const targetPage = Math.max(1, state.page - 1);
    fetchData({ page: targetPage, perPage: state.perPage });
    restartTimer();
  };

  const handleNext = () => {
    if (nextButton.disabled) {
      return;
    }
    const targetPage = state.page + 1;
    fetchData({ page: targetPage, perPage: state.perPage });
    restartTimer();
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
    } else {
      fetchData();
      restartTimer();
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  const cleanup = () => {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
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

  fetchData().finally(() => {
    restartTimer();
  });
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

function registerQuillCodeBlock(quillGlobal) {
  if (quillCodeBlockRegistered || !quillGlobal) {
    return;
  }

  try {
    const syntaxModule = quillGlobal.import("modules/syntax");
    if (!syntaxModule || !syntaxModule.CodeBlock) {
      return;
    }

    const BaseCodeBlock = syntaxModule.CodeBlock;

    class CodeBlockWithLanguage extends BaseCodeBlock {
      static create(value) {
        const node = super.create(value);
        CodeBlockWithLanguage.applyLanguage(node, value);
        node.classList.add("hljs");
        return node;
      }

      static applyLanguage(node, value) {
        if (typeof value === "string" && value) {
          node.setAttribute("data-language", value);
        } else {
          node.removeAttribute("data-language");
        }
      }

      static formats(domNode) {
        const language = domNode.getAttribute("data-language");
        return language || true;
      }

      format(name, value) {
        if (name === this.statics.blotName) {
          this.constructor.applyLanguage(this.domNode, value);
        }
        super.format(name, value);
      }

      highlight(highlight) {
        const text = this.domNode.textContent;
        if (this.cachedText === text) {
          return;
        }

        let html = null;
        const language = this.domNode.getAttribute("data-language");
        if (language && window.hljs && window.hljs.getLanguage(language)) {
          try {
            html = window.hljs.highlight(text, {
              language,
              ignoreIllegals: true,
            }).value;
          } catch (error) {
            console.warn("Échec de la coloration du code", error);
          }
        }

        if (html == null && typeof highlight === "function") {
          html = highlight(text);
        }

        if (html != null) {
          this.domNode.innerHTML = html;
          this.domNode.normalize();
          this.attach();
        }
        this.cachedText = text;
        this.domNode.classList.add("hljs");
      }
    }

    quillGlobal.register(CodeBlockWithLanguage, true);
    quillCodeBlockRegistered = true;
  } catch (error) {
    console.warn("Impossible de personnaliser les blocs de code Quill", error);
  }
}

function initHtmlEditor() {
  const container = document.querySelector("[data-html-editor]");
  if (!container) return;

  const targetSelector = container.getAttribute("data-target");
  const toolbarSelector = container.getAttribute("data-toolbar");
  const field = targetSelector ? document.querySelector(targetSelector) : null;
  const toolbarElement = toolbarSelector
    ? document.querySelector(toolbarSelector)
    : null;
  if (!field) return;

  if (!window.Quill) {
    field.hidden = false;
    field.removeAttribute("hidden");
    container.style.display = "none";
    if (toolbarElement) {
      toolbarElement.style.display = "none";
    }
    return;
  }

  registerQuillDivider(window.Quill);
  registerQuillCodeBlock(window.Quill);

  if (window.hljs) {
    window.hljs.configure({ ignoreUnescapedHTML: true });
  }

  const options = {
    theme: "snow",
    modules: {
      clipboard: {
        matchVisual: false,
      },
      history: {
        delay: 1000,
        maxStack: 500,
        userOnly: true,
      },
    },
  };
  if (toolbarSelector) {
    options.modules.toolbar = { container: toolbarSelector };
  }
  if (window.hljs) {
    options.modules.syntax = {
      highlight: (text) => {
        try {
          return window.hljs.highlightAuto(text).value;
        } catch (error) {
          console.warn("Échec de la coloration automatique du code", error);
          return text;
        }
      },
    };
  }

  const quill = new window.Quill(container, options);

  const scrollingContainer =
    quill.scrollingContainer || quill.root.parentElement;
  const silentSource = window.Quill?.sources?.SILENT || "api";
  let highlightTimeoutId = null;
  let lastKnownSelection = null;

  const runCodeHighlighting = () => {
    highlightTimeoutId = null;
    const syntax = quill.getModule("syntax");
    if (!syntax || typeof syntax.highlight !== "function") {
      return;
    }

    const selection = quill.getSelection();
    const savedScrollTop = scrollingContainer
      ? scrollingContainer.scrollTop
      : null;

    syntax.highlight();

    if (selection) {
      quill.setSelection(selection, silentSource);
    }
    if (savedScrollTop != null && scrollingContainer) {
      scrollingContainer.scrollTop = savedScrollTop;
    }
  };

  const refreshCodeHighlighting = ({ immediate = false } = {}) => {
    if (highlightTimeoutId) {
      window.clearTimeout(highlightTimeoutId);
      highlightTimeoutId = null;
    }

    if (immediate) {
      runCodeHighlighting();
    } else {
      highlightTimeoutId = window.setTimeout(runCodeHighlighting, 200);
    }
  };

  const CODE_BLOCK_BLOT_NAME = "code-block";

  const getCodeBlockLinesInRange = (range) => {
    if (!range) return [];
    try {
      const lines = quill.getLines(range.index, range.length || 0);
      return lines.filter((line) => {
        const blotName = line?.statics?.blotName || line?.constructor?.blotName;
        return blotName === CODE_BLOCK_BLOT_NAME;
      });
    } catch (_error) {
      return [];
    }
  };

  const clearLanguageFromSelection = () => {
    let range = quill.getSelection(true);
    if (!range && lastKnownSelection) {
      range = { ...lastKnownSelection };
      quill.setSelection(range, silentSource);
    }
    if (!range) return;

    quill.format("code-block", true);

    const affectedLines = getCodeBlockLinesInRange(range);
    if (affectedLines.length === 0) {
      const [singleLine] = quill.getLine(range.index);
      const blotName =
        singleLine?.statics?.blotName || singleLine?.constructor?.blotName;
      if (blotName === CODE_BLOCK_BLOT_NAME) {
        affectedLines.push(singleLine);
      }
    }

    affectedLines.forEach((line) => {
      const node = line?.domNode;
      if (!node) {
        return;
      }
      if (typeof node.removeAttribute === "function") {
        node.removeAttribute("data-language");
      }
      node.classList.add("hljs");
    });

    refreshCodeHighlighting({ immediate: true });
    lastKnownSelection = { index: range.index, length: range.length || 0 };
  };
  const uploadEndpoint =
    container.getAttribute("data-upload-endpoint") || "/admin/uploads";
  let imageInput = null;
  let pendingRange = null;

  const setUploading = (value) => {
    if (value) {
      container.setAttribute("data-uploading-image", "true");
    } else {
      container.removeAttribute("data-uploading-image");
    }
  };

  const notify = (type, message) => {
    if (!message) return;
    const layer = document.getElementById("notificationLayer");
    if (layer && typeof spawnNotification === "function") {
      spawnNotification(layer, { type, message });
    } else if (type === "error") {
      window.alert(message);
    }
  };

  const uploadImageFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      if (file.name) {
        const baseName = file.name.replace(/\.[^.]+$/, "");
        if (baseName) {
          formData.append("displayName", baseName);
        }
      }
      const response = await fetch(uploadEndpoint, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
      if (!response.ok || !data?.ok || !data.url) {
        const message = data?.message || data?.error;
        throw new Error(message || "Erreur lors du téléversement de l'image.");
      }
      const range = pendingRange ||
        quill.getSelection(true) || { index: quill.getLength(), length: 0 };
      quill.insertEmbed(range.index, "image", data.url, "user");
      quill.setSelection(range.index + 1, 0);
      notify("success", "Image importée avec succès.");
    } catch (err) {
      console.error("Image upload failed", err);
      const message = err?.message || "Impossible d'importer l'image.";
      notify("error", message);
    } finally {
      pendingRange = null;
      setUploading(false);
    }
  };

  const openImagePicker = () => {
    if (!imageInput) {
      imageInput = document.createElement("input");
      imageInput.type = "file";
      imageInput.accept = "image/png,image/jpeg,image/webp,image/gif";
      imageInput.style.display = "none";
      imageInput.addEventListener("change", () => {
        const file = imageInput?.files?.[0] || null;
        imageInput.value = "";
        uploadImageFile(file);
      });
      document.body.appendChild(imageInput);
    }
    imageInput.click();
  };

  const toolbar = quill.getModule("toolbar");
  if (toolbar) {
    toolbar.addHandler("image", () => {
      pendingRange = quill.getSelection(true);
      openImagePicker();
    });
    toolbar.addHandler("divider", () => {
      const range = quill.getSelection(true) || {
        index: quill.getLength(),
        length: 0,
      };
      quill.insertEmbed(range.index, "divider", true, "user");
      quill.insertText(range.index + 1, "\n", "user");
      quill.setSelection(range.index + 2, 0, "user");
    });
    toolbar.addHandler("code-block", (value) => {
      if (value) {
        clearLanguageFromSelection();
      } else {
        quill.format("code-block", false);
        refreshCodeHighlighting({ immediate: true });
      }
    });
  }

  const initialValue = field.value || "";
  if (initialValue) {
    quill.clipboard.dangerouslyPasteHTML(initialValue);
    refreshCodeHighlighting({ immediate: true });
  }

  const syncField = () => {
    const html = quill.root.innerHTML.trim();
    const text = quill.getText().trim();
    if (!text) {
      field.value = "";
    } else {
      field.value = html;
    }
  };

  syncField();
  refreshCodeHighlighting({ immediate: true });

  quill.on("text-change", (_delta, _oldDelta, source) => {
    syncField();
    refreshCodeHighlighting({ immediate: source !== "user" });
  });

  quill.on("selection-change", (range, oldRange) => {
    if (range) {
      lastKnownSelection = { index: range.index, length: range.length || 0 };
    } else if (oldRange) {
      lastKnownSelection = {
        index: oldRange.index,
        length: oldRange.length || 0,
      };
    }
  });

  const form = field.form;
  if (form) {
    form.addEventListener("submit", () => {
      syncField();
    });
  }
}

function registerQuillDivider(quillGlobal) {
  if (quillDividerRegistered || !quillGlobal) return;
  const BlockEmbed = quillGlobal.import("blots/block/embed");
  if (!BlockEmbed) return;
  class DividerBlot extends BlockEmbed {}
  DividerBlot.blotName = "divider";
  DividerBlot.tagName = "hr";
  quillGlobal.register(DividerBlot);
  quillDividerRegistered = true;
}

function initCodeHighlighting() {
  if (!window.hljs) return;

  if (typeof window.hljs.configure === "function") {
    window.hljs.configure({ ignoreUnescapedHTML: true });
  }

  const highlightPre = (pre) => {
    if (!pre || pre.dataset.highlighted === "true") return;
    const codeChild = pre.querySelector("code");
    if (codeChild) {
      window.hljs.highlightElement(codeChild);
      pre.dataset.highlighted = "true";
      pre.classList.add("hljs");
      return;
    }
    const text = pre.textContent || "";
    const result = window.hljs.highlightAuto(text);
    const code = document.createElement("code");
    code.className = `hljs${result.language ? ` language-${result.language}` : ""}`;
    code.innerHTML = result.value;
    pre.innerHTML = "";
    pre.appendChild(code);
    pre.dataset.highlighted = "true";
    pre.classList.add("hljs");
  };

  document
    .querySelectorAll(".prose pre, .excerpt pre")
    .forEach((pre) => highlightPre(pre));
}
