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

function initHtmlEditor() {
  const container = document.querySelector("[data-html-editor]");
  if (!container) return;

  const targetSelector = container.getAttribute("data-target");
  const toolbarSelector = container.getAttribute("data-toolbar");
  const field = targetSelector ? document.querySelector(targetSelector) : null;
  if (!field) return;

  if (!window.Quill) {
    field.hidden = false;
    field.removeAttribute("hidden");
    container.style.display = "none";
    const toolbar = toolbarSelector ? document.querySelector(toolbarSelector) : null;
    if (toolbar) {
      toolbar.style.display = "none";
    }
    return;
  }

  const options = {
    theme: "snow",
    modules: {
      clipboard: {
        matchVisual: false,
      },
    },
  };
  if (toolbarSelector) {
    options.modules.toolbar = toolbarSelector;
  }

  const quill = new window.Quill(container, options);
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
  }

  const initialValue = field.value || "";
  if (initialValue) {
    quill.clipboard.dangerouslyPasteHTML(initialValue);
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

  quill.on("text-change", syncField);

  const form = field.form;
  if (form) {
    form.addEventListener("submit", () => {
      syncField();
    });
  }
}
