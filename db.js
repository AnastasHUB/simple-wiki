import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { hashPassword } from "./utils/passwords.js";
import { generateSnowflake } from "./utils/snowflake.js";

let db;
let ftsAvailable = null;
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
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_helper INTEGER NOT NULL DEFAULT 0,
    is_contributor INTEGER NOT NULL DEFAULT 0,
    can_comment INTEGER NOT NULL DEFAULT 0,
    can_submit_pages INTEGER NOT NULL DEFAULT 0,
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
  await ensureColumn("comments", "ip", "TEXT");
  await ensureColumn("comments", "updated_at", "DATETIME");
  await ensureColumn("comments", "edit_token", "TEXT");
  await ensureColumn("comments", "author_is_admin", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "display_name", "TEXT");
  await ensureColumn("users", "is_moderator", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_helper", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_contributor", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "can_comment", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "can_submit_pages", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "is_system", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "can_comment", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("roles", "can_submit_pages", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "role_id", "INTEGER REFERENCES roles(id)");
  await ensureColumn("ip_profiles", "reputation_status", "TEXT NOT NULL DEFAULT 'unknown'");
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
      is_admin: 0,
      is_moderator: 0,
      is_helper: 0,
      is_contributor: 0,
      can_comment: 1,
      can_submit_pages: 1,
    },
    {
      name: "Administrateur",
      description: "Accès complet à toutes les fonctionnalités.",
      is_system: 1,
      is_admin: 1,
      is_moderator: 0,
      is_helper: 0,
      is_contributor: 0,
      can_comment: 1,
      can_submit_pages: 1,
    },
    {
      name: "Modérateur",
      description: "Peut gérer les commentaires et les soumissions.",
      is_system: 1,
      is_admin: 0,
      is_moderator: 1,
      is_helper: 0,
      is_contributor: 0,
      can_comment: 1,
      can_submit_pages: 1,
    },
    {
      name: "Contributeur",
      description: "Peut publier des articles immédiatement.",
      is_system: 1,
      is_admin: 0,
      is_moderator: 0,
      is_helper: 0,
      is_contributor: 1,
      can_comment: 1,
      can_submit_pages: 1,
    },
    {
      name: "Helper",
      description: "Peut commenter sans modération.",
      is_system: 1,
      is_admin: 0,
      is_moderator: 0,
      is_helper: 1,
      is_contributor: 0,
      can_comment: 1,
      can_submit_pages: 1,
    },
    {
      name: "Utilisateur",
      description: "Accès standard sans permissions supplémentaires.",
      is_system: 1,
      is_admin: 0,
      is_moderator: 0,
      is_helper: 0,
      is_contributor: 0,
      can_comment: 1,
      can_submit_pages: 1,
    },
  ];

  for (const role of defaultRoles) {
    await db.run(
      `INSERT INTO roles(name, description, is_system, is_admin, is_moderator, is_helper, is_contributor, can_comment, can_submit_pages)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         description=excluded.description,
         is_system=excluded.is_system,
         is_admin=excluded.is_admin,
         is_moderator=excluded.is_moderator,
         is_helper=excluded.is_helper,
         is_contributor=excluded.is_contributor,
         can_comment=excluded.can_comment,
         can_submit_pages=excluded.can_submit_pages,
         updated_at=CURRENT_TIMESTAMP`,
      [
        role.name,
        role.description,
        role.is_system || 0,
        role.is_admin,
        role.is_moderator,
        role.is_helper,
        role.is_contributor,
        role.can_comment || 0,
        role.can_submit_pages || 0,
      ],
    );
  }
}

async function synchronizeUserRoles() {
  const roles = await db.all(
    "SELECT id, name, is_admin, is_moderator, is_helper, is_contributor, can_comment, can_submit_pages FROM roles",
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
    await db.run(
      "UPDATE users SET role_id=? WHERE role_id IS NULL",
      [userRoleId],
    );
  }

  for (const role of roles) {
    await db.run(
      "UPDATE users SET is_admin=?, is_moderator=?, is_helper=?, is_contributor=?, can_comment=?, can_submit_pages=? WHERE role_id=?",
      [
        role.is_admin ? 1 : 0,
        role.is_moderator ? 1 : 0,
        role.is_helper ? 1 : 0,
        role.is_contributor ? 1 : 0,
        role.can_comment ? 1 : 0,
        role.can_submit_pages ? 1 : 0,
        role.id,
      ],
    );
  }
}

export async function ensureDefaultAdmin() {
  await initDb();
  const admin = await db.get("SELECT 1 FROM users WHERE username=?", ["admin"]);
  if (!admin) {
    const hashed = await hashPassword("admin");
    const adminRole =
      (await db.get(
        "SELECT id, is_admin, is_moderator, is_helper, is_contributor, can_comment, can_submit_pages FROM roles WHERE is_admin=1 LIMIT 1",
      )) || {
        id: null,
        is_admin: 1,
        is_moderator: 0,
        is_helper: 0,
        is_contributor: 0,
        can_comment: 1,
        can_submit_pages: 1,
      };
    await db.run(
      "INSERT INTO users(snowflake_id, username, password, role_id, is_admin, is_moderator, is_helper, is_contributor, can_comment, can_submit_pages) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        generateSnowflake(),
        "admin",
        hashed,
        adminRole.id,
        adminRole.is_admin ? 1 : 0,
        adminRole.is_moderator ? 1 : 0,
        adminRole.is_helper ? 1 : 0,
        adminRole.is_contributor ? 1 : 0,
        adminRole.can_comment ? 1 : 0,
        adminRole.can_submit_pages ? 1 : 0,
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
    await run("INSERT INTO page_views(snowflake_id, page_id, ip) VALUES(?,?,?)", [
      generateSnowflake(),
      pageId,
      ip || null,
    ]);
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

export async function savePageFts({
  id,
  title,
  content,
  slug_id,
  tags = "",
}) {
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
