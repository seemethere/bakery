import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

declare global {
  interface Window {
    __piWebLongTasks?: Array<{ name: string; startTime: number; duration: number }>;
    __piWebPerf?: { renderCount: number; renderMs: number[]; patchCount: number; patchMs: number[]; rowUpdateCount?: number; rowUpdateMs?: number[] };
  }
}

const root = resolve(import.meta.dir, "..");
const scenario = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "streaming-responsiveness";
const scenarios = scenario === "all"
  ? ["streaming-responsiveness", "inspector-preview", "slash-commands", "tree-fork-navigation", "reconnect-controller", "narrow-tool-stream"]
  : [scenario];
const keep = process.argv.includes("--keep");
const headed = process.argv.includes("--headed") || scenario === "manual";
const interactive = scenario === "manual" || process.argv.includes("--interactive");
const serverPort = Number(process.env.PI_WEB_HARNESS_SERVER_PORT ?? "43141");
const webPort = Number(process.env.PI_WEB_HARNESS_WEB_PORT ?? "45173");
const apiBase = `http://127.0.0.1:${serverPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = resolve(root, "test-results", "ui-harness", `${scenario}-${runId}`);

function spawnLogged(name: string, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`[${name}] exited with code ${code}`);
    else if (signal) console.error(`[${name}] exited with signal ${signal}`);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError}`);
}

async function timed(label: string, action: () => Promise<unknown>): Promise<{ label: string; ms: number }> {
  const start = performance.now();
  await action();
  return { label, ms: Math.round(performance.now() - start) };
}

async function collectMetrics(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0]?.toJSON?.() ?? null;
    const resources = performance.getEntriesByType("resource").length;
    const transcript = document.querySelector(".transcript");
    const perf = window.__piWebPerf ?? null;
    const longTasks = window.__piWebLongTasks ?? [];
    const summarize = (samples: number[]) => ({
      count: samples.length,
      maxMs: samples.length ? Math.round(Math.max(...samples)) : 0,
      avgMs: samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : 0,
    });
    return {
      navigation: nav,
      resources,
      transcriptChildren: transcript?.children.length ?? 0,
      transcriptTextLength: transcript?.textContent?.length ?? 0,
      status: document.querySelector(".status")?.textContent ?? null,
      promptValue: (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value ?? null,
      rightPanelCollapsed: document.querySelector("pi-web-agent")?.classList.contains("inspector-collapsed") ?? null,
      renderedImages: document.querySelectorAll(".message img").length,
      selectedTitle: document.querySelector(".right-panel-heading strong")?.textContent ?? null,
      treeRows: document.querySelectorAll(".tree-line").length,
      sessionButtons: document.querySelectorAll("[data-session-id]").length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
      longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks.map((task) => task.duration))) : 0,
      piWebPerf: perf ? {
        renderCount: perf.renderCount,
        patchCount: perf.patchCount,
        rowUpdateCount: perf.rowUpdateCount ?? 0,
        render: summarize(perf.renderMs),
        patch: summarize(perf.patchMs),
        rowUpdate: summarize(perf.rowUpdateMs ?? []),
      } : null,
    };
  });
}

