import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const activeSecrets = [];
let watcher;
let debounceTimer;

function normalizeSecretList(list) {
  return list.map((value) => value.trim()).filter(Boolean);
}

function readSecretsFromFile(filePath) {
  try {
    const fileContents = fs.readFileSync(filePath, "utf8");
    return normalizeSecretList(fileContents.split(/\r?\n/));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Unable to read session secret file:", error.message);
    }
    return [];
  }
}

function readSecretsFromEnv() {
  const secrets = [];
  if (process.env.SESSION_SECRET) {
    secrets.push(process.env.SESSION_SECRET);
  }
  if (process.env.SESSION_SECRETS) {
    secrets.push(...process.env.SESSION_SECRETS.split(","));
  }
  return normalizeSecretList(secrets);
}

function ensureSecretsLoaded(values) {
  const unique = Array.from(new Set(values));
  if (unique.length === 0) {
    const generatedSecret = uuidv4();
    console.warn(
      "No session secret provided. Generated a new ephemeral session secret.",
    );
    unique.push(generatedSecret);
  }
  activeSecrets.splice(0, activeSecrets.length, ...unique);
  return activeSecrets;
}

export function refreshSessionSecrets() {
  const fromEnv = readSecretsFromEnv();
  const filePath = process.env.SESSION_SECRET_FILE;
  const fromFile = filePath ? readSecretsFromFile(filePath) : [];
  return ensureSecretsLoaded([...fromEnv, ...fromFile]);
}

export function getSessionSecrets() {
  if (!activeSecrets.length) {
    refreshSessionSecrets();
  }
  return activeSecrets;
}

function setupWatchers() {
  const filePath = process.env.SESSION_SECRET_FILE;
  if (!filePath || watcher) {
    return;
  }

  try {
    watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        refreshSessionSecrets();
        console.info("Session secrets reloaded from", filePath);
        if (eventType === "rename") {
          watcher.close();
          watcher = undefined;
          setupWatchers();
        }
      }, 100);
    });
  } catch (error) {
    watcher = undefined;
    console.warn("Failed to watch session secret file:", error.message);
  }
}

refreshSessionSecrets();
setupWatchers();

process.on("SIGHUP", () => {
  refreshSessionSecrets();
  console.info("Session secrets reloaded after SIGHUP signal");
});
