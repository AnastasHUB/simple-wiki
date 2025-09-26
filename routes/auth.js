import { Router } from 'express';
import { get } from '../db.js';

const r = Router();

r.get('/login', (req,res)=> res.render('login'));
r.post('/login', async (req,res)=>{
  const { username, password } = req.body;
  const u = await get('SELECT * FROM users WHERE username=? AND password=?', [username, password]);
  if(!u) return res.render('login', { error:'Identifiants invalides' });
  req.session.user = { id: u.id, username: u.username, is_admin: !!u.is_admin };
  res.redirect('/');
});
r.post('/logout', (req,res)=>{ req.session.destroy(()=>res.redirect('/')); });

export default r;
