import { all, get, run, savePageFts } from "../db.js";
import { generateSnowflake } from "./snowflake.js";
import {
  ROLE_FLAG_FIELDS,
  DEFAULT_ROLE_FLAGS,
} from "./roleFlags.js";
import { invalidateRoleCache } from "./roleService.js";

const DATA_PORTABILITY_VERSION = 1;

function normalizeBoolean(value) {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1" || trimmed === "yes" || trimmed === "on") {
      return true;
    }
    if (trimmed === "false" || trimmed === "0" || trimmed === "no" || trimmed === "off") {
      return false;
    }
  }
  return Boolean(value);
}

function normalizePermissions(raw = {}) {
  const normalized = { ...DEFAULT_ROLE_FLAGS };
  for (const field of ROLE_FLAG_FIELDS) {
    normalized[field] = normalizeBoolean(raw[field]);
  }
  return normalized;
}

function normalizeSelection(requested) {
  const allKeys = DATA_TYPE_DEFINITIONS.map((definition) => definition.key);
  if (requested == null) {
    return allKeys;
  }
  const values = Array.isArray(requested) ? requested : [requested];
  const normalized = new Set();
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const key = String(value).trim();
    if (!key) {
      continue;
    }
    if (key === "*" || key.toLowerCase() === "all" || key.toLowerCase() === "tout") {
      return allKeys;
    }
    if (DATA_TYPE_DEFINITION_MAP.has(key)) {
      normalized.add(key);
    }
  }
  if (!normalized.size) {
    return allKeys;
  }
  return allKeys.filter((key) => normalized.has(key));
}

async function exportSettings() {
  const row = await get(
    `SELECT snowflake_id, wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text, github_repo, github_changelog_mode
     FROM settings
     WHERE id=1`,
  );
  if (!row) {
    return { data: null, count: 0 };
  }
  return { data: row, count: 1 };
}

async function importSettings(payload) {
  if (!payload || typeof payload !== "object") {
    return { imported: 0 };
  }
  const fields = [
    "wiki_name",
    "logo_url",
    "admin_webhook_url",
    "feed_webhook_url",
    "footer_text",
    "github_repo",
    "github_changelog_mode",
  ];
  const assignments = fields.map((field) => `${field}=?`).join(", ");
  const values = fields.map((field) => {
    const value = payload[field];
    if (value == null) {
      return null;
    }
    return typeof value === "string" ? value : String(value);
  });
  await run(`UPDATE settings SET ${assignments} WHERE id=1`, values);
  return { imported: 1 };
}

async function exportRoles() {
  const rows = await all(
    `SELECT snowflake_id, name, description, color, is_system, position, created_at, updated_at, ${ROLE_FLAG_FIELDS.join(", ")}
     FROM roles
     ORDER BY position ASC, name COLLATE NOCASE`,
  );
  const roles = rows.map((row) => {
    const permissions = {};
    for (const field of ROLE_FLAG_FIELDS) {
      permissions[field] = Boolean(row[field]);
    }
    return {
      snowflake_id: row.snowflake_id || null,
      name: row.name,
      description: row.description || null,
      color: row.color || null,
      is_system: Boolean(row.is_system),
      position: typeof row.position === "number" ? row.position : Number.parseInt(row.position, 10) || 0,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      permissions,
    };
  });
  return { data: roles, count: roles.length };
}

