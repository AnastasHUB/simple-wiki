const MAX_URL_LENGTH = 500;

export function isValidHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_err) {
    return false;
  }
}

export function normalizeHttpUrl(rawValue, { maxLength = MAX_URL_LENGTH, fieldName = "L'URL" } = {}) {
  if (typeof rawValue !== "string") {
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} est trop longue (maximum ${maxLength} caractères).`);
  }
  if (!isValidHttpUrl(trimmed)) {
    throw new Error(`${fieldName} doit commencer par http:// ou https://.`);
  }
  return trimmed;
}

export function normalizeStoredHttpUrl(rawValue) {
  if (typeof rawValue !== "string") {
    return "";
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  return isValidHttpUrl(trimmed) ? trimmed : "";
}
