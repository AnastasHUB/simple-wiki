import { Router } from 'express';
import { all } from '../db.js';

const r = Router();

r.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');

  // Recherche par titre, contenu ET tags
  const rows = await all(`
    SELECT DISTINCT
      p.title,
      p.slug_id,
      substr(p.content, 1, 400) AS excerpt,
      (
        SELECT GROUP_CONCAT(t2.name, ',')
        FROM tags t2
        JOIN page_tags pt2 ON pt2.tag_id = t2.id
        WHERE pt2.page_id = p.id
      ) AS tagsCsv
    FROM pages p
    LEFT JOIN page_tags pt ON pt.page_id = p.id
    LEFT JOIN tags t ON t.id = pt.tag_id
    WHERE p.title   LIKE '%'||?||'%'
       OR p.content LIKE '%'||?||'%'
       OR t.name    LIKE '%'||?||'%'
    ORDER BY p.updated_at DESC, p.created_at DESC
    LIMIT 100
  `, [q, q, q]);

  res.render('search', { q, rows });
});

export default r;
