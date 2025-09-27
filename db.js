import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { hashPassword } from "./utils/passwords.js";

let db;
export async function initDb() {
  if (db) {
    return db;
  }
  db = await open({ filename: "./data.sqlite", driver: sqlite3.Database });
  await db.exec(`
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS settings(
    id INTEGER PRIMARY KEY CHECK (id=1),
    wiki_name TEXT DEFAULT 'Wiki',
    logo_url TEXT DEFAULT '',
    admin_webhook_url TEXT DEFAULT '',
    feed_webhook_url TEXT DEFAULT '',
    footer_text TEXT DEFAULT ''
  );
  INSERT OR IGNORE INTO settings(id) VALUES(1);
  CREATE TABLE IF NOT EXISTS pages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug_base TEXT NOT NULL,
    slug_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
  CREATE TABLE IF NOT EXISTS tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS page_tags(
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY(page_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS likes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(page_id, ip)
  );
  CREATE TABLE IF NOT EXISTS uploads(
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    display_name TEXT,
    extension TEXT NOT NULL,
    size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  `);
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

export async function ensureDefaultAdmin() {
  await initDb();
  const admin = await db.get("SELECT 1 FROM users WHERE username=?", ["admin"]);
  if (!admin) {
    const hashed = await hashPassword("admin");
    await db.run(
      "INSERT INTO users(username,password,is_admin) VALUES(?,?,1)",
      ["admin", hashed],
    );
    console.log("Default admin created: admin / (mot de passe haché)");
  }
}

export function randSlugId(base) {
  const id = Math.random().toString(36).slice(2, 8);
  return `${base}-${id}`;
}

export async function incrementView(_id) {
  /* no-op placeholder for future */
}
