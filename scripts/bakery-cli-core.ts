import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "pi-web-agent";
export const packageVersion = "0.0.0";

export type CliCommand = "start" | "status" | "open" | "stop" | "logs";

export type CliOptions = {
  command: CliCommand;
  help: boolean;
  version: boolean;
  open: boolean;
  workspace?: string;
  host?: string;
  port?: string;
  lines: number;
};

export type ParsedArgs =
  | { ok: true; options: CliOptions }
  | { ok: false; message: string };

export type RuntimePaths = {
  stateDir: string;
  runtimeFile: string;
  logDir: string;
  backendLog: string;
  webLog: string;
};

export type BakeryRuntime = {
  app: "bakery";
  version: string;
  pid: number;
  backendPid?: number;
  webPid?: number;
  startedAt: string;
  host: string;
  port: string;
  webHost: string;
  webPort: string;
  backendUrl: string;
  uiUrl: string;
  workspaceRoots: string[];
  paths: RuntimePaths;
};

export type LauncherConfig = {
  repoRoot: string;
  invocationCwd: string;
  workspaceRoot: string;
  workspaceWarnings: string[];
  openBrowser: boolean;
  backendHost: string;
  backendPort: string;
  webHost: string;
  webPort: string;
  backendUrl: string;
  uiUrl: string;
  runtimePaths: RuntimePaths;
};

const commands = new Set<CliCommand>(["start", "status", "open", "stop", "logs"]);

export function publicHost(host: string): string {
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BAKERY_STATE_DIR?.trim()) return resolve(env.BAKERY_STATE_DIR.trim());
  if (env.XDG_STATE_HOME?.trim()) return resolve(env.XDG_STATE_HOME.trim(), "bakery");
  return resolve(homedir(), ".local", "state", "bakery");
}

export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const stateDir = defaultStateDir(env);
  const logDir = join(stateDir, "logs");
  return {
    stateDir,
    runtimeFile: join(stateDir, "runtime.json"),
    logDir,
    backendLog: join(logDir, "server.log"),
    webLog: join(logDir, "web.log"),
  };
}

function readValue(args: string[], index: number, flag: string): ParsedArgs | string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) return { ok: false, message: `${flag} requires a value` };
  return value;
}

function parsePositiveInteger(value: string, flag: string): ParsedArgs | number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, message: `${flag} must be a positive integer` };
  return parsed;
}

export function parseArgs(args: string[]): ParsedArgs {
  const options: CliOptions = { command: "start", help: false, version: false, open: true, lines: 80 };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (index === 0 && commands.has(arg as CliCommand)) {
      options.command = arg as CliCommand;
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--workspace") {
      const value = readValue(args, index, arg);
      if (typeof value !== "string") return value;
      options.workspace = value;
      index += 1;
    } else if (arg.startsWith("--workspace=")) options.workspace = arg.slice("--workspace=".length);
    else if (arg === "--host") {
      const value = readValue(args, index, arg);
      if (typeof value !== "string") return value;
      options.host = value;
      index += 1;
    } else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--port") {
      const value = readValue(args, index, arg);
      if (typeof value !== "string") return value;
      options.port = value;
      index += 1;
    } else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else if (arg === "--lines") {
      const value = readValue(args, index, arg);
      if (typeof value !== "string") return value;
      const lines = parsePositiveInteger(value, arg);
      if (typeof lines !== "number") return lines;
      options.lines = lines;
      index += 1;
    } else if (arg.startsWith("--lines=")) {
      const lines = parsePositiveInteger(arg.slice("--lines=".length), "--lines");
      if (typeof lines !== "number") return lines;
      options.lines = lines;
    } else return { ok: false, message: `unknown option ${arg}` };
  }

  return { ok: true, options };
}

export function resolveWorkspaceRoot(workspace: string): { ok: true; path: string; warnings: string[] } | { ok: false; message: string } {
  const resolved = resolve(workspace);
  if (!existsSync(resolved)) return { ok: false, message: `workspace does not exist: ${resolved}` };

  const realPath = realpathSync(resolved);
  const parsed = parse(realPath);
  const normalizedHome = resolve(homedir());
  const warnings: string[] = [];
  if (realPath === parsed.root) warnings.push("Workspace is a filesystem root; prefer a narrower project directory.");
  if (realPath === normalizedHome) warnings.push("Workspace is your home directory; prefer a narrower project directory.");

  return { ok: true, path: realPath, warnings };
}

export function launcherConfig(
  env: NodeJS.ProcessEnv = process.env,
  invocationCwd = env.INIT_CWD || env.PWD || process.cwd(),
  options: CliOptions = { command: "start", help: false, version: false, open: true, lines: 80 },
  configOptions: { validateWorkspace?: boolean } = {},
): LauncherConfig | { error: string } {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const backendHost = options.host?.trim() || env.PI_WEB_HOST?.trim() || "127.0.0.1";
  const backendPort = options.port?.trim() || env.PI_WEB_PORT?.trim() || "3141";
  const webHost = env.PI_WEB_VITE_HOST?.trim() || "127.0.0.1";
  const webPort = env.PI_WEB_VITE_PORT?.trim() || "5173";
  const workspaceInput = options.workspace?.trim() || env.PI_WEB_WORKSPACE_ROOT?.trim() || invocationCwd;
  const workspace = configOptions.validateWorkspace === false
    ? { ok: true as const, path: resolve(workspaceInput), warnings: [] }
    : resolveWorkspaceRoot(workspaceInput);
  if (!workspace.ok) return { error: workspace.message };
  const backendUrl = `http://${publicHost(backendHost)}:${backendPort}`;
  const uiUrl = `http://${publicHost(webHost)}:${webPort}`;
  return {
    repoRoot,
    invocationCwd,
    workspaceRoot: workspace.path,
    workspaceWarnings: workspace.warnings,
    openBrowser: options.open && env.CI !== "true",
    backendHost,
    backendPort,
    webHost,
    webPort,
    backendUrl,
    uiUrl,
    runtimePaths: runtimePaths(env),
  };
}

