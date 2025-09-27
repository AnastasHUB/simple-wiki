import { initDb, all, run } from "../db.js";

await initDb();

const now = new Date();
const startOfToday = new Date(now);
startOfToday.setHours(0, 0, 0, 0);
const startOfYesterday = new Date(startOfToday);
startOfYesterday.setDate(startOfYesterday.getDate() - 1);

const cutoffIso = startOfYesterday.toISOString();

const aggregates = await all(
  `SELECT page_id, date(viewed_at) AS day, COUNT(*) AS views
   FROM page_views
   WHERE viewed_at < ?
   GROUP BY page_id, day
   ORDER BY day ASC`,
  [cutoffIso],
);

if (!aggregates.length) {
  console.log("Aucune donnée à agréger : la table page_views reste inchangée.");
  process.exit(0);
}

console.log(`Agrégation de ${aggregates.length} jour(s) avant ${cutoffIso}.`);

await run("BEGIN");
let committed = false;
try {
  for (const row of aggregates) {
    await run(
      `INSERT INTO page_view_daily(page_id, day, views)
       VALUES(?, ?, ?)
       ON CONFLICT(page_id, day) DO UPDATE SET views = views + excluded.views`,
      [row.page_id, row.day, row.views],
    );
  }
  await run("DELETE FROM page_views WHERE viewed_at < ?", [cutoffIso]);
  await run("COMMIT");
  committed = true;
  console.log("Agrégation terminée avec succès.");
} catch (err) {
  if (!committed) {
    await run("ROLLBACK");
  }
  console.error("Échec de l'agrégation des vues:", err);
  process.exitCode = 1;
}
