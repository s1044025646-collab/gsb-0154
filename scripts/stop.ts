/**
 * 只停止本项目通过 src/server.ts 启动的进程：读取 data/server.json 中的 pid，
 * 校验其命令行包含本项目路径后再终止。
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const infoPath = resolve("data/server.json");
if (!existsSync(infoPath)) {
  console.log("没有运行中的本项目服务器（data/server.json 不存在）");
  process.exit(0);
}
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const pid = Number(info.pid);

function cmdLine(p: number): string {
  try {
    return execFileSync("powershell", [
      "-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${p}").CommandLine`,
    ], { encoding: "utf8" });
  } catch {
    return "";
  }
}

const cl = cmdLine(pid);
if (!cl) {
  console.log(`进程 ${pid} 已不存在，清理 ${infoPath}`);
  rmSync(infoPath);
  process.exit(0);
}
if (!cl.includes("src/server.ts")) {
  console.error(`拒绝终止：pid ${pid} 不像本项目服务器进程：${cl}`);
  process.exit(1);
}
process.kill(pid);
rmSync(infoPath);
console.log(`已停止本项目服务器 pid=${pid}`);