export function runtimeFromConfig(config: LauncherConfig, pids: { backendPid?: number; webPid?: number } = {}): BakeryRuntime {
  return {
    app: "bakery",
    version: packageVersion,
    pid: process.pid,
    ...(pids.backendPid ? { backendPid: pids.backendPid } : {}),
    ...(pids.webPid ? { webPid: pids.webPid } : {}),
    startedAt: new Date().toISOString(),
    host: config.backendHost,
    port: config.backendPort,
    webHost: config.webHost,
    webPort: config.webPort,
    backendUrl: config.backendUrl,
    uiUrl: config.uiUrl,
    workspaceRoots: [config.workspaceRoot],
    paths: config.runtimePaths,
  };
}

export function parseRuntimeJson(text: string): BakeryRuntime | null {
  try {
    const value = JSON.parse(text) as Partial<BakeryRuntime>;
    if (value.app !== "bakery" || typeof value.pid !== "number" || typeof value.backendUrl !== "string" || typeof value.uiUrl !== "string") return null;
    return value as BakeryRuntime;
  } catch {
    return null;
  }
}

export function isBakeryHealthResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { app?: unknown; ok?: unknown };
  return body.ok === true && body.app === "bakery";
}

export function helpText(config: LauncherConfig): string {
  return `Bakery Launcher

Usage:
  bakery [start] [--help] [--version] [--no-open] [--workspace PATH] [--host HOST] [--port PORT]
  bakery status
  bakery open [--workspace PATH] [--no-open]
  bakery stop
  bakery logs [--lines N]

Source-checkout equivalent: bun run bakery [same options]

Starts Bakery for the current workspace, prints the localhost UI URL, and keeps
the backend and frontend attached to this foreground command until Ctrl+C.

Commands:
  start     Start or reuse the local Bakery server (default)
  status    Show the managed server, URL, workspace, pid, and log paths
  open      Open the running UI, or start Bakery if none is running
  stop      Stop the managed foreground server from another terminal
  logs      Print recent backend/frontend logs

Options:
  --no-open           Do not open a browser tab automatically
  --workspace PATH    Approved workspace root (default: invocation directory)
  --host HOST         Backend bind host (default: 127.0.0.1)
  --port PORT         Backend API port (default: 3141)
  --lines N           Lines per log file for the logs command (default: 80)

Default URLs:
  Bakery UI:  ${config.uiUrl}
  Backend API: ${config.backendUrl}

Workspace:
  Defaults to the invocation directory unless PI_WEB_WORKSPACE_ROOT is set.
  Current default: ${config.workspaceRoot}

Runtime:
  State: ${config.runtimePaths.stateDir}
  Logs:  ${config.runtimePaths.logDir}

Security:
  Bakery is local-first and the agent can read, edit, and run commands inside
  allowed workspaces. Run it only in workspaces you trust. Localhost access is
  allowed without a token; LAN/non-localhost access should set PI_WEB_AUTH_TOKEN.

Environment overrides:
  BAKERY_STATE_DIR       Runtime state/log directory for this launcher
  PI_WEB_WORKSPACE_ROOT  Allowed workspace root(s)
  PI_WEB_HOST            Backend bind host (default 127.0.0.1)
  PI_WEB_PORT            Backend port (default 3141)
  PI_WEB_VITE_HOST       Frontend bind host for this launcher (default 127.0.0.1)
  PI_WEB_VITE_PORT       Frontend port for this launcher (default 5173)
`;
}

export function banner(config: LauncherConfig): string {
  const warnings = config.workspaceWarnings.length > 0 ? `\nWarnings:\n${config.workspaceWarnings.map((warning) => `  - ${warning}`).join("\n")}\n` : "";
  const openLine = config.openBrowser ? "Opening browser automatically. Pass --no-open to disable." : "Browser auto-open disabled.";
  return `
Bakery is starting...

  Bakery UI:  ${config.uiUrl}
  Backend API: ${config.backendUrl}
  Workspace:   ${config.workspaceRoot}
  State:       ${config.runtimePaths.stateDir}
  Logs:        ${config.runtimePaths.logDir}

${openLine}${warnings}
Local-first security note: Bakery can run an agent that reads, edits, and
executes commands inside allowed workspaces. Keep this bound to localhost unless
you intentionally configure token-protected LAN access.

Press Ctrl+C to stop Bakery.
`;
}

export function reuseBanner(runtime: BakeryRuntime, workspaceRoot: string): string {
  return `Bakery is already running

  Bakery UI:  ${runtime.uiUrl}
  Backend API: ${runtime.backendUrl}
  Workspace:   ${workspaceRoot}
  PID:         ${runtime.pid}
  Logs:        ${runtime.paths?.logDir ?? "unknown"}
`;
}

export function statusText(runtime: BakeryRuntime, healthy: boolean): string {
  const workspaces = runtime.workspaceRoots.length > 0 ? runtime.workspaceRoots.join(", ") : "unknown";
  return `Bakery ${healthy ? "is running" : "runtime file is stale or unhealthy"}

  Bakery UI:  ${runtime.uiUrl}
  Backend API: ${runtime.backendUrl}
  Workspace:   ${workspaces}
  PID:         ${runtime.pid}
  Started:     ${runtime.startedAt ?? "unknown"}
  State:       ${runtime.paths?.stateDir ?? "unknown"}
  Logs:        ${runtime.paths?.logDir ?? "unknown"}
`;
}
