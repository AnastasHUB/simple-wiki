export const PAGE_SIZE_OPTIONS = [5, 10, 50, 100];
export const DEFAULT_PAGE_SIZE = 50;

export function resolvePageSize(
  rawValue,
  defaultSize = DEFAULT_PAGE_SIZE,
  allowedOptions = PAGE_SIZE_OPTIONS,
) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return defaultSize;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isInteger(parsed) && allowedOptions.includes(parsed)) {
    return parsed;
  }

  return defaultSize;
}

function firstQueryValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function buildQueryParams(query, exclude = []) {
  const params = new URLSearchParams();
  if (!query) {
    return params;
  }

  const excluded = new Set(exclude);
  for (const [key, rawValue] of Object.entries(query)) {
    if (excluded.has(key)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined || value === null || value === "") continue;
      params.append(key, String(value));
    }
  }

  return params;
}

export function buildPagination(req, totalItems, options = {}) {
  const {
    pageParam = "page",
    perPageParam = "perPage",
    defaultPageSize = DEFAULT_PAGE_SIZE,
    pageSizeOptions = PAGE_SIZE_OPTIONS,
  } = options;

  const query = req?.query || {};
  const requestedPageRaw = firstQueryValue(query[pageParam]);
  const requestedPage = Number.parseInt(requestedPageRaw, 10);
  let page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const perPage = resolvePageSize(
    firstQueryValue(query[perPageParam]),
    defaultPageSize,
    pageSizeOptions,
  );

  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

  if (page > totalPages) {
    page = totalPages;
  }

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return {
    page,
    perPage,
    totalItems,
    totalPages,
    hasPrevious,
    hasNext,
    previousPage: hasPrevious ? page - 1 : null,
    nextPage: hasNext ? page + 1 : null,
    perPageOptions: pageSizeOptions,
  };
}

export function decoratePagination(req, pagination, options = {}) {
  const { pageParam = "page", perPageParam = "perPage" } = options;
  const preservedQuery = [];
  if (req?.query) {
    for (const [key, rawValue] of Object.entries(req.query)) {
      if (key === pageParam || key === perPageParam) continue;
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value === undefined || value === null || value === "") continue;
        preservedQuery.push({ name: key, value: String(value) });
      }
    }
  }

  const baseParams = buildQueryParams(req?.query, [pageParam, perPageParam]);

  const buildUrl = (pageValue) => {
    const params = new URLSearchParams(baseParams.toString());
    params.set(pageParam, String(pageValue));
    params.set(perPageParam, String(pagination.perPage));
    return `?${params.toString()}`;
  };

  const perPageOptionLinks = pagination.perPageOptions.map((option) => {
    const params = new URLSearchParams(baseParams.toString());
    params.set(pageParam, "1");
    params.set(perPageParam, String(option));
    return {
      value: option,
      selected: option === pagination.perPage,
      url: `?${params.toString()}`,
    };
  });

  return {
    ...pagination,
    pageParam,
    perPageParam,
    previousUrl: pagination.hasPrevious
      ? buildUrl(pagination.previousPage)
      : null,
    nextUrl: pagination.hasNext ? buildUrl(pagination.nextPage) : null,
    perPageOptionLinks,
    preservedQuery,
  };
}

export function buildPaginationView(req, totalItems, options = {}) {
  const pagination = buildPagination(req, totalItems, options);
  return decoratePagination(req, pagination, options);
}
