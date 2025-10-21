export function sanitizeReactionKey(rawKey) {
  if (typeof rawKey !== "string" || !rawKey.trim()) {
    return null;
  }
  const normalized = rawKey
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

export function normalizeReactionDefinition(raw, index = 0) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const sourceId =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : typeof raw.emoji === "string" && raw.emoji.trim()
      ? raw.emoji
      : `reaction-${index + 1}`;
  const id = sanitizeReactionKey(sourceId);
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

export function normalizeReactionList(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  rawList.forEach((raw, index) => {
    const reaction = normalizeReactionDefinition(raw, index);
    if (!reaction) {
      return;
    }
    if (seen.has(reaction.id)) {
      return;
    }
    seen.add(reaction.id);
    normalized.push(reaction);
  });
  return normalized;
}
