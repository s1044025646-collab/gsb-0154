// Remove ONLY this project's generated data and runtime state.
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const targets = [join(root, "data")];
for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true });
    console.log("removed", t);
  }
}

// If a server state file existed, surface guidance (we never kill foreign PIDs).
const stateFile = join(root, "data", "server.json");
if (existsSync(stateFile)) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  console.log(`note: a server was recorded at pid ${state.pid}; stop it with 'npm run stop'`);
}
console.log("clean complete");
