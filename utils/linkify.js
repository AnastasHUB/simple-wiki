export function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
export function linkifyInternal(content) {
  // [[slug-base]] -> /lookup/slug-base
  return content.replace(/\[\[([^\]]+)\]\]/g, (m, p1) => {
    const base = slugify(p1.trim());
    return `<a href="/lookup/${base}">${p1}</a>`;
  });
}