async function importRoles(payload) {
  if (!Array.isArray(payload)) {
    return { imported: 0 };
  }
  let imported = 0;
  await run("BEGIN TRANSACTION");
  try {
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) {
        continue;
      }
      const snowflakeId =
        entry.snowflake_id && String(entry.snowflake_id).trim()
          ? String(entry.snowflake_id).trim()
          : null;
      const color = entry.color != null ? String(entry.color) : null;
      const description = entry.description != null ? String(entry.description) : null;
      const isSystem = normalizeBoolean(entry.is_system);
      const position = Number.isFinite(entry.position)
        ? Number(entry.position)
        : Number.parseInt(entry.position, 10) || 0;
      const permissions = normalizePermissions(entry.permissions);
      let existing = null;
      if (snowflakeId) {
        existing = await get(
          "SELECT id, snowflake_id FROM roles WHERE snowflake_id=?",
          [snowflakeId],
        );
      }
      if (!existing) {
        existing = await get(
          "SELECT id, snowflake_id FROM roles WHERE name=? COLLATE NOCASE",
          [name],
        );
      }
      if (existing) {
        const assignments = [
          "snowflake_id=?",
          "name=?",
          "description=?",
          "color=?",
          "is_system=?",
          "position=?",
          ...ROLE_FLAG_FIELDS.map((field) => `${field}=?`),
        ].join(", ");
        const flagValues = ROLE_FLAG_FIELDS.map((field) => (permissions[field] ? 1 : 0));
        await run(
          `UPDATE roles SET ${assignments} WHERE id=?`,
          [
            snowflakeId || existing.snowflake_id || generateSnowflake(),
            name,
            description,
            color,
            isSystem ? 1 : 0,
            position,
            ...flagValues,
            existing.id,
          ],
        );
      } else {
        const insertedSnowflake = snowflakeId || generateSnowflake();
        const columns = [
          "snowflake_id",
          "name",
          "description",
          "color",
          "is_system",
          "position",
          ...ROLE_FLAG_FIELDS,
        ];
        const placeholders = columns.map(() => "?").join(", ");
        const flagValues = ROLE_FLAG_FIELDS.map((field) => (permissions[field] ? 1 : 0));
        await run(
          `INSERT INTO roles(${columns.join(", ")}) VALUES(${placeholders})`,
          [
            insertedSnowflake,
            name,
            description,
            color,
            isSystem ? 1 : 0,
            position,
            ...flagValues,
          ],
        );
      }
      imported += 1;
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }
  invalidateRoleCache();
  return { imported };
}

async function exportUsers() {
  const rows = await all(
    `SELECT u.snowflake_id, u.username, u.password, u.display_name, u.role_id, ${ROLE_FLAG_FIELDS.join(", ")},
            r.snowflake_id AS role_snowflake_id
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     ORDER BY u.username COLLATE NOCASE`,
  );
  const users = rows.map((row) => {
    const permissions = {};
    for (const field of ROLE_FLAG_FIELDS) {
      permissions[field] = Boolean(row[field]);
    }
    return {
      snowflake_id: row.snowflake_id || null,
      username: row.username,
      password: row.password,
      display_name: row.display_name || null,
      role_snowflake_id: row.role_snowflake_id || null,
      permissions,
    };
  });
  return { data: users, count: users.length };
}

async function resolveRoleNumericId(roleSnowflakeId) {
  if (!roleSnowflakeId) {
    return null;
  }
  const trimmed = String(roleSnowflakeId).trim();
  if (!trimmed) {
    return null;
  }
  const row = await get("SELECT id FROM roles WHERE snowflake_id=?", [trimmed]);
  if (row?.id) {
    return row.id;
  }
  return null;
}

