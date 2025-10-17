import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const uploadDir = path.join(__dirname, "..", "public", "uploads");
export const profilesDir = path.join(uploadDir, "profiles");

const MAX_DIMENSION = 1920;
const OPTIMIZE_FORMATS = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function normalizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function determineFormatFromMime(mimeType, fallbackExtension) {
  if (!mimeType)
    return (fallbackExtension || "").replace(".", "").toLowerCase();
  return (
    mimeType.split("/")[1]?.toLowerCase() ||
    (fallbackExtension || "").replace(".", "").toLowerCase()
  );
}

export async function ensureUploadDir() {
  await fs.mkdir(uploadDir, { recursive: true });
}

async function ensureProfilesDir() {
  await fs.mkdir(profilesDir, { recursive: true });
}

export function buildFilename(id, extension) {
  return `${id}${extension}`;
}

export async function optimizeUpload(filePath, mimeType, extension) {
  const normalizedMime = (mimeType || "").toLowerCase();
  if (!OPTIMIZE_FORMATS.has(normalizedMime)) return null;

  const metadata = await sharp(filePath).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  let transformer = sharp(filePath).rotate();
  let changed = false;

  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    transformer = transformer.resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });
    changed = true;
  }

  const format = determineFormatFromMime(normalizedMime, extension);
  switch (format) {
    case "jpeg":
    case "jpg":
      transformer = transformer.jpeg({
        quality: 80,
        mozjpeg: true,
        progressive: true,
      });
      changed = true;
      break;
    case "png":
      transformer = transformer.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
      });
      changed = true;
      break;
    case "webp":
      transformer = transformer.webp({ quality: 80, effort: 5 });
      changed = true;
      break;
    default:
      return null;
  }

  if (!changed) return null;

  const { data, info } = await transformer.toBuffer({
    resolveWithObject: true,
  });
  await fs.writeFile(filePath, data);
  return info.size;
}

export async function recordUpload({
  id,
  originalName,
  displayName,
  extension,
  size,
}) {
  await ensureUploadDir();
  const normalizedName = normalizeDisplayName(displayName);
  await run(
    `INSERT INTO uploads(id, snowflake_id, original_name, display_name, extension, size)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       original_name=excluded.original_name,
       display_name=excluded.display_name,
       extension=excluded.extension,
       size=excluded.size`,
    [id, generateSnowflake(), originalName, normalizedName, extension, size],
  );
}

export async function listUploads() {
  await ensureUploadDir();
  const entries = [];
  const seen = new Set();
  const rows = await all(
    "SELECT id, original_name, display_name, extension, size, created_at FROM uploads ORDER BY created_at DESC",
  );

  for (const row of rows) {
    const extension = row.extension || "";
    const filename = buildFilename(row.id, extension);
    if (
      !filename ||
      filename.startsWith(".") ||
      filename === "gitkeep" ||
      row.original_name === ".gitkeep"
    ) {
      if (filename === ".gitkeep" || row.original_name === ".gitkeep") {
        await run("DELETE FROM uploads WHERE id=?", [row.id]);
      }
      continue;
    }
    const filePath = path.join(uploadDir, filename);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        await run("DELETE FROM uploads WHERE id=?", [row.id]);
        continue;
      }
      const createdAtIso = row.created_at
        ? new Date(row.created_at).toISOString()
        : new Date(stat.mtimeMs).toISOString();
      entries.push({
        id: row.id,
        filename,
        url: "/public/uploads/" + filename,
        originalName: row.original_name || filename,
        displayName: row.display_name || "",
        extension,
        size: stat.size,
        createdAt: createdAtIso,
        mtime: stat.mtimeMs,
      });
      seen.add(filename);
      if (!row.size || row.size !== stat.size) {
        await run("UPDATE uploads SET size=? WHERE id=?", [stat.size, row.id]);
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        await run("DELETE FROM uploads WHERE id=?", [row.id]);
      } else {
        throw err;
      }
    }
  }

  const items = await fs.readdir(uploadDir, { withFileTypes: true });
  for (const dirent of items) {
    const name = dirent.name;
    if (name.startsWith(".")) continue;
    if (seen.has(name)) continue;
    const filePath = path.join(uploadDir, name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    const id = path.basename(name, ext);
    await run(
      "INSERT OR IGNORE INTO uploads(id, snowflake_id, original_name, display_name, extension, size) VALUES(?,?,?,?,?,?)",
      [id, generateSnowflake(), name, null, ext, stat.size],
    );
    entries.push({
      id,
      filename: name,
      url: "/public/uploads/" + name,
      originalName: name,
      displayName: "",
      extension: ext,
      size: stat.size,
      createdAt: new Date(stat.mtimeMs).toISOString(),
      mtime: stat.mtimeMs,
    });
    seen.add(name);
  }

  entries.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return entries;
}

export async function listProfileUploads() {
  await ensureUploadDir();
  await ensureProfilesDir();

  const entries = [];

  async function walk(currentDir) {
    const dirents = await fs.readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const { name } = dirent;
      if (name.startsWith(".")) continue;
      const fullPath = path.join(currentDir, name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      if (dirent.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = path.relative(uploadDir, fullPath);
      const normalizedRelativePath = relativePath.split(path.sep).join("/");
      entries.push({
        id: normalizedRelativePath,
        filename: name,
        url: "/public/uploads/" + normalizedRelativePath,
        relativePath: normalizedRelativePath,
        size: stat.size,
        createdAt: new Date(stat.mtimeMs).toISOString(),
        mtime: stat.mtimeMs,
      });
    }
  }

  await walk(profilesDir);

  entries.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return entries;
}

export async function removeUpload(id) {
  await ensureUploadDir();
  const row = await get("SELECT extension FROM uploads WHERE id=?", [id]);
  let filename = null;
  if (row && row.extension) {
    filename = buildFilename(id, row.extension);
  }

  if (!filename) {
    const files = await fs.readdir(uploadDir);
    filename = files.find(
      (name) => !name.startsWith(".") && name.startsWith(id),
    );
  }

  if (filename) {
    const filePath = path.join(uploadDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  await run("DELETE FROM uploads WHERE id=?", [id]);
}

export async function updateUploadName(id, displayName) {
  const normalizedName = normalizeDisplayName(displayName);
  const row = await get("SELECT 1 FROM uploads WHERE id=?", [id]);
  if (!row) return false;
  await run("UPDATE uploads SET display_name=? WHERE id=?", [
    normalizedName,
    id,
  ]);
  return true;
}
