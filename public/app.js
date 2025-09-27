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
  initHtmlEditor();
});

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
    container.style.display = "none";
    const toolbar = toolbarSelector ? document.querySelector(toolbarSelector) : null;
    if (toolbar) {
      toolbar.style.display = "none";
    }
    return;
  }

  const options = { theme: "snow", modules: {} };
  if (toolbarSelector) {
    options.modules.toolbar = toolbarSelector;
  }

  const quill = new window.Quill(container, options);
  const initialValue = field.value || "";
  if (initialValue) {
    quill.clipboard.dangerouslyPasteHTML(initialValue);
  }

  const form = field.form;
  if (form) {
    form.addEventListener("submit", () => {
      field.value = quill.root.innerHTML.trim();
    });
  }
}
