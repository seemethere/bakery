import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dir, "..");
const runtimeDir = resolve(root, ".bakery", "dev");
const pidPath = resolve(runtimeDir, "server.pid");
const logPath = resolve(runtimeDir, "server.log");
const defaultHost = process.env.PI_WEB_HOST ?? "127.0.0.1";
const defaultPort = process.env.PI_WEB_PORT ?? "3141";
const healthUrl = `http://${defaultHost === "0.0.0.0" ? "127.0.0.1" : defaultHost}:${defaultPort}/healthz`;

type Command = "up" | "restart" | "down" | "logs" | "status";

function usage(): never {
  console.error("Usage: bun scripts/dev-server-manager.ts <up|restart|down|logs|status> [--follow]");
  process.exit(1);
}

function ensureRuntimeDir(): void {
  mkdirSync(runtimeDir, { recursive: true });
}

async function readPid(): Promise<number | null> {
  try {
    const value = (await readFile(pidPath, "utf8")).trim();
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(healthy: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy() === healthy) return true;
    await delay(200);
  }
  return false;
}

async function removePidFile(): Promise<void> {
  await rm(pidPath, { force: true });
}

async function up(): Promise<void> {
  ensureRuntimeDir();
  const existingPid = await readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    if (await isHealthy()) {
      console.log(`Backend already running (pid ${existingPid}) at ${healthUrl}`);
      return;
    }
    console.warn(`Backend pid ${existingPid} exists but health check is not ready; leaving it untouched.`);
    console.warn(`Inspect logs with: bun run dev:server:logs`);
    process.exit(1);
  }
  await removePidFile();
  if (await isHealthy()) {
    console.log(`Backend is already healthy at ${healthUrl} (not managed; no pid file).`);
    console.log("Stop that process manually, or keep using it alongside Vite.");
    return;
  }
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(logPath, `\n--- bakery backend start ${new Date().toISOString()} ---\n`, { flag: "a" });

  const logFd = openSync(logPath, "a");
  const child = spawn("bun", ["run", "dev:server"], {
    cwd: root,
    env: {
      ...process.env,
      PI_WEB_HOST: defaultHost,
      PI_WEB_PORT: defaultPort,
      PI_WEB_WORKSPACE_ROOT: process.env.PI_WEB_WORKSPACE_ROOT ?? root,
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  await writeFile(pidPath, `${child.pid}\n`, "utf8");

  const ready = await waitForHealth(true, 15_000);
  if (!ready) {
    console.error(`Backend did not become healthy at ${healthUrl}.`);
    console.error(`Logs: ${logPath}`);
    process.exit(1);
  }
  console.log(`Backend running at ${healthUrl} (pid ${child.pid})`);
  console.log(`Logs: ${logPath}`);
}

async function down(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log("Backend is not managed by dev-server-manager (no pid file).");
    return;
  }
  if (!isProcessAlive(pid)) {
    await removePidFile();
    console.log(`Removed stale backend pid file (${pid}).`);
    return;
  }

  console.log(`Stopping backend pid ${pid}...`);
  try {
    if (process.platform === "win32") process.kill(pid, "SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isProcessAlive(pid)) await delay(200);
  if (isProcessAlive(pid)) {
    console.warn(`Backend pid ${pid} did not stop after SIGTERM; sending SIGKILL.`);
    try {
      if (process.platform === "win32") process.kill(pid, "SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
  await waitForHealth(false, 3_000);
  await removePidFile();
  console.log("Backend stopped.");
}

async function restart(): Promise<void> {
  await down();
  await up();
}

async function status(): Promise<void> {
  const pid = await readPid();
  const alive = Boolean(pid && isProcessAlive(pid));
  const healthy = await isHealthy();
  console.log(`PID file: ${pidPath}`);
  console.log(`Log file: ${logPath}`);
  console.log(`Process: ${alive ? `running (pid ${pid})` : "not running"}`);
  console.log(`Health: ${healthy ? "ok" : "not ready"} (${healthUrl})`);
}

function logs(): void {
  ensureRuntimeDir();
  if (!existsSync(logPath)) {
    console.log(`No backend log yet: ${logPath}`);
    return;
  }
  const follow = process.argv.includes("--follow") || process.argv.includes("-f");
  if (follow) {
    const tail = spawn("tail", ["-n", "120", "-f", logPath], { stdio: "inherit" });
    tail.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  console.log(lines.slice(-120).join("\n"));
}

const command = process.argv[2] as Command | undefined;
if (!command || !["up", "restart", "down", "logs", "status"].includes(command)) usage();

if (command === "up") await up();
else if (command === "restart") await restart();
else if (command === "down") await down();
else if (command === "status") await status();
else logs();
