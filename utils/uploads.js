import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { all, get, run } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const uploadDir = path.join(__dirname, '..', 'public', 'uploads');

export async function ensureUploadDir() {
  await fs.mkdir(uploadDir, { recursive: true });
}

export function buildFilename(id, extension) {
  return `${id}${extension}`;
}

export async function recordUpload({ id, originalName, displayName, extension, size }) {
  await ensureUploadDir();
  await run(
    `INSERT INTO uploads(id, original_name, display_name, extension, size)
     VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       original_name=excluded.original_name,
       display_name=excluded.display_name,
       extension=excluded.extension,
       size=excluded.size`,
    [id, originalName, displayName, extension, size]
  );
}

export async function listUploads() {
  await ensureUploadDir();
  const entries = [];
  const seen = new Set();
  const rows = await all(
    'SELECT id, original_name, display_name, extension, size, created_at FROM uploads ORDER BY created_at DESC'
  );

  for (const row of rows) {
    const extension = row.extension || '';
    const filename = buildFilename(row.id, extension);
    if (!filename || filename.startsWith('.')) {
      continue;
    }
    const filePath = path.join(uploadDir, filename);
    try {
      const stat = await fs.stat(filePath);
      const createdAtIso = row.created_at
        ? new Date(row.created_at).toISOString()
        : new Date(stat.mtimeMs).toISOString();
      entries.push({
        id: row.id,
        filename,
        url: '/public/uploads/' + filename,
        originalName: row.original_name || filename,
        displayName: row.display_name || '',
        extension,
        size: stat.size,
        createdAt: createdAtIso,
        mtime: stat.mtimeMs
      });
      seen.add(filename);
      if (!row.size || row.size !== stat.size) {
        await run('UPDATE uploads SET size=? WHERE id=?', [stat.size, row.id]);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        await run('DELETE FROM uploads WHERE id=?', [row.id]);
      } else {
        throw err;
      }
    }
  }

  const files = await fs.readdir(uploadDir);
  for (const name of files) {
    if (name.startsWith('.')) continue;
    if (seen.has(name)) continue;
    const filePath = path.join(uploadDir, name);
    const stat = await fs.stat(filePath);
    const ext = path.extname(name).toLowerCase();
    const id = path.basename(name, ext);
    await run(
      'INSERT OR IGNORE INTO uploads(id, original_name, display_name, extension, size) VALUES(?,?,?,?,?)',
      [id, name, null, ext, stat.size]
    );
    entries.push({
      id,
      filename: name,
      url: '/public/uploads/' + name,
      originalName: name,
      displayName: '',
      extension: ext,
      size: stat.size,
      createdAt: new Date(stat.mtimeMs).toISOString(),
      mtime: stat.mtimeMs
    });
    seen.add(name);
  }

  entries.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return entries;
}

export async function removeUpload(id) {
  await ensureUploadDir();
  const row = await get('SELECT extension FROM uploads WHERE id=?', [id]);
  let filename = null;
  if (row && row.extension) {
    filename = buildFilename(id, row.extension);
  }

  if (!filename) {
    const files = await fs.readdir(uploadDir);
    filename = files.find((name) => !name.startsWith('.') && name.startsWith(id));
  }

  if (filename) {
    const filePath = path.join(uploadDir, filename);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await run('DELETE FROM uploads WHERE id=?', [id]);
}

export async function updateUploadName(id, displayName) {
  const row = await get('SELECT 1 FROM uploads WHERE id=?', [id]);
  if (!row) {
    return false;
  }
  await run('UPDATE uploads SET display_name=? WHERE id=?', [displayName, id]);
  return true;
}
