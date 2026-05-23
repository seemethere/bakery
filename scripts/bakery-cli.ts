#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EOL } from "node:os";
import {
  banner,
  helpText,
  launcherConfig,
  packageName,
  packageVersion,
  parseArgs,
  parseRuntimeJson,
  isBakeryHealthResponse,
  reuseBanner,
  runtimeFromConfig,
  statusText,
  type BakeryRuntime,
  type LauncherConfig,
} from "./bakery-cli-core";

function pipeToConsoleAndLog(child: ChildProcess, name: string, logPath: string): void {
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`${EOL}--- ${name} start ${new Date().toISOString()} ---${EOL}`);
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });
  child.once("exit", (code, signal) => {
    log.write(`${EOL}--- ${name} exit code=${code ?? "null"} signal=${signal ?? "null"} ${new Date().toISOString()} ---${EOL}`);
    log.end();
  });
}

function spawnChild(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string }): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  pipeToConsoleAndLog(child, name, options.logPath);
  child.on("error", (error) => {
    console.error(`[${name}] failed to start:`, error.message);
  });
  return child;
}

function stopPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore shutdown races.
  }
}

function stopChild(child: ChildProcess | undefined): void {
  if (!child?.pid || child.killed) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Browser handoff is best-effort; the printed URL remains the reliable path.
  });
  child.unref();
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return await new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      if (signal && code === null) resolveExit(0);
      else resolveExit(code);
    });
  });
}

async function waitForUrl(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok || response.status < 500) return true;
    } catch {
      // Retry until the dev frontend finishes binding.
    }
    await new Promise((resolveRetry) => setTimeout(resolveRetry, 500));
  }
  return false;
}

async function readRuntime(config: LauncherConfig): Promise<BakeryRuntime | null> {
  try {
    const text = await readFile(config.runtimePaths.runtimeFile, "utf8");
    return parseRuntimeJson(text);
  } catch {
    return null;
  }
}

async function isRuntimeHealthy(runtime: BakeryRuntime | null): Promise<boolean> {
  if (!runtime) return false;
  try {
    process.kill(runtime.pid, 0);
  } catch {
    return false;
  }
  try {
    const response = await fetch(`${runtime.backendUrl}/healthz`);
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return isBakeryHealthResponse(body);
  } catch {
    return false;
  }
}

