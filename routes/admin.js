import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { all, get, run } from '../db.js';

const r = Router();

r.use(requireAdmin);

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

export default r;
