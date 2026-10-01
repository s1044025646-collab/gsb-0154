import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./db/database.ts";
import { systemClock } from "./services/repo.ts";
import { startServer } from "./api/server.ts";

const DATA_DIR = process.env.ANOVA_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = process.env.ANOVA_DB ?? join(DATA_DIR, "anova.sqlite");
const HOST = process.env.ANOVA_HOST ?? "127.0.0.1";

mkdirSync(DATA_DIR, { recursive: true });
const db = openDatabase(DB_PATH);
const app = await startServer(db, systemClock, HOST, Number(process.env.ANOVA_PORT ?? 0));

const info = {
  url: `http://${HOST}:${app.port}`,
  host: HOST,
  port: app.port,
  pid: process.pid,
  started_at: new Date().toISOString(),
  db: DB_PATH,
};
writeFileSync(join(DATA_DIR, "server.json"), JSON.stringify(info, null, 2));
console.log(`ANOVA API listening on ${info.url} (pid ${process.pid})`);
console.log(`state written to ${join(DATA_DIR, "server.json")}`);

const shutdown = () => {
  app
    .close()
    .then(() => {
      db.close();
      process.exit(0);
    })
    .catch(() => process.exit(1));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
