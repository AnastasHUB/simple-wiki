import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, "../config/reactions.json");

const DEFAULT_REACTIONS = [
  { id: "heart", label: "J'adore", emoji: "❤️", imageUrl: null },
  { id: "bravo", label: "Bravo", emoji: "👏", imageUrl: null },
  { id: "celebration", label: "À fêter", emoji: "🎉", imageUrl: null },
  { id: "idea", label: "Malin", emoji: "💡", imageUrl: null },
  { id: "curious", label: "Intrigué", emoji: "🤔", imageUrl: null },
];

let cachedReactions = null;

function sanitizeId(rawId) {
  if (typeof rawId !== "string" || !rawId.trim()) {
    return null;
  }
  const normalized = rawId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 48);
}

function normalizeReaction(raw, index) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const sourceId =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : typeof raw.emoji === "string"
      ? raw.emoji
      : `reaction-${index + 1}`;
  const id = sanitizeId(sourceId);
  if (!id) {
    return null;
  }
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim()
      : typeof raw.emoji === "string" && raw.emoji.trim()
      ? raw.emoji.trim()
      : id;
  const emoji =
    typeof raw.emoji === "string" && raw.emoji.trim() ? raw.emoji.trim() : "";
  const imageUrl =
    typeof raw.imageUrl === "string" && raw.imageUrl.trim()
      ? raw.imageUrl.trim()
      : null;
  return {
    id,
    label,
    emoji,
    imageUrl,
  };
}

async function readReactionConfig() {
  try {
    const content = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      console.warn(
        "Le fichier de configuration des réactions doit contenir un tableau. Utilisation des valeurs par défaut.",
      );
      return DEFAULT_REACTIONS;
    }
    const seen = new Set();
    const normalized = [];
    parsed.forEach((raw, index) => {
      const reaction = normalizeReaction(raw, index);
      if (!reaction) {
        return;
      }
      if (seen.has(reaction.id)) {
        return;
      }
      seen.add(reaction.id);
      normalized.push({ ...reaction });
    });
    return normalized.length ? normalized : DEFAULT_REACTIONS;
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn(
        "Impossible de charger config/reactions.json : utilisation des réactions par défaut.",
        err,
      );
    }
    return DEFAULT_REACTIONS;
  }
}

export async function getReactionConfig() {
  if (cachedReactions) {
    return cachedReactions.slice();
  }
  const reactions = await readReactionConfig();
  cachedReactions = reactions;
  return reactions.slice();
}

export function invalidateReactionConfigCache() {
  cachedReactions = null;
}

export function getDefaultReactions() {
  return DEFAULT_REACTIONS.slice();
}
