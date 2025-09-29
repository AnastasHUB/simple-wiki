import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHANGELOG_PATH = path.join(__dirname, "..", "docs", "changelog.json");

let cachedEntries = null;
let cachedMtimeMs = 0;

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      const description = Array.isArray(entry.details)
        ? entry.details.filter((line) => typeof line === "string" && line.trim())
        : [];
      const date = typeof entry.date === "string" ? entry.date : null;
      return {
        title: title || "Mise à jour",
        date,
        details: description,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const dateA = a.date ? Date.parse(a.date) : 0;
      const dateB = b.date ? Date.parse(b.date) : 0;
      return dateB - dateA;
    });
}

export async function loadChangelogEntries() {
  try {
    const stats = await fs.stat(CHANGELOG_PATH);
    if (cachedEntries && cachedMtimeMs === stats.mtimeMs) {
      return cachedEntries;
    }
    const raw = await fs.readFile(CHANGELOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cachedEntries = normalizeEntries(parsed);
    cachedMtimeMs = stats.mtimeMs;
    return cachedEntries;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error("Unable to load changelog", err);
    }
    cachedEntries = [];
    cachedMtimeMs = 0;
    return [];
  }
}
