function initChatbot() {
  const form = document.querySelector("[data-chatbot-form]");
  if (!form) {
    return;
  }

  const textarea = form.querySelector("textarea[name='message']");
  const variantSelect = form.querySelector("select[name='variant']");
  const messagesContainer = document.querySelector("[data-chatbot-messages]");
  const emptyState = document.querySelector("[data-chatbot-empty]");
  const submitButton = form.querySelector("button[type='submit']");
  const chatbotSection = document.querySelector(".chatbot");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!textarea) {
      return;
    }

    const message = textarea.value.trim();
    if (!message) {
      textarea.focus();
      return;
    }

    setLoading(true);

    try {
      const payload = {
        message,
        variant: variantSelect ? variantSelect.value : "public",
      };
      const response = await fetch("/chatbot/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMessage = data?.error || "Une erreur est survenue lors de l'appel à l'assistant.";
        renderMessage({
          role: "error",
          title: "Erreur",
          content: errorMessage,
        });
        return;
      }

      if (textarea) {
        textarea.value = "";
      }

      renderMessage({
        role: "question",
        title: "Vous",
        content: message,
      });

      renderMessage({
        role: "answer",
        title: data.variant === "admin" ? "Assistant (admin)" : "Assistant",
        content: data.answer || "Je n'ai pas pu générer de réponse.",
        sources: Array.isArray(data.sources) ? data.sources : [],
      });
    } catch (err) {
      renderMessage({
        role: "error",
        title: "Erreur",
        content: "Impossible de contacter le serveur. Vérifiez votre connexion et réessayez.",
      });
    } finally {
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    form.classList.toggle("is-loading", Boolean(isLoading));
    if (chatbotSection) {
      chatbotSection.classList.toggle("is-loading", Boolean(isLoading));
    }
    if (submitButton) {
      submitButton.disabled = Boolean(isLoading);
      submitButton.setAttribute("aria-busy", isLoading ? "true" : "false");
    }
  }

  function renderMessage({ role, title, content, sources = [] }) {
    if (!messagesContainer) {
      return;
    }

    if (emptyState) {
      emptyState.hidden = true;
    }
    messagesContainer.hidden = false;

    const wrapper = document.createElement("article");
    wrapper.className = `chatbot-message chatbot-${role}`;

    const header = document.createElement("header");
    header.className = "chatbot-message-header";
    header.textContent = title;
    wrapper.appendChild(header);

    const body = document.createElement("div");
    body.className = "chatbot-message-body";
    body.textContent = content;
    wrapper.appendChild(body);

    if (sources.length) {
      const sourcesList = document.createElement("ul");
      sourcesList.className = "chatbot-sources";
      sources.forEach((source) => {
        if (!source) return;
        const item = document.createElement("li");
        const strong = document.createElement("strong");
        strong.textContent = source.source || "Source";
        item.appendChild(strong);
        if (source.snippet) {
          const details = document.createElement("span");
          details.textContent = ` — ${source.snippet}`;
          item.appendChild(details);
        }
        sourcesList.appendChild(item);
      });
      wrapper.appendChild(sourcesList);
    }

    messagesContainer.appendChild(wrapper);
    messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "smooth" });
  }
}

document.addEventListener("DOMContentLoaded", initChatbot);
