import { createWriteStream } from "node:fs";
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
  ? ["streaming-responsiveness", "queued-follow-up", "transcript-scroll-stability", "inspector-preview", "slash-commands", "tree-fork-navigation", "reconnect-controller", "controller-handoff-edges", "reconnect-draft", "backend-restart", "narrow-tool-stream", "file-autocomplete", "image-attachments", "image-artifact-paths", "repeated-image-artifact-paths", "artifact-path-formats", "model-thinking", "context-usage"]
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
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2Y9WQAAAABJRU5ErkJggg==";
const verboseChildLogs = process.env.PI_WEB_HARNESS_CHILD_LOGS === "1" || process.argv.includes("--verbose");

function spawnLogged(name: string, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const logPath = join(artifactDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  child.stdout.on("data", (chunk) => {
    log.write(`[stdout] ${chunk}`);
    if (verboseChildLogs) process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    log.write(`[stderr] ${chunk}`);
    if (verboseChildLogs) process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    const summary = code !== null ? `exited with code ${code}` : signal ? `exited with signal ${signal}` : "exited";
    log.end(`[exit] ${summary}\n`);
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
      connectionBanner: document.querySelector(".connection-banner")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
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
  await page.addInitScript(({ apiBase }) => {
    localStorage.setItem("piWebApiBase", apiBase);
    localStorage.setItem("piWebAuthToken", "");
  }, { apiBase });
  await page.goto(webBase, { waitUntil: "domcontentloaded" });
  if (await page.locator("#apiBase").count() === 0 && await page.locator("#toggleSessionSidebar").count() > 0) {
    await page.locator("#toggleSessionSidebar").click();
  }
  await page.locator("#apiBase").fill(apiBase);
  await page.locator("#token").fill("");
  await page.locator("#saveSettings").click();
  await page.waitForFunction(() => document.querySelectorAll("#workspace option").length > 0, undefined, { timeout: 5_000 });
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

async function runContextUsage(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator(".context-usage").waitFor({ timeout: 5_000 });
  const before = await page.locator(".context-usage").textContent();
  if (!before?.includes("Context") || !before.includes("/")) throw new Error(`Missing context usage label; saw ${before}`);
  await sendPromptAndWaitIdle(page, "Please produce a concise response so context usage updates.");
  const after = await page.locator(".context-usage").textContent();
  if (!after?.includes("%")) throw new Error(`Context usage did not include percentage; saw ${after}`);
  await page.screenshot({ path: join(artifactDir, "context-usage.png"), fullPage: true });
  return { before, after, ...(await collectMetrics(page)) };
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

async function runQueuedFollowUp(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please produce a long streaming response so queued follow-up cancellation and editing can be tested.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("queued follow-up that should be edited");
  await page.locator("#followUp").click();
  const editPill = page.locator(".queue-pill.follow-up", { hasText: "queued follow-up that should be edited" });
  await editPill.waitFor({ timeout: 5_000 });
  await page.locator("footer").screenshot({ path: join(artifactDir, "queued-follow-up-before-edit-composer.png") });
  await editPill.locator(".queue-edit").click();
  await editPill.waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "queued follow-up that should be edited" && document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator("#prompt").fill("queued follow-up requeued after edit");
  await page.locator("#followUp").click();
  await page.locator(".queue-pill.follow-up", { hasText: "queued follow-up requeued after edit" }).waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("queued follow-up that should be canceled");
  await page.locator("#followUp").click();
  const pill = page.locator(".queue-pill.follow-up", { hasText: "queued follow-up that should be canceled" });
  await pill.waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-before-cancel.png"), fullPage: true });
  await page.locator("footer").screenshot({ path: join(artifactDir, "queued-follow-up-before-cancel-composer.png") });
  await pill.locator(".queue-cancel").click();
  await pill.waitFor({ state: "detached", timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-after-cancel.png"), fullPage: true });
  await page.locator("footer").screenshot({ path: join(artifactDir, "queued-follow-up-after-cancel-composer.png") });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-final.png"), fullPage: true });
  return collectMetrics(page);
}

async function runTranscriptScrollStability(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please produce a very long streaming performance response with many paragraphs, markdown, code, and enough text to overflow the transcript while still streaming.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => {
    const transcript = document.querySelector(".transcript");
    return Boolean(transcript && transcript.scrollHeight > transcript.clientHeight + 180 && document.querySelector(".message.assistant"));
  }, null, { timeout: 10_000 });

  const before = await page.evaluate(() => {
    const transcript = document.querySelector(".transcript") as HTMLElement;
    transcript.scrollTop = Math.max(0, Math.floor(transcript.scrollHeight * 0.25));
    return { top: transcript.scrollTop, height: transcript.scrollHeight, clientHeight: transcript.clientHeight };
  });
  await page.locator("#jumpToLatest").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const transcript = document.querySelector(".transcript") as HTMLElement;
    return { top: transcript.scrollTop, height: transcript.scrollHeight, clientHeight: transcript.clientHeight };
  });
  const drift = Math.abs(after.top - before.top);
  if (drift > 80) throw new Error(`Transcript scroll drifted while reading: before ${before.top}, after ${after.top}, drift ${drift}`);

  await page.locator("#jumpToLatest").click();
  await page.waitForFunction(() => {
    const transcript = document.querySelector(".transcript") as HTMLElement | null;
    return Boolean(transcript && transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 60 && !document.querySelector("#jumpToLatest"));
  }, null, { timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  return { before, after, drift, ...(await collectMetrics(page)) };
}

async function runInspectorPreview(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce markdown with an image screenshot preview and run a tool for inspector validation.");
  const assistant = page.locator(".message.assistant:has(img)").last();
  await assistant.click();
  await page.waitForFunction(() => document.querySelector(".message.assistant.selected img"));
  await assistant.locator('[data-row-action="menu"]').click();
  await assistant.locator('.message-action-menu [data-row-action="preview"]').click();
  await page.locator(".preview-markdown img").first().waitFor({ timeout: 5_000 });
  await assistant.locator('[data-row-action="menu"]').click();
  await assistant.locator('.message-action-menu [data-row-action="details"]').click();
  await page.locator(".raw-detail").waitFor({ state: "visible" });
  const tool = page.locator(".message.tool").first();
  await tool.locator(".message-header").click();
  await tool.locator(".message-body").click();
  await page.locator(".right-panel-heading", { hasText: "echo fake tool" }).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runSlashCommands(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete").waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/session" }).waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/new" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/session");
  await page.locator("#send").click();
  await page.locator(".message.system", { hasText: "Fake session" }).waitFor({ timeout: 5_000 });
  const beforeNewSessions = await page.locator("[data-session-id]").count();
  await page.locator("#prompt").fill("/new with args");
  await page.locator("#send").click();
  await page.locator(".notice", { hasText: "Usage: /new" }).waitFor({ timeout: 5_000 });
  await page.waitForFunction((count) => document.querySelectorAll("[data-session-id]").length === count, beforeNewSessions);
  await page.locator("#prompt").fill("/new");
  await page.locator("#send").click();
  await page.waitForFunction((count) => document.querySelectorAll("[data-session-id]").length > count, beforeNewSessions, { timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
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
  await viewer.locator("#takeControl", { hasText: "Control requested" }).waitFor({ timeout: 5_000 });
  await page.locator(".control-request", { hasText: "Another tab wants control" }).waitFor({ timeout: 5_000 });
  await page.locator("#approveControl").click();
  await viewer.locator(".controller:not(.viewer)").waitFor({ timeout: 5_000 });
  await viewer.locator("#prompt").fill("controller handoff smoke");
  await viewer.locator("#send").click();
  await viewer.locator(".status.idle").waitFor({ timeout: 8_000 });
  await viewer.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runControllerHandoffEdges(page: Page, browser: Browser): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const context = page.context();
  const viewer = await context.newPage();
  await viewer.goto(webBase, { waitUntil: "domcontentloaded" });
  await viewer.locator(".controller.viewer").waitFor({ timeout: 5_000 });

  await viewer.locator("#takeControl").click();
  await page.locator(".control-request", { hasText: "Another tab wants control" }).waitFor({ timeout: 5_000 });
  await page.locator("#denyControl").click();
  await viewer.locator(".message.error", { hasText: "denied" }).waitFor({ timeout: 5_000 });
  await viewer.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });

  await viewer.locator("#takeControl").click();
  await viewer.locator("#takeControl", { hasText: "Control requested" }).waitFor({ timeout: 5_000 });
  await viewer.locator(".message.error", { hasText: "expired" }).waitFor({ timeout: 6_000 });
  await viewer.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await viewer.close();

  const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const owner = await isolated.newPage();
  await prepareSession(owner);
  const requester = await isolated.newPage();
  await requester.goto(webBase, { waitUntil: "domcontentloaded" });
  await requester.locator(".controller.viewer").waitFor({ timeout: 5_000 });
  await requester.locator("#takeControl").click();
  await requester.locator("#takeControl", { hasText: "Control requested" }).waitFor({ timeout: 5_000 });
  await owner.close();
  await requester.locator(".controller:not(.viewer)").waitFor({ timeout: 5_000 });
  await requester.locator("#prompt").fill("disconnected controller handoff smoke");
  await requester.locator("#send").click();
  await requester.locator(".status.idle").waitFor({ timeout: 8_000 });
  const metrics = await collectMetrics(requester);
  await isolated.close();
  return metrics;
}

async function runReconnectDraft(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft survives reload ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.locator(".connection-banner.connected", { hasText: "Draft saved locally" }).waitFor({ timeout: 5_000 });
  await page.evaluate(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { ws?: WebSocket } | null;
    app?.ws?.close();
  });
  await page.locator(".connection-banner.reconnecting").waitFor({ timeout: 5_000 });
  await page.locator(".connection-banner.connected", { hasText: "Draft saved locally" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  return collectMetrics(page);
}

async function runBackendRestart(page: Page, runtime: { restartServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft survives backend restart ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await runtime.restartServer();
  await page.locator(".connection-banner").filter({ hasText: /reconnecting|disconnected|retry/i }).waitFor({ timeout: 8_000 }).catch(() => undefined);
  await page.locator(".connection-banner.connected", { hasText: "Draft saved locally" }).waitFor({ timeout: 20_000 });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Confirm the session is usable after backend restart while preserving my draft context.");
  return collectMetrics(page);
}

async function runNarrowToolStream(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 760, height: 900 });
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Run a tool and produce a long narrow-width streaming response for layout validation.");
  const tool = page.locator(".message.tool").first();
  await tool.waitFor({ timeout: 5_000 });
  await tool.locator(".message-header").click();
  await page.waitForFunction(() => !document.querySelector(".message.tool")?.classList.contains("collapsed"));
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLElement>(".message.tool .message-body");
    return Boolean(body && body.scrollHeight > body.clientHeight && body.clientHeight < 460);
  });
  await tool.locator(".message-header").click();
  await page.waitForFunction(() => document.querySelector(".message.tool")?.classList.contains("collapsed"));
  await page.locator("#prompt").waitFor({ state: "visible" });

  // Leave this scenario in a screenshot-friendly state: the narrow-width assertions
  // above are the test, but the full-page artifact is otherwise dominated by
  // sidebars and does not show the tool activity being validated.
  await page.setViewportSize({ width: 1180, height: 900 });
  const leftToggle = page.locator("#toggleSessionSidebar");
  if (await leftToggle.isVisible().catch(() => false)) await leftToggle.click();
  const rightToggle = page.locator("#toggleRightPanel");
  if (await rightToggle.isVisible().catch(() => false)) await rightToggle.click();
  await page.locator(".message.tool").first().scrollIntoViewIfNeeded();
  return collectMetrics(page);
}

async function runFileAutocomplete(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please inspect @Button");
  await page.locator(".file-autocomplete", { hasText: "src/components/Button.ts" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes("@src/components/Button.ts "));

  await page.locator("#prompt").fill("Open @src/");
  await page.locator(".file-autocomplete", { hasText: "components/" }).waitFor({ timeout: 5_000 });
  await page.getByRole("option", { name: /src\/components\/$/ }).click();
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes("@src/components/"));
  await page.locator(".file-autocomplete", { hasText: "Button.ts" }).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runImageAttachments(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const imagePath = join(artifactDir, "fixture.png");
  await page.locator("#imageInput").setInputFiles(imagePath);
  await page.locator(".prompt-image img").waitFor({ timeout: 5_000 });
  await page.locator(".prompt-image button").click();
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });

  await page.locator("#imageInput").setInputFiles(imagePath);
  await page.locator(".prompt-image", { hasText: "fixture.png" }).waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Please inspect this attached image and include an image preview in the reply.");
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  await page.locator(".message.assistant img").first().waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list a local image artifact path for screenshot path rendering validation.");
  const image = page.locator(".artifact-image img").first();
  await image.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".artifact-image img");
    return Boolean(img?.complete && img.naturalWidth > 0);
  });
  await page.locator(".artifact-image figcaption", { hasText: "screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  await image.click();
  await page.locator(".artifact-image.expanded img").waitFor({ timeout: 5_000 });
  await image.click();
  await page.waitForFunction(() => !document.querySelector(".artifact-image")?.classList.contains("expanded"));
  return collectMetrics(page);
}

async function runRepeatedImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const prompt = "Please list a local image artifact path for repeated screenshot path rendering validation.";
  await sendPromptAndWaitIdle(page, prompt);
  await page.locator(".artifact-image img").first().waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, prompt);
  await page.waitForFunction(() => document.querySelectorAll(".artifact-image img").length >= 2, null, { timeout: 5_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const captions = await page.locator(".artifact-image figcaption", { hasText: "screenshots/fixture.png" }).count();
  if (captions < 2) throw new Error(`Expected repeated artifact path to render at least twice, saw ${captions} captions`);
  return { artifactImages: await page.locator(".artifact-image img").count(), captions, ...(await collectMetrics(page)) };
}

async function runArtifactPathFormats(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list inline fenced long artifact format variants for local screenshot rendering validation.");
  const expected = ["screenshots/inline.png", "screenshots/fenced.png", "test-results/ui-harness/sample-run/final.png"];
  await page.waitForFunction((expectedPaths) => {
    const captions = Array.from(document.querySelectorAll(".artifact-image figcaption"), (caption) => caption.textContent ?? "");
    return expectedPaths.every((path) => captions.includes(path));
  }, expected, { timeout: 5_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 3 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), expected, ...(await collectMetrics(page)) };
}

async function runModelThinking(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#model").selectOption("fake/slow");
  await page.waitForFunction(() => (document.querySelector("#model") as HTMLSelectElement | null)?.value === "fake/slow");
  await page.locator("#thinking").selectOption("high");
  await page.waitForFunction(() => (document.querySelector("#thinking") as HTMLSelectElement | null)?.value === "high");
  await sendPromptAndWaitIdle(page, "Confirm model and thinking selectors remain usable after settings updates.");
  await page.waitForFunction(() => (document.querySelector("#model") as HTMLSelectElement | null)?.value === "fake/slow");
  await page.waitForFunction(() => (document.querySelector("#thinking") as HTMLSelectElement | null)?.value === "high");
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

async function runScenario(name: string, page: Page, browser: Browser, runtime: { restartServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  if (name === "manual") return runManual(page);
  if (name === "streaming-responsiveness") return runStreamingResponsiveness(page);
  if (name === "queued-follow-up") return runQueuedFollowUp(page);
  if (name === "transcript-scroll-stability") return runTranscriptScrollStability(page);
  if (name === "inspector-preview") return runInspectorPreview(page);
  if (name === "slash-commands") return runSlashCommands(page);
  if (name === "tree-fork-navigation") return runTreeForkNavigation(page);
  if (name === "reconnect-controller") return runReconnectController(page);
  if (name === "controller-handoff-edges") return runControllerHandoffEdges(page, browser);
  if (name === "reconnect-draft") return runReconnectDraft(page);
  if (name === "backend-restart") return runBackendRestart(page, runtime);
  if (name === "narrow-tool-stream") return runNarrowToolStream(page);
  if (name === "file-autocomplete") return runFileAutocomplete(page);
  if (name === "image-attachments") return runImageAttachments(page);
  if (name === "image-artifact-paths") return runImageArtifactPaths(page);
  if (name === "repeated-image-artifact-paths") return runRepeatedImageArtifactPaths(page);
  if (name === "artifact-path-formats") return runArtifactPathFormats(page);
  if (name === "model-thinking") return runModelThinking(page);
  if (name === "context-usage") return runContextUsage(page);
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
    PI_WEB_CONTROLLER_TAKEOVER_TIMEOUT_MS: "1000",
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
