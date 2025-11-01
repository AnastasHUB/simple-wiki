export function formatSecondsAgo(seconds) {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : 0;
  if (safeSeconds < 60) {
    return `${safeSeconds}s`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 min" : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 h" : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 j" : `${days} j`;
}

export function formatRelativeDurationMs(milliseconds, lang = "fr") {
  const safeMs = Number.isFinite(milliseconds) ? milliseconds : 0;
  const isFuture = safeMs < 0;
  const absSeconds = Math.floor(Math.abs(safeMs) / 1000);
  const isEn = lang === "en";
  const prefix = isEn ? (isFuture ? "in" : "") : isFuture ? "dans" : "il y a";
  const join = (n, unit) => (isEn ? `${prefix ? prefix + " " : ""}${n} ${unit}${n === 1 ? "" : "s"}${isFuture || !prefix ? "" : ""}` : `${prefix} ${n} ${unit}`);
  if (absSeconds <= 0) {
    return isEn ? (isFuture ? "in less than a second" : "less than a second ago") : (isFuture ? "dans moins d’une seconde" : "il y a moins d’une seconde");
  }
  if (absSeconds < 60) {
    return join(absSeconds, isEn ? "second" : absSeconds === 1 ? "seconde" : "secondes");
  }
  if (absSeconds < 3600) {
    const minutes = Math.round(absSeconds / 60);
    return join(minutes, isEn ? "minute" : minutes === 1 ? "minute" : "minutes");
  }
  if (absSeconds < 86400) {
    const hours = Math.round(absSeconds / 3600);
    return join(hours, isEn ? "hour" : hours === 1 ? "heure" : "heures");
  }
  const days = Math.round(absSeconds / 86400);
  return join(days, isEn ? "day" : days === 1 ? "jour" : "jours");
}

// Formats a date using the provided language ("en" | "fr").
// Falls back to ISO string on failure.
export function formatDate(date, lang = "fr", options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const locale = lang === "en" ? "en-US" : "fr-FR";
  const fmtOptions = {
    dateStyle: "medium",
    ...(options || {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, fmtOptions).format(date);
  } catch (_err) {
    return date.toISOString();
  }
}

export function formatDateTime(date, lang = "fr", options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const locale = lang === "en" ? "en-US" : "fr-FR";
  const fmtOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options || {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, fmtOptions).format(date);
  } catch (_err) {
    return date.toISOString();
  }
}

// Backward-compatible helper (default FR). Prefer formatDate/formatDateTime with lang.
export function formatDateTimeLocalized(date, lang = "fr") {
  return formatDateTime(date, lang, { dateStyle: "full", timeStyle: "long" });
}
