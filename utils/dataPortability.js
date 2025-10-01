import { all, run } from "../db.js";

export const DATA_PORTABILITY_TYPES = Object.freeze([
  {
    key: "settings",
    label: "Paramètres du site",
    description:
      "Configuration générale du wiki (nom, logo, intégrations).",
    tables: [
      { name: "settings", orderBy: "id ASC" },
    ],
  },
  {
    key: "accounts",
    label: "Comptes et rôles",
    description:
      "Rôles, permissions et comptes utilisateurs associés.",
    tables: [
      { name: "roles", orderBy: "position DESC, id ASC" },
      { name: "users", orderBy: "id ASC" },
    ],
  },
  {
    key: "pages",
    label: "Pages et révisions",
    description:
      "Contenu publié, corbeille et historique des révisions.",
    tables: [
      { name: "pages", orderBy: "id ASC" },
      { name: "page_revisions", orderBy: "page_id ASC, revision ASC" },
      { name: "deleted_pages", orderBy: "id ASC" },
    ],
  },
  {
    key: "taxonomy",
    label: "Étiquettes",
    description: "Tags disponibles et associations avec les pages.",
    tables: [
      { name: "tags", orderBy: "id ASC" },
      { name: "page_tags", orderBy: "page_id ASC, tag_id ASC" },
    ],
  },
  {
    key: "feedback",
    label: "Commentaires et likes",
    description: "Interactions des visiteurs avec les contenus.",
    tables: [
      { name: "comments", orderBy: "id ASC" },
      { name: "likes", orderBy: "id ASC" },
    ],
  },
  {
    key: "submissions",
    label: "Contributions",
    description:
      "Brouillons et propositions de pages en attente ou traitées.",
    tables: [{ name: "page_submissions", orderBy: "id ASC" }],
  },
  {
    key: "moderation",
    label: "Modération IP",
    description:
      "Blocages IP, appels de déban et profils IP enrichis.",
    tables: [
      { name: "ip_bans", orderBy: "id ASC" },
      { name: "ban_appeals", orderBy: "id ASC" },
      { name: "ip_profiles", orderBy: "id ASC" },
    ],
  },
  {
    key: "events",
    label: "Journal d'événements",
    description: "Historique des notifications envoyées aux webhooks.",
    tables: [{ name: "event_logs", orderBy: "id ASC" }],
  },
  {
    key: "uploads",
    label: "Fichiers téléversés",
    description:
      "Métadonnées des fichiers présents dans la bibliothèque (hors contenu binaire).",
    tables: [{ name: "uploads", orderBy: "created_at ASC" }],
  },
]);

const DATA_PORTABILITY_TYPE_MAP = DATA_PORTABILITY_TYPES.reduce((acc, type) => {
  acc.set(type.key, type);
  return acc;
}, new Map());

function sanitizeRow(row) {
  if (!row || typeof row !== "object") {
    return {};
  }
  return Object.entries(row).reduce((acc, [key, value]) => {
    if (value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function uniqueKeys(keys = []) {
  const seen = new Set();
  const ordered = [];
  for (const key of keys) {
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

function getOrderedTypes(requestedKeys = []) {
  const allKeys = DATA_PORTABILITY_TYPES.map((type) => type.key);
  if (!requestedKeys || !requestedKeys.length) {
    return allKeys;
  }
  const requestedSet = new Set(requestedKeys);
  return allKeys.filter((key) => requestedSet.has(key));
}

async function exportTable({ name, orderBy = null }) {
  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : "";
  const rows = await all(`SELECT * FROM ${name}${orderClause}`);
  return rows.map((row) => sanitizeRow(row));
}

async function exportType(definition) {
  const tables = {};
  for (const table of definition.tables || []) {
    tables[table.name] = await exportTable(table);
  }
  return { tables };
}

function getDeclaredTypes(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const availableKeys = new Set(DATA_PORTABILITY_TYPES.map((type) => type.key));
  const explicitTypes = Array.isArray(payload.types)
    ? payload.types.filter((key) => availableKeys.has(key))
    : [];
  if (explicitTypes.length) {
    return uniqueKeys(explicitTypes);
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return uniqueKeys(
    Object.keys(data).filter((key) => availableKeys.has(key)),
  );
}

async function importType(definition, dataset = {}) {
  if (!definition || !dataset || typeof dataset !== "object") {
    return;
  }
  const tables = dataset.tables && typeof dataset.tables === "object"
    ? dataset.tables
    : {};
  for (const table of definition.tables || []) {
    const rows = tables[table.name];
    if (!Array.isArray(rows)) {
      continue;
    }
    await run(`DELETE FROM ${table.name}`);
    for (const rawRow of rows) {
      const row = sanitizeRow(rawRow);
      const entries = Object.entries(row);
      if (!entries.length) {
        continue;
      }
      const columns = entries.map(([column]) => column);
      const placeholders = columns.map(() => "?").join(", ");
      const values = entries.map(([, value]) => value);
      await run(
        `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${placeholders})`,
        values,
      );
    }
  }
}

export function listDataPortabilityTypes() {
  return DATA_PORTABILITY_TYPES.map((type) => ({
    key: type.key,
    label: type.label,
    description: type.description,
  }));
}

export function getDataPortabilityTypeKeys() {
  return DATA_PORTABILITY_TYPES.map((type) => type.key);
}

export async function exportDataPortabilityBundle(selectedTypes = []) {
  const orderedTypes = getOrderedTypes(selectedTypes);
  const data = {};
  for (const key of orderedTypes) {
    const definition = DATA_PORTABILITY_TYPE_MAP.get(key);
    if (!definition) {
      continue;
    }
    data[key] = await exportType(definition);
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    types: orderedTypes,
    data,
  };
}

export async function importDataPortabilityBundle(payload, options = {}) {
  const selected = Array.isArray(options.selectedTypes)
    ? uniqueKeys(options.selectedTypes)
    : [];
  const declaredTypes = getDeclaredTypes(payload);
  const data = payload && typeof payload === "object" && payload.data
    ? payload.data
    : {};
  const candidateSet = selected.length ? new Set(selected) : new Set(declaredTypes);
  const orderedTypes = getOrderedTypes(Array.from(candidateSet));
  const effectiveTypes = orderedTypes.filter(
    (key) => declaredTypes.includes(key) && data[key],
  );
  if (!effectiveTypes.length) {
    return {
      imported: [],
      skipped: declaredTypes.filter((key) => !candidateSet.has(key)),
      missing: selected.filter((key) => !declaredTypes.includes(key)),
      available: declaredTypes,
    };
  }
  await run("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const key of effectiveTypes) {
      const definition = DATA_PORTABILITY_TYPE_MAP.get(key);
      if (!definition) {
        continue;
      }
      await importType(definition, data[key]);
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }
  const skipped = declaredTypes.filter((key) => !effectiveTypes.includes(key));
  const missing = selected.filter((key) => !declaredTypes.includes(key));
  return {
    imported: effectiveTypes,
    skipped,
    missing,
    available: declaredTypes,
  };
}

export function resolveRequestedDataTypes(rawTypes, scope = "selected") {
  const allKeys = getDataPortabilityTypeKeys();
  if (scope === "all") {
    return allKeys;
  }
  const values = Array.isArray(rawTypes)
    ? rawTypes
    : typeof rawTypes === "string" && rawTypes
      ? [rawTypes]
      : [];
  const allowed = new Set(allKeys);
  return uniqueKeys(values.filter((key) => allowed.has(key)));
}