async function prepareSession(page: Page): Promise<void> {
  await page.goto(webBase, { waitUntil: "domcontentloaded" });
  await page.locator("#apiBase").fill(apiBase);
  await page.locator("#token").fill("");
  await page.locator("#saveSettings").click();
  const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/sessions` && response.request().method() === "POST" && response.status() === 201);
  await page.locator("#newSession").click();
  await created;
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
}

async function sendPromptAndWaitIdle(page: Page, text: string): Promise<void> {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
}

async function runStreamingResponsiveness(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);

  await page.locator("#prompt").fill("Please produce a long streaming performance response with markdown and code.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });

  const responsiveness: Array<{ label: string; ms: number }> = [];
  for (let i = 0; i < 12; i++) {
    responsiveness.push(await timed(`fill-prompt-${i}`, () => page.locator("#prompt").fill(`steer while streaming ${i}`)));
    if (i % 3 === 0) responsiveness.push(await timed(`toggle-inspector-${i}`, () => page.locator("#toggleRightPanel").click()));
    if (i % 4 === 0) responsiveness.push(await timed(`toggle-thinking-${i}`, () => page.locator("#showThinking").click()));
    await page.waitForTimeout(75);
  }

  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  const maxLatencyMs = Math.max(...responsiveness.map((sample) => sample.ms));
  const slowSamples = responsiveness.filter((sample) => sample.ms > 750);
  if (slowSamples.length > 0) {
    throw new Error(`Responsiveness threshold exceeded; max ${maxLatencyMs}ms; slow samples: ${JSON.stringify(slowSamples)}`);
  }

  return { responsiveness, maxLatencyMs, ...(await collectMetrics(page)) };
}

async function runInspectorPreview(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce markdown with an image screenshot preview and run a tool for inspector validation.");
  await page.locator(".message.assistant").last().click();
  await page.locator('[data-right-tab="preview"]').click();
  await page.locator(".preview-markdown img").first().waitFor({ timeout: 5_000 });
  await page.locator('[data-right-tab="details"]').click();
  await page.locator(".raw-detail").waitFor({ state: "visible" });
  await page.locator(".message.tool").first().click();
  await page.locator(".right-panel-heading", { hasText: "echo fake tool" }).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runSlashCommands(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete").waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/session" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/session");
  await page.locator("#send").click();
  await page.locator(".message.system", { hasText: "Fake session" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/tree");
  await page.locator("#send").click();
  await page.locator(".tree-drawer").waitFor({ timeout: 5_000 });
  await page.locator("#closeTreeDrawer").click();
  return collectMetrics(page);
}

async function runTreeForkNavigation(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Create a short conversation branch for tree navigation.");
  await page.locator('[data-right-tab="tree"]').click();
  await page.locator(".tree-line").first().waitFor({ timeout: 5_000 });
  await page.locator(".tree-line").first().click();
  await page.locator(".notice", { hasText: /Navigated|Tree navigation failed/ }).waitFor({ timeout: 5_000 }).catch(() => undefined);
  const forkButton = page.locator("[data-fork-entry-id]").first();
  await forkButton.waitFor({ timeout: 5_000 });
  await forkButton.click();
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  await page.locator("[data-session-id]").nth(1).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runReconnectController(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const context = page.context();
  const viewer = await context.newPage();
  await viewer.goto(webBase, { waitUntil: "domcontentloaded" });
  await viewer.locator("#prompt").waitFor({ state: "visible" });
  await viewer.locator(".controller.viewer").waitFor({ timeout: 5_000 });
  await viewer.locator("#takeControl").click();
  await viewer.locator(".controller:not(.viewer)").waitFor({ timeout: 5_000 });
  await viewer.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runNarrowToolStream(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 760, height: 900 });
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Run a tool and produce a long narrow-width streaming response for layout validation.");
  await page.locator(".message.tool").first().waitFor({ timeout: 5_000 });
  await page.locator("#prompt").waitFor({ state: "visible" });
  return collectMetrics(page);
}

async function runManual(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Manual fake-agent session ready. Try a long prompt, a prompt mentioning tool, a prompt asking for an image/screenshot preview, /session, /reload, /tree, @README.md, inspector tabs, and narrow-window resizing.");
  return collectMetrics(page);
}

function assertPerfThresholds(name: string, metrics: Record<string, unknown>): void {
  if (name === "manual" || process.env.PI_WEB_PERF_THRESHOLDS === "off") return;
  const perf = metrics.piWebPerf as { render?: { maxMs?: number }; patch?: { maxMs?: number }; rowUpdate?: { maxMs?: number } } | null | undefined;
  const failures: string[] = [];
  const longTaskCount = Number(metrics.longTaskCount ?? 0);
  const longTaskTotalMs = Number(metrics.longTaskTotalMs ?? 0);
  const longTaskMaxMs = Number(metrics.longTaskMaxMs ?? 0);
  const renderMaxMs = Number(perf?.render?.maxMs ?? 0);
  const patchMaxMs = Number(perf?.patch?.maxMs ?? 0);
  const rowUpdateMaxMs = Number(perf?.rowUpdate?.maxMs ?? 0);

  const thresholds = {
    longTaskCount: Number(process.env.PI_WEB_PERF_MAX_LONG_TASKS ?? "80"),
    longTaskTotalMs: Number(process.env.PI_WEB_PERF_MAX_LONG_TASK_TOTAL_MS ?? "8000"),
    longTaskMaxMs: Number(process.env.PI_WEB_PERF_MAX_LONG_TASK_MS ?? "1500"),
    renderMaxMs: Number(process.env.PI_WEB_PERF_MAX_RENDER_MS ?? "1000"),
    patchMaxMs: Number(process.env.PI_WEB_PERF_MAX_PATCH_MS ?? "500"),
    rowUpdateMaxMs: Number(process.env.PI_WEB_PERF_MAX_ROW_UPDATE_MS ?? "250"),
  };

  if (longTaskCount > thresholds.longTaskCount) failures.push(`longTaskCount ${longTaskCount} > ${thresholds.longTaskCount}`);
  if (longTaskTotalMs > thresholds.longTaskTotalMs) failures.push(`longTaskTotalMs ${longTaskTotalMs} > ${thresholds.longTaskTotalMs}`);
  if (longTaskMaxMs > thresholds.longTaskMaxMs) failures.push(`longTaskMaxMs ${longTaskMaxMs} > ${thresholds.longTaskMaxMs}`);
  if (renderMaxMs > thresholds.renderMaxMs) failures.push(`render.maxMs ${renderMaxMs} > ${thresholds.renderMaxMs}`);
  if (patchMaxMs > thresholds.patchMaxMs) failures.push(`patch.maxMs ${patchMaxMs} > ${thresholds.patchMaxMs}`);
  if (rowUpdateMaxMs > thresholds.rowUpdateMaxMs) failures.push(`rowUpdate.maxMs ${rowUpdateMaxMs} > ${thresholds.rowUpdateMaxMs}`);
  if (failures.length > 0) throw new Error(`Performance thresholds exceeded in ${name}: ${failures.join("; ")}`);
}

async function runScenario(name: string, page: Page, browser: Browser): Promise<Record<string, unknown>> {
  if (name === "manual") return runManual(page);
  if (name === "streaming-responsiveness") return runStreamingResponsiveness(page);
  if (name === "inspector-preview") return runInspectorPreview(page);
  if (name === "slash-commands") return runSlashCommands(page);
  if (name === "tree-fork-navigation") return runTreeForkNavigation(page);
  if (name === "reconnect-controller") return runReconnectController(page);
  if (name === "narrow-tool-stream") return runNarrowToolStream(page);
  throw new Error(`Unknown scenario: ${name}`);
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
  await writeFile(join(workspace, "README.md"), "# Temporary pi-web-agent UI harness workspace\n", "utf8");

  const server = spawnLogged("server", "bun", ["run", "dev:server"], {
    cwd: root,
    env: {
      PI_WEB_HOST: "127.0.0.1",
      PI_WEB_PORT: String(serverPort),
      PI_WEB_WORKSPACE_ROOT: workspace,
      PI_WEB_DATA_DIR: dataDir,
      PI_WEB_FAKE_AGENT: "1",
      PI_WEB_LOAD_GLOBAL_RESOURCES: "false",
      PI_WEB_LOAD_PROJECT_RESOURCES: "false",
    },
  });
  const web = spawnLogged("web", "bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(webPort)], { cwd: resolve(root, "apps/web") });

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
      metrics[name] = await runScenario(name, page, browser);
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
