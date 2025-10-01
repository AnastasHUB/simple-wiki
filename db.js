import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { hashPassword } from "./utils/passwords.js";
import { generateSnowflake } from "./utils/snowflake.js";
import {
  ROLE_FLAG_FIELDS,
  DEFAULT_ROLE_FLAGS,
  getRoleFlagValues,
} from "./utils/roleFlags.js";

let db;
let ftsAvailable = null;
const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");
const ROLE_FLAG_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");
const ROLE_FLAG_UPDATE_ASSIGNMENTS = ROLE_FLAG_FIELDS.map(
  (field) => `${field}=excluded.${field}`,
).join(", ");
const ROLE_FLAG_USER_ASSIGNMENTS = ROLE_FLAG_FIELDS.map(
  (field) => `${field}=?`,
).join(", ");
const ALL_ROLE_FLAGS_TRUE = ROLE_FLAG_FIELDS.reduce((acc, field) => {
  acc[field] = true;
  return acc;
}, {});
export async function initDb() {
  if (db) {
    return db;
  }
  db = await open({ filename: "./data.sqlite", driver: sqlite3.Database });
  await db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS roles(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_helper INTEGER NOT NULL DEFAULT 0,
    is_contributor INTEGER NOT NULL DEFAULT 0,
    can_comment INTEGER NOT NULL DEFAULT 0,
    can_submit_pages INTEGER NOT NULL DEFAULT 0,
    can_moderate_comments INTEGER NOT NULL DEFAULT 0,
    can_review_ban_appeals INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_bans INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_reputation INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_profiles INTEGER NOT NULL DEFAULT 0,
    can_review_submissions INTEGER NOT NULL DEFAULT 0,
    can_manage_pages INTEGER NOT NULL DEFAULT 0,
    can_view_stats INTEGER NOT NULL DEFAULT 0,
    can_manage_uploads INTEGER NOT NULL DEFAULT 0,
    can_manage_settings INTEGER NOT NULL DEFAULT 0,
    can_manage_roles INTEGER NOT NULL DEFAULT 0,
    can_manage_users INTEGER NOT NULL DEFAULT 0,
    can_manage_likes INTEGER NOT NULL DEFAULT 0,
    can_manage_trash INTEGER NOT NULL DEFAULT 0,
    can_view_events INTEGER NOT NULL DEFAULT 0,
    can_view_snowflakes INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_helper INTEGER NOT NULL DEFAULT 0,
    is_contributor INTEGER NOT NULL DEFAULT 0,
    can_comment INTEGER NOT NULL DEFAULT 0,
    can_submit_pages INTEGER NOT NULL DEFAULT 0,
    can_moderate_comments INTEGER NOT NULL DEFAULT 0,
    can_review_ban_appeals INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_bans INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_reputation INTEGER NOT NULL DEFAULT 0,
    can_manage_ip_profiles INTEGER NOT NULL DEFAULT 0,
    can_review_submissions INTEGER NOT NULL DEFAULT 0,
    can_manage_pages INTEGER NOT NULL DEFAULT 0,
    can_view_stats INTEGER NOT NULL DEFAULT 0,
    can_manage_uploads INTEGER NOT NULL DEFAULT 0,
    can_manage_settings INTEGER NOT NULL DEFAULT 0,
    can_manage_roles INTEGER NOT NULL DEFAULT 0,
    can_manage_users INTEGER NOT NULL DEFAULT 0,
    can_manage_likes INTEGER NOT NULL DEFAULT 0,
    can_manage_trash INTEGER NOT NULL DEFAULT 0,
    can_view_events INTEGER NOT NULL DEFAULT 0,
    can_view_snowflakes INTEGER NOT NULL DEFAULT 0,
    role_id INTEGER REFERENCES roles(id)
  );
  CREATE TABLE IF NOT EXISTS settings(
    id INTEGER PRIMARY KEY CHECK (id=1),
    snowflake_id TEXT UNIQUE,
    wiki_name TEXT DEFAULT 'Wiki',
    logo_url TEXT DEFAULT '',
    admin_webhook_url TEXT DEFAULT '',
    feed_webhook_url TEXT DEFAULT '',
    footer_text TEXT DEFAULT ''
  );
  INSERT OR IGNORE INTO settings(id) VALUES(1);
  CREATE TABLE IF NOT EXISTS pages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    slug_base TEXT NOT NULL,
    slug_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS deleted_pages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    original_page_id INTEGER,
    page_snowflake_id TEXT,
    slug_id TEXT NOT NULL,
    slug_base TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT,
    created_at DATETIME,
    updated_at DATETIME,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_by TEXT,
    UNIQUE(slug_id)
  );
  CREATE TABLE IF NOT EXISTS page_revisions(
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    snowflake_id TEXT UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author_id INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(page_id, revision)
  );
  CREATE TABLE IF NOT EXISTS page_views(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ip TEXT,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_page_views_page ON page_views(page_id);
  CREATE INDEX IF NOT EXISTS idx_page_views_page_date ON page_views(page_id, viewed_at);
  CREATE TABLE IF NOT EXISTS ip_profiles(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    ip TEXT UNIQUE NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS page_view_daily(
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    snowflake_id TEXT UNIQUE,
    views INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(page_id, day)
  );
  CREATE TABLE IF NOT EXISTS tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS page_tags(
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    snowflake_id TEXT UNIQUE,
    PRIMARY KEY(page_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS likes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(page_id, ip)
  );
  CREATE TABLE IF NOT EXISTS comments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    author TEXT,
    body TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    ip TEXT,
    edit_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','rejected'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_page_status
    ON comments(page_id, status);
  CREATE TABLE IF NOT EXISTS page_submissions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    target_slug_id TEXT,
    type TEXT NOT NULL CHECK(type IN ('create','edit')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','approved','rejected')),
    ip TEXT,
    submitted_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewer_id INTEGER REFERENCES users(id),
    review_note TEXT,
    reviewed_at DATETIME,
    result_slug_id TEXT
  );
  CREATE TABLE IF NOT EXISTS ip_bans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    ip TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('global','action','tag')),
    value TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    lifted_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_ip_bans_active
    ON ip_bans(ip, scope, value, lifted_at);
  CREATE TABLE IF NOT EXISTS ban_appeals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    ip TEXT,
    scope TEXT,
    value TEXT,
    reason TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','accepted','rejected')),
    resolved_at DATETIME,
    resolved_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS event_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snowflake_id TEXT UNIQUE,
    channel TEXT NOT NULL CHECK(channel IN ('admin','feed')),
    type TEXT NOT NULL,
    payload TEXT,
    ip TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS uploads(
    id TEXT PRIMARY KEY,
    snowflake_id TEXT UNIQUE,
    original_name TEXT NOT NULL,
    display_name TEXT,
    extension TEXT NOT NULL,
    size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  `);
  await ensureFts();
  await ensureColumn("deleted_pages", "comments_json", "TEXT");
  await ensureColumn("deleted_pages", "stats_json", "TEXT");
  await ensureColumn("settings", "github_repo", "TEXT DEFAULT ''");
  await ensureColumn(
    "settings",
    "github_changelog_mode",
    "TEXT NOT NULL DEFAULT 'commits'",
  );
  await ensureColumn("comments", "ip", "TEXT");
  await ensureColumn("comments", "updated_at", "DATETIME");
  await ensureColumn("comments", "edit_token", "TEXT");
  await ensureColumn(
    "comments",
    "author_is_admin",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn("users", "display_name", "TEXT");
  await ensureColumn("users", "is_moderator", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_helper", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_contributor", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "can_comment", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "can_submit_pages", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(
    "users",
    "can_moderate_comments",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_review_ban_appeals",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_ip_bans",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_ip_reputation",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_ip_profiles",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_review_submissions",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_pages",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_view_stats",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_uploads",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_settings",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_roles",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_users",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_likes",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_manage_trash",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_view_events",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "users",
    "can_view_snowflakes",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn("roles", "is_system", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "position", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "can_comment", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "can_submit_pages", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(
    "roles",
    "can_moderate_comments",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_review_ban_appeals",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_ip_bans",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_ip_reputation",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_ip_profiles",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_review_submissions",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_pages",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_view_stats",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_uploads",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_settings",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_roles",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_users",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_likes",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_manage_trash",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_view_events",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    "roles",
    "can_view_snowflakes",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureRolePositions();
  await ensureColumn("users", "role_id", "INTEGER REFERENCES roles(id)");
  await ensureColumn(
    "ip_profiles",
    "reputation_status",
    "TEXT NOT NULL DEFAULT 'unknown'",
  );
  await ensureColumn(
    "ip_profiles",
    "reputation_auto_status",
    "TEXT NOT NULL DEFAULT 'unknown'",
  );
  await ensureColumn("ip_profiles", "reputation_override", "TEXT");
  await ensureColumn("ip_profiles", "reputation_summary", "TEXT");
  await ensureColumn("ip_profiles", "reputation_details", "TEXT");
  await ensureColumn("ip_profiles", "reputation_checked_at", "DATETIME");
  await ensureColumn("ip_profiles", "is_vpn", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("ip_profiles", "is_proxy", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(
    "ip_profiles",
    "is_datacenter",
    "INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn("ip_profiles", "is_abuser", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("ip_profiles", "is_tor", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("ip_profiles", "last_user_agent", "TEXT");
  await ensureColumn("ip_profiles", "is_bot", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("ip_profiles", "bot_reason", "TEXT");
  await ensureColumn(
    "ban_appeals",
    "status",
    "TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected'))",
  );
  await ensureColumn("ban_appeals", "resolved_at", "DATETIME");
  await ensureColumn("ban_appeals", "resolved_by", "TEXT");
  await ensureSnowflake("settings");
  await ensureSnowflake("roles");
  await ensureSnowflake("users");
  await ensureSnowflake("pages");
  await ensureSnowflake("deleted_pages");
  await ensureSnowflake("page_revisions");
  await ensureSnowflake("page_views");
  await ensureSnowflake("page_view_daily");
  await ensureSnowflake("tags");
  await ensureSnowflake("page_tags");
  await ensureSnowflake("likes");
  await ensureSnowflake("comments");
  await ensureSnowflake("page_submissions");
  await ensureSnowflake("ip_bans");
  await ensureSnowflake("ban_appeals");
  await ensureSnowflake("ip_profiles");
  await ensureSnowflake("event_logs");
  await ensureSnowflake("uploads", "snowflake_id");
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_ban_appeals_pending_ip ON ban_appeals(ip) WHERE ip IS NOT NULL AND status='pending'",
  );
  await ensureDefaultRoles();
  await synchronizeUserRoles();
  return db;
}

export async function get(sql, params = []) {
  return db.get(sql, params);
}
export async function all(sql, params = []) {
  return db.all(sql, params);
}
export async function run(sql, params = []) {
  return db.run(sql, params);
}

async function ensureColumn(table, column, definition) {
  const info = await db.all(`PRAGMA table_info(${table})`);
  if (!info.find((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureSnowflake(table, column = "snowflake_id") {
  const info = await db.all(`PRAGMA table_info(${table})`);
  if (!info.find((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  const rows = await db.all(
    `SELECT rowid AS rid FROM ${table} WHERE ${column} IS NULL OR ${column}=''`,
  );
  for (const row of rows) {
    await db.run(`UPDATE ${table} SET ${column}=? WHERE rowid=?`, [
      generateSnowflake(),
      row.rid,
    ]);
  }
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`,
  );
}

async function ensureRolePositions() {
  const roles = await db.all(
    "SELECT id, position FROM roles ORDER BY position ASC, name COLLATE NOCASE",
  );
  if (!roles.length) {
    return;
  }
  let needsUpdate = false;
  let expected = 1;
  for (const role of roles) {
    const position = Number.parseInt(role.position, 10);
    if (!Number.isInteger(position) || position < 1 || position !== expected) {
      needsUpdate = true;
      break;
    }
    expected += 1;
  }
  if (!needsUpdate) {
    return;
  }
  const alphabetical = await db.all(
    "SELECT id FROM roles ORDER BY name COLLATE NOCASE",
  );
  let index = 1;
  for (const role of alphabetical) {
    await db.run("UPDATE roles SET position=? WHERE id=?", [index, role.id]);
    index += 1;
  }
}

function buildRoleFlags(overrides = {}) {
  const flags = { ...DEFAULT_ROLE_FLAGS };
  for (const field of ROLE_FLAG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) {
      flags[field] = Boolean(overrides[field]);
    }
  }
  return flags;
}

