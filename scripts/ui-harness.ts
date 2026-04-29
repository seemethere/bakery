import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium, type Browser } from "playwright";
import {
  apiBase,
  artifactDir,
  fixturePngBase64,
  headed,
  interactive,
  keep,
  root,
  scenario,
  scenarios,
  serverPort,
  verboseChildLogs,
  webBase,
  webPort,
} from "./ui-harness/config";
import { assertPerfThresholds, runScenario } from "./ui-harness/scenarios";

declare global {
  interface Window {
    __piWebLongTasks?: Array<{ name: string; startTime: number; duration: number }>;
  }
}

function spawnLogged(name: string, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const logPath = join(artifactDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  let logClosed = false;
  const writeLog = (entry: string): void => {
    if (!logClosed && !log.destroyed && log.writable) log.write(entry);
  };
  child.stdout.on("data", (chunk) => {
    writeLog(`[stdout] ${chunk}`);
    if (verboseChildLogs) process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    writeLog(`[stderr] ${chunk}`);
    if (verboseChildLogs) process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    const summary = code !== null ? `exited with code ${code}` : signal ? `exited with signal ${signal}` : "exited";
    if (!logClosed) {
      logClosed = true;
      log.end(`[exit] ${summary}\n`);
    }
    const expectedTermination = signal === "SIGTERM" || code === 143;
    if (code !== null && code !== 0 && !expectedTermination) console.error(`[${name}] ${summary}; see ${logPath}`);
    else if (signal && !expectedTermination) console.error(`[${name}] ${summary}; see ${logPath}`);
  });
  return child;
}

function stopProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(url: string, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`);
}

async function waitForInterrupt(): Promise<string> {
  return await new Promise<string>((resolve) => {
    const done = (signal: string) => {
      process.exitCode = 0;
      resolve(signal);
    };
    process.once("SIGINT", () => done("SIGINT"));
    process.once("SIGTERM", () => done("SIGTERM"));
  });
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), "pi-web-agent-ui-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-web-agent-data-"));
  await writeFile(join(artifactDir, "fixture.png"), Buffer.from(fixturePngBase64, "base64"));
  await mkdir(join(workspace, "src", "components"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(workspace, "screenshots"), { recursive: true });
  await mkdir(join(workspace, "test-results", "ui-harness", "sample-run"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Temporary pi-web-agent UI harness workspace\n", "utf8");
  await writeFile(join(workspace, "src", "components", "Button.ts"), "export const Button = 'fake harness fixture';\n", "utf8");
  await writeFile(join(workspace, "docs", "guide.md"), "# Harness Guide\n", "utf8");
  await writeFile(join(workspace, "screenshots", "fixture.png"), Buffer.from(fixturePngBase64, "base64"));
  await writeFile(join(workspace, "screenshots", "inline.png"), Buffer.from(fixturePngBase64, "base64"));
  await writeFile(join(workspace, "screenshots", "fenced.png"), Buffer.from(fixturePngBase64, "base64"));
  await writeFile(join(workspace, "test-results", "ui-harness", "sample-run", "final.png"), Buffer.from(fixturePngBase64, "base64"));

  const serverEnv = {
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_PORT: String(serverPort),
    PI_WEB_WORKSPACE_ROOT: workspace,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_FAKE_AGENT: "1",
    PI_WEB_AUTH_TOKEN: "",
    PI_WEB_LOAD_GLOBAL_RESOURCES: "false",
    PI_WEB_LOAD_PROJECT_RESOURCES: "false",
  };
  const startServer = () => spawnLogged("server", "bun", ["run", "dev:server"], { cwd: root, env: serverEnv });
  let server = startServer();
  const web = spawnLogged("web", "bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(webPort)], { cwd: resolve(root, "apps/web") });
  const runtime = {
    restartServer: async () => {
      stopProcessTree(server);
      await delay(900);
      server = startServer();
      await waitForUrl(`${apiBase}/healthz`, "restarted server", 20_000);
    },
    stopServer: async () => {
      stopProcessTree(server);
      await delay(900);
    },
  };

  let browser: Browser | undefined;
  const consoleMessages: string[] = [];
  try {
    await waitForUrl(`${apiBase}/healthz`, "server");
    await waitForUrl(webBase, "web");
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.__piWebLongTasks = [];
      try {
        const observer = new PerformanceObserver((list) => {
          const target = window.__piWebLongTasks ??= [];
          for (const entry of list.getEntries()) target.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
          if (target.length > 500) target.splice(0, target.length - 500);
        });
        observer.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
      } catch {
        // Long Task API is Chromium-only and may be unavailable in some environments.
      }
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));

    const metrics: Record<string, unknown> = {};
    for (const name of scenarios) {
      metrics[name] = await runScenario(name, page, browser, runtime);
      assertPerfThresholds(name, metrics[name] as Record<string, unknown>);
      await page.screenshot({ path: join(artifactDir, `${name}.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    await page.screenshot({ path: join(artifactDir, "final.png"), fullPage: true });
    await writeFile(join(artifactDir, "metrics.json"), JSON.stringify({ scenario, scenarios, workspace, dataDir, metrics }, null, 2));
    await writeFile(join(artifactDir, "console.log"), consoleMessages.join("\n"));

    let stoppedByUser = false;
    if (interactive) {
      console.log("\nManual UI harness is ready.");
      console.log(`Web UI:     ${webBase}`);
      console.log(`API:        ${apiBase}`);
      console.log(`Workspace:  ${workspace}`);
      console.log(`Data dir:   ${dataDir}`);
      console.log(`Artifacts:  ${artifactDir}`);
      console.log("Fake agent: enabled");
      console.log("Press Ctrl+C in this terminal to stop the harness.\n");
      const signal = await waitForInterrupt();
      stoppedByUser = true;
      console.log(`Stopping manual harness after ${signal}...`);
    }

    try {
      await context.tracing.stop({ path: join(artifactDir, "trace.zip") });
    } catch (error) {
      if (!stoppedByUser) throw error;
      await writeFile(join(artifactDir, "trace-stop-warning.txt"), error instanceof Error ? `${error.stack ?? error.message}\n` : String(error));
    }
    console.log(`UI harness passed: ${scenario}`);
    console.log(`Artifacts: ${artifactDir}`);
    console.log(`Child process logs: ${join(artifactDir, "server.log")}, ${join(artifactDir, "web.log")}`);
  } catch (error) {
    await writeFile(join(artifactDir, "console.log"), consoleMessages.join("\n"));
    await writeFile(join(artifactDir, "failure.txt"), error instanceof Error ? `${error.stack ?? error.message}\n` : String(error));
    console.error(`UI harness failed. Artifacts: ${artifactDir}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    stopProcessTree(server);
    stopProcessTree(web);
    if (keep) console.log(`Kept temp workspace: ${workspace}\nKept temp data dir: ${dataDir}`);
  }
}

await main();
