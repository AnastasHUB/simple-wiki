(function () {
  const STATUS_STATES = {
    idle: "idle",
    loading: "loading",
    success: "success",
    warning: "warning",
    error: "error",
  };

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildLocalPreview(value) {
    const escaped = escapeHtml(value);
    const withBold = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const withItalic = withBold.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    const withCode = withItalic.replace(/`([^`]+)`/g, "<code>$1</code>");
    return withCode.replace(/\n/g, "<br>");
  }

  function setStatus(statusElement, message, state) {
    if (!statusElement) return;
    statusElement.textContent = message || "";
    statusElement.dataset.state = state || STATUS_STATES.idle;
  }

  function showPreview(previewContainer, previewBody, html) {
    if (!previewContainer || !previewBody) return;
    const content = html && String(html).trim();
    if (!content) {
      previewBody.innerHTML = "<p class=\"comment-preview-empty\">Aucun contenu à afficher pour le moment.</p>";
    } else {
      previewBody.innerHTML = content;
    }
    previewContainer.hidden = false;
  }

  function hidePreview(previewContainer, previewBody) {
    if (!previewContainer || !previewBody) return;
    previewBody.innerHTML = "";
    previewContainer.hidden = true;
  }

  function initCommentPreview() {
    const forms = document.querySelectorAll("[data-comment-preview-form]");
    if (!forms.length) {
      return;
    }

    forms.forEach((form) => {
      const field = form.querySelector("[data-preview-source]");
      const previewContainer = form.querySelector("[data-preview-container]");
      const previewBody = form.querySelector("[data-preview-body]");
      const statusElement = form.querySelector("[data-preview-status]");
      const endpoint = form.getAttribute("data-preview-endpoint") || "";

      if (!field || !previewContainer || !previewBody) {
        return;
      }

      if (!field.id) {
        field.id = `comment-body-${Math.random().toString(36).slice(2)}`;
      }

      let debounceTimer = null;
      let currentController = null;
      let lastRenderedValue = "";

      const renderLocal = (value, options = {}) => {
        const html = buildLocalPreview(value);
        showPreview(previewContainer, previewBody, html);
        const message = options.message || "Aperçu local (mode hors-ligne).";
        setStatus(statusElement, message, options.state || STATUS_STATES.warning);
      };

      const processResponse = (payload, originalValue) => {
        if (!payload || payload.ok === false) {
          const errorMessage = Array.isArray(payload?.errors)
            ? payload.errors.join(" ")
            : payload?.error || "Impossible de générer l'aperçu.";
          renderLocal(originalValue, {
            message: errorMessage,
            state: STATUS_STATES.error,
          });
          return;
        }
        const html = typeof payload.html === "string" ? payload.html : "";
        showPreview(previewContainer, previewBody, html);
        setStatus(statusElement, "Aperçu généré automatiquement.", STATUS_STATES.success);
        lastRenderedValue = originalValue;
      };

      const requestPreview = (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          hidePreview(previewContainer, previewBody);
          setStatus(statusElement, "Saisissez du texte pour voir l'aperçu.", STATUS_STATES.idle);
          lastRenderedValue = "";
          if (currentController) {
            currentController.abort();
            currentController = null;
          }
          return;
        }

        if (trimmed === lastRenderedValue) {
          return;
        }

        if (!endpoint) {
          renderLocal(trimmed, {
            message: "Aperçu généré localement (aucun serveur configuré).",
            state: STATUS_STATES.warning,
          });
          lastRenderedValue = trimmed;
          return;
        }

        if (currentController) {
          currentController.abort();
        }

        currentController = new AbortController();
        setStatus(statusElement, "Génération de l'aperçu…", STATUS_STATES.loading);

        const headers = applyCsrfHeader({
          "Content-Type": "application/json",
          Accept: "application/json",
        });

        fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ body: trimmed }),
          signal: currentController.signal,
        })
          .then((response) => {
            if (!response.ok) {
              return response
                .json()
                .catch(() => ({ ok: false, error: "Réponse invalide du serveur." }));
            }
            return response.json().catch(() => ({ ok: false, error: "Réponse invalide du serveur." }));
          })
          .then((payload) => {
            processResponse(payload, trimmed);
          })
          .catch((error) => {
            if (error?.name === "AbortError") {
              return;
            }
            renderLocal(trimmed, {
              message: "Aperçu local suite à une erreur réseau.",
              state: STATUS_STATES.warning,
            });
          })
          .finally(() => {
            currentController = null;
          });
      };

      const schedulePreview = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = window.setTimeout(() => {
          requestPreview(field.value || "");
        }, 240);
      };

      field.addEventListener("input", schedulePreview);
      field.addEventListener("change", schedulePreview);

      if (field.value && field.value.trim()) {
        requestPreview(field.value);
      } else {
        setStatus(statusElement, "Saisissez du texte pour voir l'aperçu.", STATUS_STATES.idle);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCommentPreview);
  } else {
    initCommentPreview();
  }

  window.SimpleWiki = window.SimpleWiki || {};
  window.SimpleWiki.initCommentPreview = initCommentPreview;
})();
