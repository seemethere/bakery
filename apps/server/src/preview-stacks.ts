import { existsSync, mkdirSync } from "node:fs";
import { openSync, closeSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { join, resolve } from "node:path";
import type { PreviewStackStatus, WebSession } from "@pi-web-agent/protocol";
import type { ServerConfig } from "./config.js";

export type PreviewStackManagerOptions = {
  config: ServerConfig;
};

type PreviewProcess = {
  sessionId: string;
  cwd: string;
  backendPort: number;
  webPort: number;
  startedAt: string;
  backend: ChildProcess;
  web: ChildProcess;
  logPath: string;
  status: "starting" | "running" | "error";
  error?: string;
};

function publicUrl(config: ServerConfig, port: number): string {
  const base = config.previewPublicBaseUrl?.trim();
  if (base) {
    const url = new URL(base);
    url.port = String(port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  return `http://127.0.0.1:${port}`;
}

function previewBindHost(config: ServerConfig): string {
  return config.previewPublicBaseUrl ? "0.0.0.0" : "127.0.0.1";
}

function ensureDependencyLink(sourceCwd: string, worktreePath: string, relativePath: string): void {
  const sourceModules = resolve(sourceCwd, relativePath, "node_modules");
  if (!existsSync(sourceModules)) return;
  const worktreeModules = resolve(worktreePath, relativePath, "node_modules");
  if (existsSync(worktreeModules)) return;
  symlinkSync(sourceModules, worktreeModules, "dir");
}

function ensureWorktreeDependencies(session: WebSession): void {
  if (!session.worktreePath) return;
  const sourceCwd = session.sourceCwd ?? "";
  if (!sourceCwd || !existsSync(resolve(sourceCwd, "node_modules"))) {
    throw new Error("Preview stack dependencies are not installed in the source checkout. Run bun install in the source checkout, then try again.");
  }
  for (const relativePath of [".", "apps/server", "apps/web", "packages/protocol"]) {
    ensureDependencyLink(sourceCwd, session.worktreePath, relativePath);
  }
}

async function findOpenPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolvePort(port) : reject(new Error("Could not allocate preview port")));
    });
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok) return true;
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return false;
}

function stopProcess(child: ChildProcess): void {
  if (!isAlive(child) || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

export class PreviewStackManager {
  private readonly config: ServerConfig;
  private readonly stacks = new Map<string, PreviewProcess>();

  constructor(options: PreviewStackManagerOptions) {
    this.config = options.config;
    mkdirSync(this.config.previewRuntimeDir, { recursive: true });
  }

  status(session: WebSession): PreviewStackStatus {
    const stack = this.stacks.get(session.id);
    if (!stack) {
      return { state: "stopped", mode: "fake-agent", message: session.isolationKind === "git_worktree" ? "Preview stack is stopped." : "Preview stacks require an isolated Git worktree session." };
    }
    if (!isAlive(stack.backend) || !isAlive(stack.web)) {
      this.stacks.delete(session.id);
      return { state: "error", mode: "fake-agent", message: stack.error ?? "Preview stack process exited.", backendPort: stack.backendPort, webPort: stack.webPort, url: publicUrl(this.config, stack.webPort), logPath: stack.logPath, startedAt: stack.startedAt };
    }
    return { state: stack.status, mode: "fake-agent", message: stack.status === "running" ? "Preview stack is running." : stack.error ?? "Preview stack is starting.", backendPort: stack.backendPort, webPort: stack.webPort, url: publicUrl(this.config, stack.webPort), logPath: stack.logPath, startedAt: stack.startedAt };
  }

  async start(session: WebSession): Promise<PreviewStackStatus> {
    if (session.isolationKind !== "git_worktree" || !session.worktreePath) {
      throw new Error("Preview stacks require an isolated Git worktree session.");
    }
    const existing = this.stacks.get(session.id);
    if (existing && existing.status !== "error" && isAlive(existing.backend) && isAlive(existing.web)) return this.status(session);
    if (existing) await this.stop(session.id);

    ensureWorktreeDependencies(session);

    const backendPort = await findOpenPort();
    const webPort = await findOpenPort();
    const bindHost = previewBindHost(this.config);
    const startedAt = new Date().toISOString();
    const runtimeDir = resolve(this.config.previewRuntimeDir, session.id);
    await mkdir(runtimeDir, { recursive: true });
    const logPath = join(runtimeDir, "preview-stack.log");
    await writeFile(logPath, `\n--- preview stack ${session.id} ${startedAt} ---\n`, { flag: "a" });
    const logFd = openSync(logPath, "a");

    const previewAuthToken = this.config.authToken ?? crypto.randomUUID();
    const commonEnv = {
      ...process.env,
      PI_WEB_AUTH_TOKEN: previewAuthToken,
      PI_WEB_HOST: bindHost,
      PI_WEB_WORKSPACE_ROOT: session.worktreePath,
      PI_WEB_DATA_DIR: resolve(runtimeDir, "data"),
      PI_WEB_FAKE_AGENT: "true",
    };
    const backend = spawn("bun", ["run", "dev:server"], {
      cwd: session.worktreePath,
      env: { ...commonEnv, PI_WEB_PORT: String(backendPort) },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    const web = spawn("bun", ["run", "--cwd", "apps/web", "dev", "--host", bindHost, "--port", String(webPort)], {
      cwd: session.worktreePath,
      env: { ...commonEnv, VITE_PI_WEB_API_BASE: publicUrl(this.config, backendPort), VITE_PI_WEB_AUTH_TOKEN: previewAuthToken },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);

    const stack: PreviewProcess = { sessionId: session.id, cwd: session.worktreePath, backendPort, webPort, startedAt, backend, web, logPath, status: "starting" };
    this.stacks.set(session.id, stack);
    backend.on("exit", (code, signal) => {
      stack.status = "error";
      stack.error = `Preview backend exited (${code ?? signal ?? "unknown"}).`;
    });
    web.on("exit", (code, signal) => {
      stack.status = "error";
      stack.error = `Preview frontend exited (${code ?? signal ?? "unknown"}).`;
    });

    const backendReady = await waitForHealth(`http://127.0.0.1:${backendPort}/healthz`, 20_000);
    const webReady = backendReady ? await waitForHealth(`http://127.0.0.1:${webPort}`, 20_000) : false;
    if (!backendReady || !webReady) {
      stack.status = "error";
      stack.error = `Preview stack did not become ready. Logs: ${logPath}`;
      return this.status(session);
    }
    stack.status = "running";
    return this.status(session);
  }

  async stop(sessionId: string): Promise<void> {
    const stack = this.stacks.get(sessionId);
    if (!stack) return;
    stopProcess(stack.web);
    stopProcess(stack.backend);
    this.stacks.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.stacks.keys()].map((id) => this.stop(id)));
  }
}
