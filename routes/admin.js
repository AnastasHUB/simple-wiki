import fs from 'fs/promises';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'crypto';
import { requireAdmin } from '../middleware/auth.js';
import { all, get, run } from '../db.js';
import {
  uploadDir,
  ensureUploadDir,
  recordUpload,
  listUploads,
  removeUpload,
  updateUploadName,
  optimizeUpload
} from '../utils/uploads.js';

await ensureUploadDir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const id = randomUUID();
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non supporté'));
    }
  }
});

const r = Router();

r.use(requireAdmin);

r.post('/uploads', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Aucun fichier reçu' });
    }
    const ext = path.extname(req.file.filename).toLowerCase();
    const id = path.basename(req.file.filename, ext);
    const displayName = normalizeDisplayName(req.body?.displayName);
    const filePath = path.join(uploadDir, req.file.filename);
    let finalSize = req.file.size;
    try {
      const optimizedSize = await optimizeUpload(filePath, req.file.mimetype, ext);
      if (optimizedSize) {
        finalSize = optimizedSize;
      } else {
        const stat = await fs.stat(filePath);
        finalSize = stat.size;
      }
    } catch (optimizationError) {
      try {
        const stat = await fs.stat(filePath);
        finalSize = stat.size;
      } catch (_) {
        // ignore when the file cannot be inspected after a failed optimization
      }
      console.warn('Optimization error for upload %s: %s', id, optimizationError?.message || optimizationError);
    }
    await recordUpload({
      id,
      originalName: req.file.originalname,
      displayName,
      extension: ext,
      size: finalSize
    });
    res.json({
      ok: true,
      url: '/public/uploads/' + req.file.filename,
      id,
      name: req.file.filename,
      displayName: displayName || '',
      originalName: req.file.originalname,
      size: finalSize
    });
  } catch (err) {
    next(err);
  }
});

r.use((err, req, res, next) => {
  if (req.path === '/uploads' && req.method === 'POST') {
    return res.status(400).json({ ok: false, message: err.message || 'Erreur lors de l\'upload' });
  }
  next(err);
});

r.get('/uploads', async (_req, res) => {
  const uploads = await listUploads();
  res.render('admin/uploads', { uploads });
});

r.post('/uploads/:id/name', async (req, res) => {
  const displayName = normalizeDisplayName(req.body?.displayName);
  await updateUploadName(req.params.id, displayName);
  res.redirect('/admin/uploads');
});

r.post('/uploads/:id/delete', async (req, res) => {
  await removeUpload(req.params.id);
  res.redirect('/admin/uploads');
});

// settings
r.get('/settings', async (req,res)=>{
  const s = await get('SELECT * FROM settings WHERE id=1');
  res.render('admin/settings', { s });
});
r.post('/settings', async (req,res)=>{
  const { wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text } = req.body;
  await run('UPDATE settings SET wiki_name=?, logo_url=?, admin_webhook_url=?, feed_webhook_url=?, footer_text=? WHERE id=1',
    [wiki_name, logo_url, admin_webhook_url, feed_webhook_url, footer_text]);
  res.redirect('/admin/settings');
});

// users
r.get('/users', async (req,res)=>{
  const users = await all('SELECT id, username, is_admin FROM users ORDER BY id');
  res.render('admin/users', { users });
});
r.post('/users', async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.redirect('/admin/users');
  await run('INSERT INTO users(username,password,is_admin) VALUES(?,?,1)', [username,password]);
  res.redirect('/admin/users');
});
r.post('/users/:id/delete', async (req,res)=>{
  await run('DELETE FROM users WHERE id=?', [req.params.id]);
  res.redirect('/admin/users');
});

// likes table improved
r.get('/likes', async (req,res)=>{
  const rows = await all(`
    SELECT l.id, l.ip, l.created_at, p.title, p.slug_id
    FROM likes l JOIN pages p ON p.id=l.page_id
    ORDER BY l.created_at DESC LIMIT 500
  `);
  res.render('admin/likes', { rows });
});
r.post('/likes/:id/delete', async (req,res)=>{
  await run('DELETE FROM likes WHERE id=?', [req.params.id]);
  res.redirect('/admin/likes');
});

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 120);
}

export default r;
