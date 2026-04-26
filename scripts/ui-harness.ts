import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";

const root = resolve(import.meta.dir, "..");
const scenario = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "streaming-responsiveness";
const keep = process.argv.includes("--keep");
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
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`[${name}] exited with code ${code}`);
    else if (signal) console.error(`[${name}] exited with signal ${signal}`);
  });
  return child;
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
    return {
      navigation: nav,
      resources,
      transcriptChildren: transcript?.children.length ?? 0,
      transcriptTextLength: transcript?.textContent?.length ?? 0,
      status: document.querySelector(".status")?.textContent ?? null,
      promptValue: (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value ?? null,
      rightPanelCollapsed: document.querySelector("pi-web-agent")?.classList.contains("inspector-collapsed") ?? null,
    };
  });
}

async function runStreamingResponsiveness(page: Page): Promise<Record<string, unknown>> {
  await page.goto(webBase, { waitUntil: "domcontentloaded" });
  await page.locator("#apiBase").fill(apiBase);
  await page.locator("#token").fill("");
  await page.locator("#saveSettings").click();
  await page.locator("#newSession").click();
  await page.locator("#prompt").waitFor({ state: "visible" });

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
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));

    const metrics = scenario === "streaming-responsiveness"
      ? await runStreamingResponsiveness(page)
      : await runStreamingResponsiveness(page);

    await page.screenshot({ path: join(artifactDir, "final.png"), fullPage: true });
    await context.tracing.stop({ path: join(artifactDir, "trace.zip") });
    await writeFile(join(artifactDir, "metrics.json"), JSON.stringify({ scenario, workspace, dataDir, metrics }, null, 2));
    await writeFile(join(artifactDir, "console.log"), consoleMessages.join("\n"));
    console.log(`UI harness passed: ${scenario}`);
    console.log(`Artifacts: ${artifactDir}`);
  } catch (error) {
    await writeFile(join(artifactDir, "console.log"), consoleMessages.join("\n"));
    await writeFile(join(artifactDir, "failure.txt"), error instanceof Error ? `${error.stack ?? error.message}\n` : String(error));
    console.error(`UI harness failed. Artifacts: ${artifactDir}`);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill("SIGTERM");
    web.kill("SIGTERM");
    if (keep) console.log(`Kept temp workspace: ${workspace}\nKept temp data dir: ${dataDir}`);
  }
}

await main();
