(function () {
  const hasWebAuthnSupport = typeof window.PublicKeyCredential === "function";
  const helperMessage = document.querySelector("[data-passkey-helper]");
  if (!hasWebAuthnSupport) {
    if (helperMessage) {
      helperMessage.hidden = false;
    }
    const buttons = document.querySelectorAll("[data-passkey-login], [data-passkey-register]");
    buttons.forEach((button) => {
      button.disabled = true;
      button.classList.add("is-disabled");
    });
    return;
  }
  if (helperMessage) {
    helperMessage.hidden = true;
  }

  function base64UrlToBuffer(value) {
    if (typeof value !== "string" || !value) {
      return new ArrayBuffer(0);
    }
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const padLength = (4 - (padded.length % 4)) % 4;
    const base64 = padded + "=".repeat(padLength);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    const base64 = btoa(binary).replace(/=+$/g, "");
    return base64.replace(/\+/g, "-").replace(/\//g, "_");
  }

  function applyCsrf(headers = {}) {
    if (typeof window.applyCsrfHeader === "function") {
      return window.applyCsrfHeader(headers);
    }
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
    if (token) {
      headers["X-CSRF-Token"] = token;
    }
    return headers;
  }

  function getNotificationLayer() {
    return document.getElementById("notificationLayer");
  }

  function spawn(message, type = "info") {
    if (!message) return;
    const layer = getNotificationLayer();
    if (layer && typeof window.spawnNotification === "function") {
      window.spawnNotification(layer, { message, type, timeout: 5000 });
    } else {
      console[type === "error" ? "error" : "log"](message);
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    let data = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (err) {
        data = null;
      }
    }
    if (!response.ok) {
      const error = new Error(data?.error || `Requête échouée (${response.status})`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function decodeRegistrationOptions(options) {
    if (!options || typeof options !== "object") {
      return options;
    }
    const publicKey = { ...options };
    publicKey.challenge = base64UrlToBuffer(options.challenge);
    if (options.user) {
      publicKey.user = { ...options.user, id: base64UrlToBuffer(options.user.id) };
    }
    if (Array.isArray(options.excludeCredentials)) {
      publicKey.excludeCredentials = options.excludeCredentials.map((descriptor) => ({
        ...descriptor,
        id: base64UrlToBuffer(descriptor.id),
      }));
    }
    return publicKey;
  }

  function decodeAuthenticationOptions(options) {
    if (!options || typeof options !== "object") {
      return options;
    }
    const publicKey = { ...options };
    publicKey.challenge = base64UrlToBuffer(options.challenge);
    if (Array.isArray(options.allowCredentials)) {
      publicKey.allowCredentials = options.allowCredentials.map((descriptor) => ({
        ...descriptor,
        id: base64UrlToBuffer(descriptor.id),
      }));
    }
    return publicKey;
  }

  function serializeAttestation(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: bufferToBase64Url(credential.response.attestationObject),
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        transports:
          typeof credential.response.getTransports === "function"
            ? credential.response.getTransports()
            : [],
      },
      clientExtensionResults:
        typeof credential.getClientExtensionResults === "function"
          ? credential.getClientExtensionResults()
          : {},
    };
  }

  function serializeAssertion(credential) {
    return {
      id: credential.id,
      rawId: bufferToBase64Url(credential.rawId),
      type: credential.type,
      response: {
        authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
        signature: bufferToBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? bufferToBase64Url(credential.response.userHandle)
          : null,
      },
      clientExtensionResults:
        typeof credential.getClientExtensionResults === "function"
          ? credential.getClientExtensionResults()
          : {},
    };
  }

  async function handlePasskeyRegistration(event) {
    event.preventDefault();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLButtonElement)) {
      return;
    }
    if (trigger.disabled) {
      return;
    }
    trigger.disabled = true;
    trigger.classList.add("is-loading");

    const labelField = document.querySelector("[data-passkey-label]");
    const friendlyName = labelField instanceof HTMLInputElement ? labelField.value.trim() : "";

    try {
      const options = await fetchJson("/account/security/passkeys/options", {
        method: "POST",
        headers: applyCsrf({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({}),
      });

      if (!options?.options?.challenge) {
        throw new Error("Réponse de configuration WebAuthn inattendue.");
      }

      const publicKey = decodeRegistrationOptions(options.options);
      const credential = await navigator.credentials.create({ publicKey });
      if (!credential) {
        throw new Error("Impossible de créer une nouvelle passkey.");
      }

      const attestation = serializeAttestation(credential);
      const payload = {
        credential: attestation,
        label: friendlyName,
      };

      const verification = await fetchJson("/account/security/passkeys/register", {
        method: "POST",
        headers: applyCsrf({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify(payload),
      });

      if (Array.isArray(verification?.notifications)) {
        verification.notifications.forEach((notif) => {
          if (notif?.message) {
            spawn(notif.message, notif.type || "info");
          }
        });
      } else {
        spawn("Votre passkey a été enregistrée.", "success");
      }

      window.location.reload();
    } catch (error) {
      const message = error?.data?.error || error?.message || "Enregistrement de la passkey impossible.";
      spawn(message, "error");
      trigger.disabled = false;
      trigger.classList.remove("is-loading");
    }
  }

  async function handlePasskeyLogin(event) {
    event.preventDefault();
    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLButtonElement)) {
      return;
    }
    if (trigger.disabled) {
      return;
    }

    const form = trigger.closest("form");
    const usernameField = form?.querySelector('input[name="username"]');
    const username = usernameField instanceof HTMLInputElement ? usernameField.value.trim() : "";
    if (!username) {
      spawn("Veuillez indiquer votre nom d'utilisateur avant d'utiliser une passkey.", "error");
      return;
    }

    trigger.disabled = true;
    trigger.classList.add("is-loading");

    try {
      const options = await fetchJson("/login/passkey/options", {
        method: "POST",
        headers: applyCsrf({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify({ username }),
      });

      if (!options?.options?.challenge) {
        throw new Error("Réponse de configuration WebAuthn inattendue.");
      }

      const publicKey = decodeAuthenticationOptions(options.options);
      const assertion = await navigator.credentials.get({ publicKey });
      if (!assertion) {
        throw new Error("La passkey n'a pas pu être utilisée.");
      }

      const payload = {
        credential: serializeAssertion(assertion),
      };

      const result = await fetchJson("/login/passkey/verify", {
        method: "POST",
        headers: applyCsrf({
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        body: JSON.stringify(payload),
      });

      const redirect = result?.redirect || "/";
      window.location.assign(redirect);
    } catch (error) {
      const message = error?.data?.error || error?.message || "Connexion par passkey impossible.";
      spawn(message, "error");
      trigger.disabled = false;
      trigger.classList.remove("is-loading");
    }
  }

  const registerButton = document.querySelector("[data-passkey-register]");
  if (registerButton) {
    registerButton.addEventListener("click", handlePasskeyRegistration);
  }

  const loginButton = document.querySelector("[data-passkey-login]");
  if (loginButton) {
    loginButton.addEventListener("click", handlePasskeyLogin);
  }
})();