async function importUsers(payload) {
  if (!Array.isArray(payload)) {
    return { imported: 0 };
  }
  let imported = 0;
  await run("BEGIN TRANSACTION");
  try {
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const username = typeof entry.username === "string" ? entry.username.trim() : "";
      if (!username) {
        continue;
      }
      const snowflakeId =
        entry.snowflake_id && String(entry.snowflake_id).trim()
          ? String(entry.snowflake_id).trim()
          : null;
      const displayName = entry.display_name != null ? String(entry.display_name) : null;
      const hashedPassword = entry.password != null ? String(entry.password) : null;
      if (!hashedPassword) {
        continue;
      }
      const permissions = normalizePermissions(entry.permissions);
      const roleId = await resolveRoleNumericId(entry.role_snowflake_id);
      let existing = null;
      if (snowflakeId) {
        existing = await get(
          "SELECT id, snowflake_id, role_id FROM users WHERE snowflake_id=?",
          [snowflakeId],
        );
      }
      if (!existing) {
        existing = await get(
          "SELECT id, snowflake_id, role_id FROM users WHERE username=?",
          [username],
        );
      }
      const flagValues = ROLE_FLAG_FIELDS.map((field) => (permissions[field] ? 1 : 0));
      const resolvedRoleId =
        roleId != null ? roleId : existing?.role_id != null ? existing.role_id : null;
      if (existing) {
        const assignments = [
          "snowflake_id=?",
          "username=?",
          "password=?",
          "display_name=?",
          "role_id=?",
          ...ROLE_FLAG_FIELDS.map((field) => `${field}=?`),
        ].join(", ");
        await run(
          `UPDATE users SET ${assignments} WHERE id=?`,
          [
            snowflakeId || existing.snowflake_id || generateSnowflake(),
            username,
            hashedPassword,
            displayName,
            resolvedRoleId,
            ...flagValues,
            existing.id,
          ],
        );
      } else {
        const insertedSnowflake = snowflakeId || generateSnowflake();
        const columns = [
          "snowflake_id",
          "username",
          "password",
          "display_name",
          "role_id",
          ...ROLE_FLAG_FIELDS,
        ];
        const placeholders = columns.map(() => "?").join(", ");
        await run(
          `INSERT INTO users(${columns.join(", ")}) VALUES(${placeholders})`,
          [
            insertedSnowflake,
            username,
            hashedPassword,
            displayName,
            roleId,
            ...flagValues,
          ],
        );
      }
      imported += 1;
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }
  return { imported };
}

async function exportPages() {
  const rows = await all(
    `SELECT id, snowflake_id, slug_base, slug_id, title, content, author, created_at, updated_at
     FROM pages
     ORDER BY created_at ASC, id ASC`,
  );
  if (!rows.length) {
    return { data: [], count: 0 };
  }
  const pageById = new Map();
  for (const row of rows) {
    pageById.set(row.id, {
      snowflake_id: row.snowflake_id || null,
      slug_base: row.slug_base,
      slug_id: row.slug_id,
      title: row.title,
      content: row.content,
      author: row.author || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      tags: [],
      revisions: [],
    });
  }
  const tagRows = await all(
    `SELECT pt.page_id, t.name
     FROM page_tags pt
     JOIN tags t ON t.id = pt.tag_id`,
  );
  for (const tagRow of tagRows) {
    const page = pageById.get(tagRow.page_id);
    if (!page) {
      continue;
    }
    if (tagRow.name && !page.tags.includes(tagRow.name)) {
      page.tags.push(tagRow.name);
    }
  }
  const revisionRows = await all(
    `SELECT pr.page_id, pr.revision, pr.snowflake_id, pr.title, pr.content, pr.author_id, pr.created_at,
            u.snowflake_id AS author_snowflake_id
     FROM page_revisions pr
     LEFT JOIN users u ON u.id = pr.author_id
     ORDER BY pr.page_id ASC, pr.revision ASC`,
  );
  for (const revRow of revisionRows) {
    const page = pageById.get(revRow.page_id);
    if (!page) {
      continue;
    }
    page.revisions.push({
      revision: typeof revRow.revision === "number" ? revRow.revision : Number.parseInt(revRow.revision, 10) || 0,
      snowflake_id: revRow.snowflake_id || null,
      title: revRow.title,
      content: revRow.content,
      author_snowflake_id: revRow.author_snowflake_id || null,
      created_at: revRow.created_at || null,
    });
  }
  return { data: Array.from(pageById.values()), count: pageById.size };
}

async function resolveUserNumericId(userSnowflakeId) {
  if (!userSnowflakeId) {
    return null;
  }
  const trimmed = String(userSnowflakeId).trim();
  if (!trimmed) {
    return null;
  }
  const row = await get("SELECT id FROM users WHERE snowflake_id=?", [trimmed]);
  if (row?.id) {
    return row.id;
  }
  return null;
}

