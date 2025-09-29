let quillDividerRegistered = false;
let quillCodeBlockRegistered = false;

(function () {
  const toggleBtn = document.getElementById("sidebarToggle");
  const overlayHit = document.getElementById("overlayHit"); // zone cliquable à droite
  const links = document.querySelectorAll("#vnav a");

  const openDrawer = () =>
    document.documentElement.classList.add("drawer-open");
  const closeDrawer = () =>
    document.documentElement.classList.remove("drawer-open");

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      document.documentElement.classList.contains("drawer-open")
        ? closeDrawer()
        : openDrawer();
    });
  }

  overlayHit && overlayHit.addEventListener("click", closeDrawer);
  links.forEach((a) => a.addEventListener("click", closeDrawer));
})();

document.addEventListener("DOMContentLoaded", () => {
  initNotifications();
  enhanceIconButtons();
  initLikeForms();
  initHtmlEditor();
  initCodeHighlighting();
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
  message.textContent = notif.message;
  body.appendChild(message);

  item.appendChild(body);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "notification-close";
  close.setAttribute("aria-label", "Fermer la notification");
  close.textContent = "✕";
  item.appendChild(close);

  const remove = () => {
    item.classList.remove("show");
    item.addEventListener(
      "transitionend",
      () => {
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
  const forms = document.querySelectorAll('form[data-like-form-for]');
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

async function handleLikeSubmit(event, form) {
  const submitter = event.submitter || form.querySelector('button[type="submit"]');
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
      const message = data?.message || "Impossible de mettre à jour vos favoris.";
      throw new Error(message);
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
    notifyClient([
      {
        type: "error",
        message: err.message || "Une erreur est survenue.",
        timeout: 4000,
      },
    ]);
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

  const scrollingContainer = quill.scrollingContainer || quill.root.parentElement;
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
    const savedScrollTop = scrollingContainer ? scrollingContainer.scrollTop : null;

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
        throw new Error(
          message || "Erreur lors du téléversement de l'image.",
        );
      }
      const range =
        pendingRange ||
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
      const range =
        quill.getSelection(true) || { index: quill.getLength(), length: 0 };
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
