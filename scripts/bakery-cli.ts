#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { banner, helpText, launcherConfig, packageName, packageVersion, parseArgs } from "./bakery-cli-core";

function spawnChild(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  child.on("error", (error) => {
    console.error(`[${name}] failed to start:`, error.message);
  });
  return child;
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

  const config = launcherConfig(process.env, process.env.INIT_CWD || process.env.PWD || process.cwd(), args.options);
  if ("error" in config) {
    console.error(`bakery: ${config.error}`);
    return 2;
  }

  const env = {
    ...process.env,
    PI_WEB_WORKSPACE_ROOT: config.workspaceRoot,
    PI_WEB_HOST: config.backendHost,
    PI_WEB_PORT: config.backendPort,
    VITE_PI_WEB_API_BASE: config.backendUrl,
  };

  console.log(banner(config));

  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) stopChild(child);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const backend = spawnChild("backend", "bun", ["run", "--cwd", "apps/server", "start"], { cwd: config.repoRoot, env });
  const web = spawnChild("web", "bun", ["run", "--cwd", "apps/web", "dev", "--host", config.webHost, "--port", config.webPort], { cwd: config.repoRoot, env });
  children.push(backend, web);

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
    return firstExit.code === 0 ? 1 : firstExit.code ?? 1;
  }

  await Promise.allSettled([backendExit, webExit]);
  return 0;
}

const exitCode = await run();
process.exit(exitCode);
