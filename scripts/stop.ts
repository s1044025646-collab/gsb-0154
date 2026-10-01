// Stop exactly the server process previously started by THIS project.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.ANOVA_DATA_DIR ?? join(process.cwd(), "data");
const stateFile = join(dataDir, "server.json");
if (!existsSync(stateFile)) {
  console.log("no server state file found; nothing to stop");
  process.exit(0);
}
const state = JSON.parse(readFileSync(stateFile, "utf8")) as { pid: number; url: string };
try {
  process.kill(state.pid, "SIGTERM");
  console.log(`sent SIGTERM to project server pid ${state.pid} (${state.url})`);
  rmSync(stateFile, { force: true });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ESRCH") {
    console.log(`pid ${state.pid} is not running; removing stale state file`);
    rmSync(stateFile, { force: true });
  } else {
    throw err;
  }
}