async function ensureDefaultRoles() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS roles(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snowflake_id TEXT UNIQUE,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_moderator INTEGER NOT NULL DEFAULT 0,
      is_helper INTEGER NOT NULL DEFAULT 0,
      is_contributor INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
  `);
  await ensureColumn("users", "role_id", "INTEGER REFERENCES roles(id)");

  const defaultRoles = [
    {
      name: "Everyone",
      description: "Permissions de base accordées à tous les visiteurs.",
      is_system: 1,
      flags: buildRoleFlags({
        can_comment: true,
        can_submit_pages: true,
      }),
    },
    {
      name: "Administrateur",
      description: "Accès complet à toutes les fonctionnalités.",
      is_system: 1,
      flags: buildRoleFlags(ALL_ROLE_FLAGS_TRUE),
    },
    {
      name: "Modérateur",
      description: "Peut gérer les commentaires et les soumissions.",
      is_system: 1,
      flags: buildRoleFlags({
        is_moderator: true,
        can_comment: true,
        can_submit_pages: true,
        can_moderate_comments: true,
        can_review_submissions: true,
        can_review_ban_appeals: true,
        can_manage_likes: true,
        can_manage_trash: true,
        can_view_stats: true,
      }),
    },
    {
      name: "Contributeur",
      description: "Peut publier des articles immédiatement.",
      is_system: 1,
      flags: buildRoleFlags({
        is_contributor: true,
        can_comment: true,
        can_submit_pages: true,
      }),
    },
    {
      name: "Helper",
      description: "Peut commenter sans modération.",
      is_system: 1,
      flags: buildRoleFlags({
        is_helper: true,
        can_comment: true,
        can_submit_pages: true,
      }),
    },
    {
      name: "Utilisateur",
      description: "Accès standard sans permissions supplémentaires.",
      is_system: 1,
      flags: buildRoleFlags({
        can_comment: true,
        can_submit_pages: true,
      }),
    },
  ].map((role, index) => ({ ...role, position: index + 1 }));

  for (const role of defaultRoles) {
    await db.run(
      `INSERT INTO roles(name, description, is_system, position, ${ROLE_FLAG_COLUMN_LIST})
       VALUES(?,?,?,?,${ROLE_FLAG_PLACEHOLDERS})
       ON CONFLICT(name) DO UPDATE SET
         description=excluded.description,
         is_system=excluded.is_system,
         ${ROLE_FLAG_UPDATE_ASSIGNMENTS},
         updated_at=CURRENT_TIMESTAMP`,
      [
        role.name,
        role.description,
        role.is_system || 0,
        role.position,
        ...getRoleFlagValues(role.flags),
      ],
    );
  }
}

async function synchronizeUserRoles() {
  const roles = await db.all(
    `SELECT id, name, ${ROLE_FLAG_COLUMN_LIST} FROM roles`,
  );
  if (!roles.length) {
    return;
  }

  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const adminRoleId = roleByName.get("Administrateur")?.id ?? null;
  const moderatorRoleId = roleByName.get("Modérateur")?.id ?? null;
  const contributorRoleId = roleByName.get("Contributeur")?.id ?? null;
  const helperRoleId = roleByName.get("Helper")?.id ?? null;
  const userRoleId = roleByName.get("Utilisateur")?.id ?? null;

  if (adminRoleId) {
    await db.run(
      "UPDATE users SET role_id=? WHERE role_id IS NULL AND is_admin=1",
      [adminRoleId],
    );
  }
  if (moderatorRoleId) {
    await db.run(
      "UPDATE users SET role_id=? WHERE role_id IS NULL AND is_admin=0 AND is_moderator=1",
      [moderatorRoleId],
    );
  }
  if (contributorRoleId) {
    await db.run(
      "UPDATE users SET role_id=? WHERE role_id IS NULL AND is_admin=0 AND is_moderator=0 AND is_contributor=1",
      [contributorRoleId],
    );
  }
  if (helperRoleId) {
    await db.run(
      "UPDATE users SET role_id=? WHERE role_id IS NULL AND is_admin=0 AND is_moderator=0 AND is_contributor=0 AND is_helper=1",
      [helperRoleId],
    );
  }
  if (userRoleId) {
    await db.run("UPDATE users SET role_id=? WHERE role_id IS NULL", [
      userRoleId,
    ]);
  }

  for (const role of roles) {
    const flagValues = ROLE_FLAG_FIELDS.map((field) =>
      role[field] ? 1 : 0,
    );
    await db.run(
      `UPDATE users SET ${ROLE_FLAG_USER_ASSIGNMENTS} WHERE role_id=?`,
      [...flagValues, role.id],
    );
  }
}

export async function ensureDefaultAdmin() {
  await initDb();
  const admin = await db.get("SELECT 1 FROM users WHERE username=?", ["admin"]);
  if (!admin) {
    const hashed = await hashPassword("admin");
    const adminRoleRow =
      (await db.get(
        `SELECT id, ${ROLE_FLAG_COLUMN_LIST} FROM roles WHERE is_admin=1 LIMIT 1`,
      )) || null;
    const adminRoleFlags = adminRoleRow
      ? ROLE_FLAG_FIELDS.reduce((acc, field) => {
          acc[field] = Boolean(adminRoleRow[field]);
          return acc;
        }, {})
      : buildRoleFlags(ALL_ROLE_FLAGS_TRUE);
    const adminRoleId = adminRoleRow?.id ?? null;
    await db.run(
      `INSERT INTO users(snowflake_id, username, password, role_id, ${ROLE_FLAG_COLUMN_LIST}) VALUES(?,?,?,?,${ROLE_FLAG_PLACEHOLDERS})`,
      [
        generateSnowflake(),
        "admin",
        hashed,
        adminRoleId,
        ...getRoleFlagValues(adminRoleFlags),
      ],
    );
    console.log("Default admin created: admin / (mot de passe haché)");
  }
}

export function randId() {
  return generateSnowflake();
}

export const randSlugId = randId;

export async function incrementView(pageId, ip = null) {
  if (!pageId) return;
  try {
    await run(
      "INSERT INTO page_views(snowflake_id, page_id, ip) VALUES(?,?,?)",
      [generateSnowflake(), pageId, ip || null],
    );
  } catch (err) {
    console.error("Unable to record page view", err);
  }
}

async function ensureFts() {
  if (ftsAvailable !== null) {
    return;
  }
  try {
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        title,
        content,
        tags,
        slug_id UNINDEXED
      );
    `);
    ftsAvailable = true;
    await rebuildPagesFts();
  } catch (err) {
    ftsAvailable = false;
    console.warn("FTS index disabled (fts5 unavailable?)", err.message);
  }
}

