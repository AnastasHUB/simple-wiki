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

  const codeLanguageSelect = toolbarElement
    ? toolbarElement.querySelector(".ql-code-language")
    : null;

  const supportedCodeLanguages = codeLanguageSelect
    ? Array.from(codeLanguageSelect.options)
        .map((option) => option.value.trim())
        .filter((value) => value.length > 0)
    : [];

  if (window.hljs) {
    const hljsConfig = { ignoreUnescapedHTML: true };
    if (supportedCodeLanguages.length > 0) {
      hljsConfig.languages = supportedCodeLanguages;
    }
    window.hljs.configure(hljsConfig);
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

  const readLineLanguage = (line) => {
    const blotName = line?.statics?.blotName || line?.constructor?.blotName;
    if (blotName !== CODE_BLOCK_BLOT_NAME) {
      return "";
    }
    if (!line.domNode || typeof line.domNode.getAttribute !== "function") {
      return "";
    }
    return line.domNode.getAttribute("data-language") || "";
  };

  const getSelectionLanguage = () => {
    const range = quill.getSelection();
    if (!range) return "";
    const lines = getCodeBlockLinesInRange(range);
    if (lines.length === 0) {
      const [line] = quill.getLine(range.index);
      if (line) {
        return readLineLanguage(line);
      }
      return "";
    }
    return readLineLanguage(lines[0]);
  };

  const syncLanguageSelect = () => {
    if (!codeLanguageSelect) return;
    const current = getSelectionLanguage();
    codeLanguageSelect.value = current || "";
  };

  const applyLanguageToSelection = (language) => {
    const range = quill.getSelection(true);
    if (!range) return;

    const normalizedLanguage =
      language && supportedCodeLanguages.includes(language) ? language : "";

    quill.format("code-block", normalizedLanguage || true);

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
      if (!node || typeof node.setAttribute !== "function") {
        return;
      }
      if (normalizedLanguage) {
        node.setAttribute("data-language", normalizedLanguage);
      } else {
        node.removeAttribute("data-language");
      }
      node.classList.add("hljs");
    });

    refreshCodeHighlighting({ immediate: true });
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
        const chosenLanguage = codeLanguageSelect?.value || "";
        applyLanguageToSelection(chosenLanguage);
      } else {
        quill.format("code-block", false);
        refreshCodeHighlighting({ immediate: true });
      }
      requestAnimationFrame(() => {
        syncLanguageSelect();
      });
    });
  }

  if (codeLanguageSelect) {
    codeLanguageSelect.addEventListener("change", (event) => {
      applyLanguageToSelection(event.target.value || "");
      requestAnimationFrame(() => {
        syncLanguageSelect();
        quill.focus();
      });
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
  syncLanguageSelect();
  refreshCodeHighlighting({ immediate: true });

  quill.on("text-change", (_delta, _oldDelta, source) => {
    syncField();
    refreshCodeHighlighting({ immediate: source !== "user" });
    syncLanguageSelect();
  });

  quill.on("selection-change", () => {
    syncLanguageSelect();
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
