export const PAGE_SIZE_OPTIONS = [5, 10, 50, 100, 500];
export const DEFAULT_PAGE_SIZE = 10;

export function resolvePageSize(rawValue, defaultSize = DEFAULT_PAGE_SIZE) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return defaultSize;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isInteger(parsed) && PAGE_SIZE_OPTIONS.includes(parsed)) {
    return parsed;
  }

  return defaultSize;
}
