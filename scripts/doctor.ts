import { access, mkdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";

const args = new Set(process.argv.slice(2));
const lanMode = args.has("--lan");
const help = args.has("--help") || args.has("-h");

function usage(): void {
  console.log(`Bakery local install doctor\n\nUsage:\n  bun run doctor [--lan]\n\nChecks local Bun install readiness, workspace/data directories, and safe host/token settings.\nUse --lan when you intend to run Bakery for another device on your local network.`);
}

if (help) {
  usage();
  process.exit(0);
}

const checks: Array<{ level: "ok" | "warn" | "fail"; message: string; detail?: string }> = [];

function ok(message: string, detail?: string): void {
  checks.push({ level: "ok", message, detail });
}

function warn(message: string, detail?: string): void {
  checks.push({ level: "warn", message, detail });
}

function fail(message: string, detail?: string): void {
  checks.push({ level: "fail", message, detail });
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, host);
  });
}

async function checkDirectory(path: string, label: string, create = false): Promise<void> {
  try {
    if (create) await mkdir(path, { recursive: true });
    const info = await stat(path);
    if (!info.isDirectory()) {
      fail(`${label} is not a directory`, path);
      return;
    }
    await access(path, constants.R_OK | constants.W_OK);
    ok(`${label} is readable and writable`, path);
  } catch (error) {
    fail(`${label} is not usable`, `${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function main(): Promise<void> {
  console.log("Bakery local install doctor\n");

  if (typeof Bun === "undefined") {
    fail("Bun runtime is required", "Install Bun from https://bun.sh and rerun `bun run doctor`.");
  } else {
    ok("Bun runtime detected", `Bun ${Bun.version}`);
  }

  try {
    await access(resolve("package.json"), constants.R_OK);
    ok("Repository root looks readable", resolve("package.json"));
  } catch {
    fail("Run this command from the Bakery repository root", "Expected to find package.json in the current directory.");
  }

  try {
    await access(resolve("node_modules"), constants.R_OK);
    ok("Dependencies appear installed", "node_modules exists");
  } catch {
    warn("Dependencies are not installed yet", "Run `bun install` before starting Bakery.");
  }

  const workspaceRoots = splitList(process.env.PI_WEB_WORKSPACE_ROOT);
  const effectiveWorkspaceRoots = workspaceRoots.length ? workspaceRoots.map(expandHome) : [resolve(process.cwd())];
  for (const [index, workspaceRoot] of effectiveWorkspaceRoots.entries()) {
    await checkDirectory(workspaceRoot, effectiveWorkspaceRoots.length > 1 ? `Workspace root ${index + 1}` : "Workspace root");
  }

  const dataDir = expandHome(process.env.PI_WEB_DATA_DIR ?? "~/.pi-web-agent");
  await checkDirectory(dataDir, "Data directory", true);

  const host = process.env.PI_WEB_HOST ?? (lanMode ? "0.0.0.0" : "127.0.0.1");
  const apiPort = Number(process.env.PI_WEB_PORT ?? "3141");
  const webPort = Number(process.env.PI_WEB_WEB_PORT ?? "5173");
  const token = process.env.PI_WEB_AUTH_TOKEN?.trim();

  if (!Number.isInteger(apiPort) || apiPort <= 0 || apiPort > 65535) fail("API port is invalid", `PI_WEB_PORT=${process.env.PI_WEB_PORT}`);
  else if (await canBind(isLoopbackHost(host) || host === "0.0.0.0" ? host : "127.0.0.1", apiPort)) ok("API port appears available", `${host}:${apiPort}`);
  else warn("API port may already be in use", `${host}:${apiPort}`);

  if (!Number.isInteger(webPort) || webPort <= 0 || webPort > 65535) fail("Web port is invalid", `PI_WEB_WEB_PORT=${process.env.PI_WEB_WEB_PORT}`);
  else if (await canBind("127.0.0.1", webPort)) ok("Web dev port appears available", `127.0.0.1:${webPort}`);
  else warn("Web dev port may already be in use", `127.0.0.1:${webPort}`);

  const effectiveLanMode = lanMode || host === "0.0.0.0";

  if (effectiveLanMode) {
    if (token) ok("LAN/API auth token is configured", "PI_WEB_AUTH_TOKEN is set");
    else fail("LAN mode requires an auth token", "Set PI_WEB_AUTH_TOKEN before using `bun run dev:lan`.");

    if (host === "0.0.0.0") ok("API host is LAN-ready", "PI_WEB_HOST=0.0.0.0");
    else warn("API host is not bound to all interfaces", `Use PI_WEB_HOST=0.0.0.0 or 'bun run dev:lan'; current host is ${host}.`);

    if (effectiveWorkspaceRoots.some((root) => root === homedir() || root === resolve(homedir()))) {
      warn("Workspace root is broad for LAN access", "Prefer a single project directory instead of your whole home directory.");
    }
  } else if (!isLoopbackHost(host)) {
    if (!token) fail("Non-localhost host requires an auth token", "Set PI_WEB_AUTH_TOKEN or bind to 127.0.0.1.");
    else ok("Non-localhost API host has a token configured", `PI_WEB_HOST=${host}`);
  } else {
    ok("Localhost-only mode is safe by default", token ? "Token is configured." : "No token needed for localhost-only access.");
  }

  for (const check of checks) {
    const icon = check.level === "ok" ? "✓" : check.level === "warn" ? "!" : "✗";
    console.log(`${icon} ${check.message}${check.detail ? `\n  ${check.detail}` : ""}`);
  }

  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  const addresses = lanAddresses();

  console.log("\nNext commands:");
  if (effectiveLanMode) {
    console.log('  PI_WEB_AUTH_TOKEN="change-me" PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev:lan');
  } else {
    console.log('  PI_WEB_WORKSPACE_ROOT="$PWD" bun run dev');
  }

  console.log("\nExpected URLs:");
  console.log(`  Local web UI: http://127.0.0.1:${webPort}/`);
  console.log(`  Local API:    http://127.0.0.1:${apiPort}`);
  if (effectiveLanMode) {
    if (addresses.length) {
      for (const address of addresses) console.log(`  LAN web UI:   http://${address}:${webPort}/`);
    } else {
      console.log("  LAN web UI:   No non-loopback IPv4 address detected.");
    }
    console.log("\nLAN reminder: anyone with the token can drive an agent that can edit files and run shell commands inside the allowed workspace roots.");
  }

  console.log(`\nSummary: ${failures} failure(s), ${warnings} warning(s).`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
