import { initDb, ensureDefaultAdmin } from "../db.js";

await initDb();
await ensureDefaultAdmin();

console.log("Database initialized.");
