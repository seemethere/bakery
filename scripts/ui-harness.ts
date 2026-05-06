import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
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

type TimelineEvent = {
  time: number;
  event: string;
  [key: string]: unknown;
};

declare global {
  interface Window {
    __piWebLongTasks?: Array<{ name: string; startTime: number; duration: number }>;
    __piWebTimeline?: TimelineEvent[];
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

async function createConfiguredExtensionFixture(): Promise<{ extensionDir: string; missingExtensionPath: string }> {
  const extensionDir = await mkdtemp(join(tmpdir(), "bakery-local-extension-"));
  await mkdir(join(extensionDir, "web"), { recursive: true });
  await writeFile(join(extensionDir, "index.js"), `export default {
  id: "local.demo",
  displayName: "Local Demo",
  capabilities: ["commands", "ui:transcript.customCard"],
  web: { entry: "web/card.js" },
  ui: [{ slot: "transcript.customCard", kind: "local.demo.card", component: "local-demo-card" }],
  commands: [{
    name: "local-demo",
    description: "Render a local extension card",
    argumentHint: "[message]",
    handler: (_ctx, args) => ({
      kind: "handled",
      title: "/local-demo",
      body: "Rendered a configured local extension card.",
      card: { kind: "local.demo.card", props: { message: args || "hello from local extension" } },
    }),
  }],
};\n`, "utf8");
  await writeFile(join(extensionDir, "web", "card.js"), `class LocalDemoCard extends HTMLElement {
  connectedCallback() { this.render(); }
  static get observedAttributes() { return ["data-extension-card-props"]; }
  attributeChangedCallback() { this.render(); }
  render() {
    let props = {};
    try { props = JSON.parse(this.getAttribute("data-extension-card-props") || "{}"); } catch {}
    this.innerHTML = '<article class="local-demo-card"><strong>Local extension card</strong><p>' + String(props.message || "") + '</p></article>';
  }
}
customElements.define("local-demo-card", LocalDemoCard);\n`, "utf8");
  return { extensionDir, missingExtensionPath: join(extensionDir, "missing-extension") };
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

async function readTimeline(page: Page | undefined): Promise<TimelineEvent[]> {
  if (!page || page.isClosed()) return [];
  const pages = page.context().pages();
  const timelines = await Promise.all(pages.map(async (timelinePage, pageIndex) => {
    if (timelinePage.isClosed()) return [];
    const pageUrl = timelinePage.url();
    const events = await timelinePage.evaluate(() => window.__piWebTimeline ?? []).catch(() => []);
    return events.map((event) => ({ pageIndex, pageUrl, ...event }));
  }));
  return timelines.flat().sort((a, b) => Number(a.wallTime ?? 0) - Number(b.wallTime ?? 0));
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

  const configuredExtension = scenarios.includes("configured-extension-smoke") ? await createConfiguredExtensionFixture() : null;
  const serverEnv = {
    PI_WEB_HOST: "127.0.0.1",
    PI_WEB_PORT: String(serverPort),
    PI_WEB_WORKSPACE_ROOT: workspace,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_FAKE_AGENT: "1",
    PI_WEB_AUTH_TOKEN: "",
    PI_WEB_LOAD_GLOBAL_RESOURCES: "false",
    PI_WEB_LOAD_PROJECT_RESOURCES: "false",
    ...(configuredExtension ? { PI_WEB_EXTENSION_PATHS: `${configuredExtension.extensionDir},${configuredExtension.missingExtensionPath}` } : {}),
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
  let page: Page | undefined;
  const consoleMessages: string[] = [];
  try {
    await waitForUrl(`${apiBase}/healthz`, "server");
    await waitForUrl(webBase, "web");
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.__piWebLongTasks = [];
      window.__piWebTimeline = [];
      const pushTimeline = (event: string, data: Record<string, unknown> = {}) => {
        const target = window.__piWebTimeline ??= [];
        target.push({ time: Math.round(performance.now()), wallTime: Date.now(), event, ...data });
        if (target.length > 1_000) target.splice(0, target.length - 1_000);
      };
      const parseEnvelopeSummary = (raw: unknown): Record<string, unknown> => {
        if (typeof raw !== "string") return { dataType: typeof raw };
        try {
          const parsed = JSON.parse(raw) as { type?: unknown; sessionId?: unknown; clientId?: unknown; seq?: unknown; payload?: { type?: unknown; event?: { type?: unknown }; snapshot?: { messages?: unknown[] }; controller?: { currentClientId?: unknown; controllerId?: unknown; isController?: unknown } } };
          const payload = parsed.payload;
          return {
            type: typeof parsed.type === "string" ? parsed.type : undefined,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
            seq: typeof parsed.seq === "number" ? parsed.seq : undefined,
            payloadType: typeof payload?.type === "string" ? payload.type : undefined,
            agentEventType: typeof payload?.event?.type === "string" ? payload.event.type : undefined,
            snapshotMessages: Array.isArray(payload?.snapshot?.messages) ? payload.snapshot.messages.length : undefined,
            controllerClientId: typeof payload?.controller?.currentClientId === "string" ? payload.controller.currentClientId : undefined,
            isController: typeof payload?.controller?.isController === "boolean" ? payload.controller.isController : undefined,
          };
        } catch {
          return { parseError: true, byteLength: raw.length };
        }
      };
      try {
        const NativeWebSocket = window.WebSocket;
        let nextSocketId = 0;
        const HarnessWebSocket = function(this: WebSocket, url: string | URL, protocols?: string | string[]) {
          const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
          const socketId = ++nextSocketId;
          let path = String(url);
          try {
            const parsed = new URL(String(url));
            path = `${parsed.pathname}${parsed.search ? "?" + parsed.searchParams.toString().replace(/token=[^&]*/g, "token=<redacted>") : ""}`;
          } catch {
            // Keep the original string when URL parsing fails.
          }
          const isSessionSocket = path.includes("/api/sessions/");
          pushTimeline("ws:create", { socketId, path, isSessionSocket });
          socket.addEventListener("open", () => pushTimeline("ws:open", { socketId, isSessionSocket }));
          socket.addEventListener("close", (event) => pushTimeline("ws:close", { socketId, isSessionSocket, code: event.code, reasonLength: event.reason.length, reason: event.reason.slice(0, 160), wasClean: event.wasClean }));
          socket.addEventListener("error", () => pushTimeline("ws:error", { socketId, isSessionSocket }));
          socket.addEventListener("message", (event) => {
            if (isSessionSocket) pushTimeline("ws:message", { socketId, ...parseEnvelopeSummary(event.data) });
          });
          return socket;
        } as unknown as typeof WebSocket;
        HarnessWebSocket.prototype = NativeWebSocket.prototype;
        Object.setPrototypeOf(HarnessWebSocket, NativeWebSocket);
        window.WebSocket = HarnessWebSocket;
      } catch (error) {
        pushTimeline("timeline:websocket-patch-error", { message: error instanceof Error ? error.message : String(error) });
      }
      try {
        const recordRoute = () => pushTimeline("route", { path: location.pathname, hash: location.hash });
        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);
        history.pushState = (...args) => {
          const result = originalPushState(...args);
          recordRoute();
          return result;
        };
        history.replaceState = (...args) => {
          const result = originalReplaceState(...args);
          recordRoute();
          return result;
        };
        window.addEventListener("popstate", recordRoute);
        recordRoute();
      } catch (error) {
        pushTimeline("timeline:route-patch-error", { message: error instanceof Error ? error.message : String(error) });
      }
      try {
        let lastState = "";
        setInterval(() => {
          const app = document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } | null; status?: string; connectionState?: string; controller?: { isController?: boolean; currentClientId?: string | null; connectedClients?: number } | null } | null;
          if (!app) return;
          const state = JSON.stringify({
            sessionId: app.selectedSession?.id ?? null,
            status: app.status ?? null,
            connectionState: app.connectionState ?? null,
            isController: app.controller?.isController ?? null,
            connectedClients: app.controller?.connectedClients ?? null,
          });
          if (state === lastState) return;
          lastState = state;
          pushTimeline("app:state", JSON.parse(state) as Record<string, unknown>);
        }, 250);
      } catch (error) {
        pushTimeline("timeline:state-poll-error", { message: error instanceof Error ? error.message : String(error) });
      }
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
    page = await context.newPage();
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
    await writeFile(join(artifactDir, "timeline.json"), JSON.stringify(await readTimeline(page), null, 2));
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
    await writeFile(join(artifactDir, "timeline.json"), JSON.stringify(await readTimeline(page), null, 2));
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