async function ensureTag(name) {
  if (!name) {
    return null;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  const existing = await get("SELECT id FROM tags WHERE name=?", [trimmed]);
  if (existing?.id) {
    return existing.id;
  }
  const result = await run(
    "INSERT INTO tags(snowflake_id, name) VALUES(?, ?)",
    [generateSnowflake(), trimmed],
  );
  return result?.lastID ?? null;
}

async function importPages(payload) {
  if (!Array.isArray(payload)) {
    return { imported: 0 };
  }
  let imported = 0;
  await run("BEGIN TRANSACTION");
  try {
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const slugId = typeof entry.slug_id === "string" ? entry.slug_id.trim() : "";
      if (!slugId) {
        continue;
      }
      const snowflakeId =
        entry.snowflake_id && String(entry.snowflake_id).trim()
          ? String(entry.snowflake_id).trim()
          : null;
      const slugBase =
        typeof entry.slug_base === "string" && entry.slug_base.trim()
          ? entry.slug_base.trim()
          : slugId;
      const title = typeof entry.title === "string" ? entry.title : slugId;
      const content = typeof entry.content === "string" ? entry.content : "";
      const author = entry.author != null ? String(entry.author) : null;
      const createdAt = entry.created_at || null;
      const updatedAt = entry.updated_at || createdAt || null;
      let existing = await get(
        "SELECT id, snowflake_id, created_at, updated_at FROM pages WHERE slug_id=?",
        [slugId],
      );
      let pageId;
      if (existing?.id) {
        const resolvedSnowflake = snowflakeId || existing.snowflake_id || generateSnowflake();
        const resolvedCreatedAt = createdAt || existing.created_at || null;
        const resolvedUpdatedAt = updatedAt || existing.updated_at || resolvedCreatedAt;
        await run(
          `UPDATE pages
           SET slug_base=?, title=?, content=?, author=?, created_at=?, updated_at=?, snowflake_id=?
           WHERE id=?`,
          [
            slugBase,
            title,
            content,
            author,
            resolvedCreatedAt,
            resolvedUpdatedAt,
            resolvedSnowflake,
            existing.id,
          ],
        );
        pageId = existing.id;
      } else {
        const insertedSnowflake = snowflakeId || generateSnowflake();
        const resolvedCreatedAt = createdAt || new Date().toISOString();
        const resolvedUpdatedAt = updatedAt || resolvedCreatedAt;
        const result = await run(
          `INSERT INTO pages(snowflake_id, slug_base, slug_id, title, content, author, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          [
            insertedSnowflake,
            slugBase,
            slugId,
            title,
            content,
            author,
            resolvedCreatedAt,
            resolvedUpdatedAt,
          ],
        );
        pageId = result?.lastID ?? null;
      }
      if (!pageId) {
        continue;
      }
      await run("DELETE FROM page_tags WHERE page_id=?", [pageId]);
      if (Array.isArray(entry.tags)) {
        for (const rawTag of entry.tags) {
          if (typeof rawTag !== "string") {
            continue;
          }
          const tagId = await ensureTag(rawTag);
          if (!tagId) {
            continue;
          }
          await run(
            "INSERT OR IGNORE INTO page_tags(page_id, tag_id, snowflake_id) VALUES(?,?,?)",
            [pageId, tagId, generateSnowflake()],
          );
        }
      }
      await run("DELETE FROM page_revisions WHERE page_id=?", [pageId]);
      if (Array.isArray(entry.revisions)) {
        let revisionIndex = 0;
        for (const revisionEntry of entry.revisions) {
          if (!revisionEntry || typeof revisionEntry !== "object") {
            continue;
          }
          let revisionNumber = Number.isFinite(revisionEntry.revision)
            ? Number(revisionEntry.revision)
            : Number.parseInt(revisionEntry.revision, 10) || 0;
          if (revisionNumber <= 0) {
            revisionNumber = revisionIndex + 1;
          }
          const revisionSnowflake =
            revisionEntry.snowflake_id && String(revisionEntry.snowflake_id).trim()
              ? String(revisionEntry.snowflake_id).trim()
              : generateSnowflake();
          const revisionTitle =
            typeof revisionEntry.title === "string" ? revisionEntry.title : title;
          const revisionContent =
            typeof revisionEntry.content === "string" ? revisionEntry.content : content;
          const revisionCreatedAt = revisionEntry.created_at || null;
          const authorId = await resolveUserNumericId(revisionEntry.author_snowflake_id);
          await run(
            `INSERT OR REPLACE INTO page_revisions(page_id, revision, snowflake_id, title, content, author_id, created_at)
             VALUES(?,?,?,?,?,?,?)`,
            [
              pageId,
              revisionNumber,
              revisionSnowflake,
              revisionTitle,
              revisionContent,
              authorId,
              revisionCreatedAt,
            ],
          );
          revisionIndex += 1;
        }
      }
      const tagList = Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [];
      await savePageFts({
        id: pageId,
        title,
        content,
        slug_id: slugId,
        tags: tagList.join(" "),
      });
      imported += 1;
    }
    await run("COMMIT");
  } catch (err) {
    await run("ROLLBACK");
    throw err;
  }
  return { imported };
}

const DATA_TYPE_DEFINITIONS = [
  {
    key: "settings",
    label: "Paramètres du site",
    description: "Configuration générale et intégrations.",
    exportData: exportSettings,
    importData: importSettings,
  },
  {
    key: "roles",
    label: "Rôles et permissions",
    description: "Définitions des rôles et de leurs autorisations.",
    exportData: exportRoles,
    importData: importRoles,
  },
  {
    key: "users",
    label: "Utilisateurs",
    description: "Comptes enregistrés et paramètres associés.",
    exportData: exportUsers,
    importData: importUsers,
  },
  {
    key: "pages",
    label: "Pages et révisions",
    description: "Contenus publiés, balises et historique.",
    exportData: exportPages,
    importData: importPages,
  },
];

const DATA_TYPE_DEFINITION_MAP = new Map(
  DATA_TYPE_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function listDataPortabilityTypes() {
  return DATA_TYPE_DEFINITIONS.map(({ key, label, description }) => ({
    key,
    label,
    description,
  }));
}

export async function exportDataPortability(requestedTypes = []) {
  const keys = normalizeSelection(requestedTypes);
  const payload = {};
  const summaries = [];
  for (const key of keys) {
    const definition = DATA_TYPE_DEFINITION_MAP.get(key);
    if (!definition) {
      continue;
    }
    const { data, count } = await definition.exportData();
    payload[key] = data;
    summaries.push({ key, count });
  }
  const exportedKeys = Object.keys(payload);
  const exportPayload = {
    version: DATA_PORTABILITY_VERSION,
    exported_at: new Date().toISOString(),
    types: exportedKeys,
    data: payload,
  };
  return { payload: exportPayload, summary: summaries };
}

export function parseImportPayload(buffer) {
  if (!buffer || !buffer.length) {
    throw new Error("Fichier d'import vide");
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    throw new Error("Le fichier fourni n'est pas un JSON valide");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Structure JSON inattendue");
  }
  if (parsed.version !== DATA_PORTABILITY_VERSION) {
    throw new Error(
      `Version d'export incompatible (attendue ${DATA_PORTABILITY_VERSION}, reçu ${parsed.version})`,
    );
  }
  if (!parsed.data || typeof parsed.data !== "object") {
    throw new Error("Aucune donnée à importer dans le fichier");
  }
  const data = parsed.data;
  const types = Array.isArray(parsed.types)
    ? parsed.types.filter((type) => typeof type === "string")
    : Object.keys(data);
  return { version: parsed.version, data, types };
}

export async function importDataPortability(parsedPayload, requestedTypes = []) {
  if (!parsedPayload || typeof parsedPayload !== "object") {
    throw new Error("Données d'import invalides");
  }
  const { data } = parsedPayload;
  if (!data || typeof data !== "object") {
    throw new Error("Aucune donnée d'import disponible");
  }
  const keys = normalizeSelection(requestedTypes);
  const processed = [];
  const skipped = [];
  for (const key of keys) {
    const definition = DATA_TYPE_DEFINITION_MAP.get(key);
    if (!definition) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      skipped.push({ key, reason: "absent" });
      continue;
    }
    const result = await definition.importData(data[key]);
    processed.push({ key, ...result });
  }
  return { processed, skipped };
}

export { DATA_PORTABILITY_VERSION };