async function rebuildPagesFts() {
  if (!ftsAvailable) return;
  try {
    const pages = await db.all(`
      SELECT p.id, p.title, p.content, p.slug_id,
             COALESCE((
               SELECT GROUP_CONCAT(t.name, ' ')
               FROM tags t
               JOIN page_tags pt ON pt.tag_id = t.id
               WHERE pt.page_id = p.id
             ), '') AS tags
      FROM pages p
    `);
    await db.exec("DELETE FROM pages_fts;");
    for (const page of pages) {
      await db.run(
        "INSERT INTO pages_fts(rowid, title, content, tags, slug_id) VALUES(?,?,?,?,?)",
        [page.id, page.title, page.content, page.tags || "", page.slug_id],
      );
    }
  } catch (err) {
    console.warn("Unable to rebuild FTS index", err);
  }
}

export function isFtsAvailable() {
  return !!ftsAvailable;
}

export async function savePageFts({ id, title, content, slug_id, tags = "" }) {
  if (!ftsAvailable || !id) return;
  try {
    await db.run("DELETE FROM pages_fts WHERE rowid=?", [id]);
    await db.run(
      "INSERT INTO pages_fts(rowid, title, content, tags, slug_id) VALUES(?,?,?,?,?)",
      [id, title || "", content || "", tags || "", slug_id || null],
    );
  } catch (err) {
    console.warn("Unable to upsert page in FTS index", err);
  }
}

export async function removePageFts(id) {
  if (!ftsAvailable || !id) return;
  try {
    await db.run("DELETE FROM pages_fts WHERE rowid=?", [id]);
  } catch (err) {
    console.warn("Unable to delete page from FTS index", err);
  }
}

export async function logEvent({
  channel,
  type,
  payload = null,
  ip = null,
  username = null,
}) {
  if (!channel || !type) return;
  try {
    await run(
      "INSERT INTO event_logs(snowflake_id, channel, type, payload, ip, username) VALUES(?,?,?,?,?,?)",
      [
        generateSnowflake(),
        channel,
        type,
        payload ? JSON.stringify(payload) : null,
        ip,
        username,
      ],
    );
  } catch (err) {
    console.warn("Unable to log event", err?.message || err);
  }
}