function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env.PI_WEB_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function approveWorkspace(runtime: BakeryRuntime, workspaceRoot: string): Promise<void> {
  if (runtime.workspaceRoots.includes(workspaceRoot)) return;
  try {
    const response = await fetch(`${runtime.backendUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ path: workspaceRoot }),
    });
    if (!response.ok && response.status !== 409) {
      console.warn(`Could not approve workspace on the running server: ${response.status} ${await response.text()}`);
      return;
    }
    runtime.workspaceRoots = [...new Set([...runtime.workspaceRoots, workspaceRoot])];
  } catch (error) {
    console.warn(`Could not approve workspace on the running server: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeRuntime(config: LauncherConfig, runtime: BakeryRuntime): Promise<void> {
  await mkdir(config.runtimePaths.stateDir, { recursive: true });
  await mkdir(config.runtimePaths.logDir, { recursive: true });
  await writeFile(config.runtimePaths.runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`);
}

async function removeRuntime(config: LauncherConfig, runtime: BakeryRuntime): Promise<void> {
  const current = await readRuntime(config);
  if (current?.pid === runtime.pid) await rm(config.runtimePaths.runtimeFile, { force: true });
}

async function reuseExisting(config: LauncherConfig, runtime: BakeryRuntime): Promise<number> {
  await approveWorkspace(runtime, config.workspaceRoot);
  await writeRuntime(config, runtime);
  console.log(reuseBanner(runtime, config.workspaceRoot));
  if (config.openBrowser) openBrowser(runtime.uiUrl);
  return 0;
}

async function printLogs(runtime: BakeryRuntime, lines: number): Promise<number> {
  const logFiles = [
    ["Backend", runtime.paths?.backendLog],
    ["Frontend", runtime.paths?.webLog],
  ] as const;
  for (const [label, path] of logFiles) {
    console.log(`==> ${label}: ${path ?? "unknown"} <==`);
    if (!path || !existsSync(path)) {
      console.log("No log file yet.\n");
      continue;
    }
    const text = await readFile(path, "utf8");
    console.log(`${text.split(/\r?\n/).slice(-lines).join("\n")}\n`);
  }
  return 0;
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`bakery: ${args.message}`);
    console.error("Try 'bun run bakery --help' for usage.");
    return 2;
  }

  if (args.options.version) {
    console.log(`${packageName} ${packageVersion}`);
    return 0;
  }
  if (args.options.help) {
    const helpConfig = launcherConfig(process.env, process.env.INIT_CWD || process.env.PWD || process.cwd(), args.options, { validateWorkspace: false });
    if ("error" in helpConfig) throw new Error(helpConfig.error);
    console.log(helpText(helpConfig));
    return 0;
  }

  const validateWorkspace = args.options.command === "start" || args.options.command === "open";
  const config = launcherConfig(process.env, process.env.INIT_CWD || process.env.PWD || process.cwd(), args.options, { validateWorkspace });
  if ("error" in config) {
    console.error(`bakery: ${config.error}`);
    return 2;
  }

  const existingRuntime = await readRuntime(config);
  const existingHealthy = await isRuntimeHealthy(existingRuntime);

  if (args.options.command === "status") {
    if (!existingRuntime) {
      console.log(`Bakery is not running\n\n  State: ${config.runtimePaths.stateDir}\n  Runtime: ${config.runtimePaths.runtimeFile}`);
      return 1;
    }
    console.log(statusText(existingRuntime, existingHealthy));
    return existingHealthy ? 0 : 1;
  }

  if (args.options.command === "logs") {
    if (!existingRuntime) {
      console.log(`Bakery is not running; no runtime file found at ${config.runtimePaths.runtimeFile}`);
      return 1;
    }
    return await printLogs(existingRuntime, args.options.lines);
  }

  if (args.options.command === "stop") {
    if (!existingRuntime) {
      console.log("Bakery is not running.");
      return 0;
    }
    if (!existingHealthy) {
      await rm(config.runtimePaths.runtimeFile, { force: true });
      console.log("Removed stale Bakery runtime file.");
      return 0;
    }
    stopPid(existingRuntime.pid);
    console.log(`Stopping Bakery pid ${existingRuntime.pid}...`);
    return 0;
  }

  if (existingRuntime && existingHealthy) return await reuseExisting(config, existingRuntime);
  if (existingRuntime && !existingHealthy) await rm(config.runtimePaths.runtimeFile, { force: true });

  const env = {
    ...process.env,
    PI_WEB_WORKSPACE_ROOT: config.workspaceRoot,
    PI_WEB_HOST: config.backendHost,
    PI_WEB_PORT: config.backendPort,
    VITE_PI_WEB_API_BASE: config.backendUrl,
  };

  await mkdir(config.runtimePaths.stateDir, { recursive: true });
  await mkdir(config.runtimePaths.logDir, { recursive: true });
  console.log(banner(config));

  const children: ChildProcess[] = [];
  let shuttingDown = false;
  let runtime = runtimeFromConfig(config);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) stopChild(child);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const backend = spawnChild("backend", "bun", ["run", "--cwd", "apps/server", "start"], { cwd: config.repoRoot, env, logPath: config.runtimePaths.backendLog });
  const web = spawnChild("web", "bun", ["run", "--cwd", "apps/web", "dev", "--host", config.webHost, "--port", config.webPort], { cwd: config.repoRoot, env, logPath: config.runtimePaths.webLog });
  children.push(backend, web);
  runtime = runtimeFromConfig(config, { backendPid: backend.pid, webPid: web.pid });
  await writeRuntime(config, runtime);

  if (config.openBrowser) {
    void waitForUrl(config.uiUrl).then((ready) => {
      if (!shuttingDown && ready) openBrowser(config.uiUrl);
    });
  }

  const backendExit = waitForExit(backend);
  const webExit = waitForExit(web);
  const firstExit = await Promise.race([
    backendExit.then((code) => ({ name: "backend", code })),
    webExit.then((code) => ({ name: "web", code })),
  ]);

  if (!shuttingDown) {
    console.error(`[${firstExit.name}] exited; stopping Bakery.`);
    shutdown();
    await removeRuntime(config, runtime);
    return firstExit.code === 0 ? 1 : firstExit.code ?? 1;
  }

  await Promise.allSettled([backendExit, webExit]);
  await removeRuntime(config, runtime);
  return 0;
}

const exitCode = await run();
process.exit(exitCode);
