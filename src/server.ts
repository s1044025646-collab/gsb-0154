import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrate, openDb, Store } from "./db.ts";
import { listenLocal } from "./api.ts";

const dbPath = process.env.ANOVA_DB ?? resolve("data/app.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const version = migrate(db);
const store = new Store(db);

const { port } = await listenLocal(store, 0, "127.0.0.1");
const info = { port, host: "127.0.0.1", dbPath, schemaVersion: version, pid: process.pid };
writeFileSync(resolve("data/server.json"), JSON.stringify(info, null, 2));
console.log(`ANOVA API 已启动: http://127.0.0.1:${port}  pid=${process.pid}  db=${dbPath}`);

function shutdown() {
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
