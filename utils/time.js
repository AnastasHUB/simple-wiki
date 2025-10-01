export function formatSecondsAgo(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
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

export function formatRelativeDurationMs(milliseconds) {
  const safeMs = Number.isFinite(milliseconds) ? milliseconds : 0;
  const isFuture = safeMs < 0;
  const absSeconds = Math.floor(Math.abs(safeMs) / 1000);
  const prefix = isFuture ? "dans" : "il y a";
  if (absSeconds <= 0) {
    return isFuture ? "dans moins d’une seconde" : "il y a moins d’une seconde";
  }
  if (absSeconds < 60) {
    const unit = absSeconds === 1 ? "seconde" : "secondes";
    return `${prefix} ${absSeconds} ${unit}`;
  }
  if (absSeconds < 3600) {
    const minutes = Math.round(absSeconds / 60);
    const unit = minutes === 1 ? "minute" : "minutes";
    return `${prefix} ${minutes} ${unit}`;
  }
  if (absSeconds < 86400) {
    const hours = Math.round(absSeconds / 3600);
    const unit = hours === 1 ? "heure" : "heures";
    return `${prefix} ${hours} ${unit}`;
  }
  const days = Math.round(absSeconds / 86400);
  const unit = days === 1 ? "jour" : "jours";
  return `${prefix} ${days} ${unit}`;
}

export function formatDateTimeLocalized(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "full",
      timeStyle: "long",
    }).format(date);
  } catch (error) {
    return date.toISOString();
  }
}
