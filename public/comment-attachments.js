(function initCommentAttachmentPreview() {
  const formatSize = (bytes) => {
    if (typeof bytes !== "number" || Number.isNaN(bytes) || bytes <= 0) {
      return null;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
    }
    const kilobytes = Math.max(1, Math.round(bytes / 1024));
    return `${kilobytes} Ko`;
  };

  const cleanupUrls = (urls) => {
    if (!Array.isArray(urls)) {
      return;
    }
    urls.forEach((url) => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    });
    urls.length = 0;
  };

  const forms = document.querySelectorAll("[data-comment-preview-form]");
  forms.forEach((form) => {
    const input = form.querySelector("[data-comment-attachment-input]");
    const previewList = form.querySelector("[data-comment-attachment-preview]");
    if (!input || !previewList) {
      return;
    }

    const previewUrls = [];

    const renderPreviews = () => {
      cleanupUrls(previewUrls);
      previewList.innerHTML = "";
      const files = Array.from(input.files || []);
      if (!files.length) {
        previewList.hidden = true;
        previewList.setAttribute("aria-hidden", "true");
        return;
      }

      files.forEach((file) => {
        const item = document.createElement("li");
        item.className = "attachment-preview-item";

        if (file.type && /^image\/[^\s]+$/i.test(file.type)) {
          const thumb = document.createElement("img");
          thumb.className = "attachment-preview-thumb";
          const objectUrl = URL.createObjectURL(file);
          previewUrls.push(objectUrl);
          thumb.src = objectUrl;
          thumb.alt = "";
          thumb.loading = "lazy";
          item.appendChild(thumb);
        }

        const info = document.createElement("div");
        info.className = "attachment-preview-info";
        const name = document.createElement("span");
        name.textContent = file.name || "Pièce jointe";
        info.appendChild(name);
        const sizeLabel = formatSize(file.size);
        if (sizeLabel) {
          const size = document.createElement("span");
          size.className = "attachment-preview-size";
          size.textContent = sizeLabel;
          info.appendChild(size);
        }
        item.appendChild(info);
        previewList.appendChild(item);
      });

      previewList.hidden = false;
      previewList.setAttribute("aria-hidden", "false");
    };

    input.addEventListener("change", renderPreviews);
    form.addEventListener("reset", () => {
      cleanupUrls(previewUrls);
      previewList.innerHTML = "";
      previewList.hidden = true;
      previewList.setAttribute("aria-hidden", "true");
    });
  });
})();
