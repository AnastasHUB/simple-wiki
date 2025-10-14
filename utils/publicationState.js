const INTERNAL_PAGE_STATUS_VALUES = ["draft", "published", "scheduled"];
const PAGE_STATUS_SET = new Set(INTERNAL_PAGE_STATUS_VALUES);

function normalizeStatusInput(input) {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim().toLowerCase();
}

export function parseDateTimeInput(rawValue) {
  if (typeof rawValue !== "string") {
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function formatPublishAtForInput(rawValue) {
  const parsed =
    rawValue instanceof Date ? rawValue : parseDateTimeInput(String(rawValue || ""));
  if (!parsed) {
    return "";
  }
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function resolvePublicationState({
  statusInput,
  publishAtInput,
  canSchedule,
  now = new Date(),
} = {}) {
  const normalizedStatus = normalizeStatusInput(statusInput);
  const status = PAGE_STATUS_SET.has(normalizedStatus)
    ? normalizedStatus
    : normalizedStatus
      ? normalizedStatus
      : "published";
  const errors = [];
  let publishAt = null;
  const trimmedPublishAt = typeof publishAtInput === "string" ? publishAtInput.trim() : "";

  if (!PAGE_STATUS_SET.has(status)) {
    errors.push({
      code: "invalid_status",
      message: "Statut de publication invalide.",
    });
  }

  if (status === "scheduled") {
    if (!canSchedule) {
      errors.push({
        code: "forbidden_schedule",
        message: "Vous n'avez pas la permission de planifier la publication de cette page.",
      });
    }
    const parsed = parseDateTimeInput(trimmedPublishAt);
    if (!parsed) {
      errors.push({
        code: "invalid_publish_at",
        message: "La date de publication planifiée est invalide.",
      });
    } else if (parsed.getTime() <= now.getTime()) {
      errors.push({
        code: "publish_at_in_past",
        message: "La date de publication doit être postérieure à l'instant présent.",
      });
    } else {
      publishAt = parsed.toISOString();
    }
  }

  return {
    status: PAGE_STATUS_SET.has(status) ? status : "published",
    publishAt,
    rawPublishAt: trimmedPublishAt,
    errors,
    isValid: errors.length === 0,
  };
}

export function isPublishedStatus(status, publishAt = null, { now = new Date() } = {}) {
  const normalizedStatus = normalizeStatusInput(status);
  if (normalizedStatus === "published") {
    return true;
  }
  if (normalizedStatus === "scheduled") {
    const parsed = parseDateTimeInput(
      publishAt instanceof Date ? publishAt.toISOString() : publishAt,
    );
    return Boolean(parsed && parsed.getTime() <= now.getTime());
  }
  return false;
}

export const PAGE_STATUS_VALUES = [...INTERNAL_PAGE_STATUS_VALUES];
