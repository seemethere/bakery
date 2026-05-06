#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "pi-web-agent";
const packageVersion = "0.0.0";

type LauncherConfig = {
  repoRoot: string;
  invocationCwd: string;
  workspaceRoot: string;
  backendHost: string;
  backendPort: string;
  webHost: string;
  webPort: string;
  backendUrl: string;
  uiUrl: string;
};

function publicHost(host: string): string {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

function parseArgs(args: string[]): { help: boolean; version: boolean } {
  return {
    help: args.includes("--help") || args.includes("-h"),
    version: args.includes("--version") || args.includes("-v"),
  };
}

function launcherConfig(env: NodeJS.ProcessEnv = process.env, invocationCwd = env.INIT_CWD || env.PWD || process.cwd()): LauncherConfig {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const backendHost = env.PI_WEB_HOST?.trim() || "127.0.0.1";
  const backendPort = env.PI_WEB_PORT?.trim() || "3141";
  const webHost = env.PI_WEB_VITE_HOST?.trim() || "127.0.0.1";
  const webPort = env.PI_WEB_VITE_PORT?.trim() || "5173";
  const workspaceRoot = env.PI_WEB_WORKSPACE_ROOT?.trim() || invocationCwd;
  const backendUrl = `http://${publicHost(backendHost)}:${backendPort}`;
  const uiUrl = `http://${publicHost(webHost)}:${webPort}`;
  return { repoRoot, invocationCwd, workspaceRoot, backendHost, backendPort, webHost, webPort, backendUrl, uiUrl };
}

function helpText(config: LauncherConfig): string {
  return `Bakery Launcher

Usage:
  bun run bakery [--help] [--version]

Starts Bakery for the current workspace, prints the localhost UI URL, and keeps
the backend and frontend attached to this foreground command until Ctrl+C.

Default URLs:
  Bakery UI:  ${config.uiUrl}
  Backend API: ${config.backendUrl}

Workspace:
  Defaults to the invocation directory unless PI_WEB_WORKSPACE_ROOT is set.
  Current default: ${config.workspaceRoot}

Security:
  Bakery is local-first and the agent can read, edit, and run commands inside
  allowed workspaces. Run it only in workspaces you trust. Localhost access is
  allowed without a token; LAN/non-localhost access should set PI_WEB_AUTH_TOKEN.

Environment overrides:
  PI_WEB_WORKSPACE_ROOT  Allowed workspace root(s)
  PI_WEB_HOST            Backend bind host (default 127.0.0.1)
  PI_WEB_PORT            Backend port (default 3141)
  PI_WEB_VITE_HOST       Frontend bind host for this launcher (default 127.0.0.1)
  PI_WEB_VITE_PORT       Frontend port for this launcher (default 5173)
`;
}

function banner(config: LauncherConfig): string {
  return `
Bakery is starting...

  Bakery UI:  ${config.uiUrl}
  Backend API: ${config.backendUrl}
  Workspace:   ${config.workspaceRoot}

Local-first security note: Bakery can run an agent that reads, edits, and
executes commands inside allowed workspaces. Keep this bound to localhost unless
you intentionally configure token-protected LAN access.

Press Ctrl+C to stop Bakery.
`;
}

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

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return await new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      if (signal && code === null) resolveExit(0);
      else resolveExit(code);
    });
  });
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = launcherConfig();

  if (args.help) {
    console.log(helpText(config));
    return 0;
  }
  if (args.version) {
    console.log(`${packageName} ${packageVersion}`);
    return 0;
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
