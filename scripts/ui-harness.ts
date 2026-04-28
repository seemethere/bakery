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
  ? ["empty-session-layout", "mobile-layout", "streaming-responsiveness", "queued-follow-up", "transcript-scroll-stability", "transcript-text-selection", "session-metadata", "inspector-preview", "slash-commands", "bash-commands", "question-answer", "tree-fork-navigation", "reconnect-controller", "controller-handoff-edges", "reconnect-draft", "backend-restart", "narrow-tool-stream", "tool-grouping", "tool-image-heavy-transcript", "mobile-long-transcript-controls", "file-autocomplete", "image-attachments", "image-artifact-drop-upload", "image-artifact-paths", "repeated-image-artifact-paths", "artifact-path-formats", "remote-image-artifact-paths", "remote-image-artifact-upload", "missing-remote-image-artifact", "model-thinking", "context-usage", "themes", "theme-gallery"]
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
    const summarize = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0 : 0;
      return {
        count: samples.length,
        maxMs: samples.length ? Math.round(Math.max(...samples)) : 0,
        p95Ms: Math.round(percentile(0.95)),
        avgMs: samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : 0,
      };
    };
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

async function prepareSession(page: Page): Promise<string> {
  await page.addInitScript(({ apiBase }) => {
    localStorage.setItem("piWebApiBase", apiBase);
    localStorage.setItem("piWebAuthToken", "");
  }, { apiBase });
  await page.goto(webBase, { waitUntil: "domcontentloaded" });
  if (await page.locator("#apiBase").count() === 0) {
    const mobileMenu = page.locator("#toggleSessionSidebarMobile");
    if (await mobileMenu.isVisible().catch(() => false)) await mobileMenu.click();
    else if (await page.locator("#toggleSessionSidebar").count() > 0) await page.locator("#toggleSessionSidebar").click();
  }
  await page.locator("#apiBase").fill(apiBase);
  await page.locator("#token").fill("");
  await page.locator("#saveSettings").click();
  await page.waitForFunction(() => document.querySelectorAll("#workspace option").length > 0, undefined, { timeout: 5_000 });
  const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/sessions` && response.request().method() === "POST" && response.status() === 201);
  await page.locator("#newSession").click();
  const response = await created;
  const session = await response.json() as { id: string };
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  if (await page.locator("#toggleSessionSidebarMobile").isVisible().catch(() => false)) {
    const sidebarOpen = await page.locator("pi-web-agent").evaluate((element) => !element.classList.contains("session-sidebar-collapsed"));
    if (sidebarOpen) await page.locator("#toggleSessionSidebar").click();
  }
  return session.id;
}

async function sendPromptAndWaitIdle(page: Page, text: string): Promise<void> {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
}

async function runThemeGallery(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please create a theme gallery baseline with a local image path, screenshot artifact path, and multiple tools for grouped tool activity.");
  await page.locator(".artifact-image img").first().waitFor({ timeout: 5_000 });
  await page.locator(".tool-run-group").first().waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("Please produce a long narrow running tool stream for the theme component gallery.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator(".message.tool.running").waitFor({ timeout: 10_000 });
  await page.locator("#prompt").fill("Queued follow-up visible in the theme gallery");
  await page.locator("#followUp").click();
  await page.locator(".running-queue").waitFor({ timeout: 5_000 });

  await ensureSidebarSettingsVisible(page);
  await page.locator("#themePreference").selectOption("workbench-dark");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "workbench-dark");
  await page.screenshot({ path: join(artifactDir, "theme-gallery-dark.png"), fullPage: true });

  await page.locator("#themePreference").selectOption("workbench-light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "workbench-light");
  await page.screenshot({ path: join(artifactDir, "theme-gallery-light.png"), fullPage: true });

  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  return { ...(await collectMetrics(page)) };
}

async function ensureSidebarSettingsVisible(page: Page): Promise<void> {
  if (await page.locator("#themePreference").isVisible().catch(() => false)) return;
  const app = page.locator("pi-web-agent");
  const collapsed = await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"));
  if (collapsed) {
    const mobileMenu = page.locator("#toggleSessionSidebarMobile");
    if (await mobileMenu.isVisible().catch(() => false)) await mobileMenu.click();
    else await page.locator("#toggleSessionSidebar").click();
  }
  if (!await page.locator("#themePreference").isVisible().catch(() => false)) {
    await app.evaluate((element) => {
      const appElement = element as HTMLElement & { sessionSidebarCollapsed?: boolean; render?: () => void };
      appElement.sessionSidebarCollapsed = false;
      appElement.render?.();
    });
  }
  await page.locator("#themePreference").waitFor({ state: "visible", timeout: 5_000 });
}

async function setWorkbenchTheme(page: Page, theme: "workbench-dark" | "workbench-light"): Promise<void> {
  await ensureSidebarSettingsVisible(page);
  await page.locator("#themePreference").selectOption(theme);
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.locator("#sessionSidebarBackdrop").click();
}

async function runThemes(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce a short themed transcript with a tool for visual validation.");
  await setWorkbenchTheme(page, "workbench-dark");
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: join(artifactDir, "theme-workbench-dark.png"), fullPage: true });
  await setWorkbenchTheme(page, "workbench-light");
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (darkBackground === lightBackground) throw new Error(`Theme background did not change; saw ${darkBackground}`);
  await page.screenshot({ path: join(artifactDir, "theme-workbench-light.png"), fullPage: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "workbench-light");
  return { darkBackground, lightBackground, ...(await collectMetrics(page)) };
}

async function runQuestionAnswer(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);

  await page.locator("#prompt").fill("Please trigger the question-answer scenario.");
  await page.locator("#send").click();
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-recommendation", { hasText: "smallest vertical slice" }).waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("[data-question-option-index='0'].recommended-option", { hasText: "Recommended" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "1-9" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "Esc" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-custom-field", { hasText: "Custom" }).waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-question-option-index") === "0", null, { timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-recommended-option.png"), fullPage: true });
  await setWorkbenchTheme(page, "workbench-dark");
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator("[data-question-option-index='0'].recommended-option", { hasText: "Recommended" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "Esc" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-dark.png"), fullPage: true });
  await setWorkbenchTheme(page, "workbench-light");
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator("[data-question-option-index='0'].recommended-option", { hasText: "Recommended" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "Esc" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-light.png"), fullPage: true });
  await page.locator("[data-question-option-index='0']").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-question-option-index") === "1", null, { timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-keyboard-navigation.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await page.locator(".question-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator(".message.tool", { hasText: "Bug fix" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.question", { hasText: "Q: What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.question", { hasText: "A: Bug fix" }).waitFor({ timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 10_000 });

  await page.locator("#prompt").fill("Please trigger a cancel question-answer scenario.");
  await page.locator("#send").click();
  await page.locator(".question-panel", { hasText: "Should this question be cancelled?" }).waitFor({ timeout: 5_000 });
  await page.keyboard.press("c");
  await page.waitForFunction(() => document.activeElement?.id === "questionCustomAnswer", null, { timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.locator(".question-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator(".message.tool", { hasText: "User cancelled the question" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.question.error", { hasText: "Question cancelled" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.question.error", { hasText: "A: Cancelled" }).waitFor({ timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 10_000 });

  await page.locator("#prompt").fill("Please trigger question-answer and keep it pending through reload.");
  await page.locator("#send").click();
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-question-option-index") === "0", null, { timeout: 5_000 });
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-question-option-index") === "1", null, { timeout: 5_000 });
  const viewerPage = await page.context().newPage();
  await viewerPage.goto(webBase, { waitUntil: "domcontentloaded" });
  await viewerPage.locator(".controller.viewer", { hasText: "viewer" }).waitFor({ timeout: 10_000 });
  await viewerPage.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 10_000 });
  await viewerPage.locator(".question-viewer-copy", { hasText: "Keyboard answer shortcuts are disabled" }).waitFor({ timeout: 5_000 });
  await viewerPage.screenshot({ path: join(artifactDir, "question-answer-viewer-disabled-light.png"), fullPage: true });
  await setWorkbenchTheme(viewerPage, "workbench-dark");
  await viewerPage.locator(".question-viewer-copy", { hasText: "Keyboard answer shortcuts are disabled" }).waitFor({ timeout: 5_000 });
  await viewerPage.screenshot({ path: join(artifactDir, "question-answer-viewer-disabled-dark.png"), fullPage: true });
  await viewerPage.keyboard.press("1");
  await viewerPage.keyboard.press("Escape");
  await viewerPage.waitForTimeout(300);
  await viewerPage.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await viewerPage.close();
  await page.bringToFront();
  await page.keyboard.press("c");
  await page.waitForFunction(() => document.activeElement?.id === "questionCustomAnswer", null, { timeout: 5_000 });
  await page.locator("#questionCustomAnswer").fill("Reconnect preserved this answer");
  await page.keyboard.press("Enter");
  await page.locator(".question-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator(".message.tool", { hasText: "Reconnect preserved this answer" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.question", { hasText: "A: Reconnect preserved this answer" }).waitFor({ timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer.png"), fullPage: true });
  return { ...(await collectMetrics(page)) };
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

async function runEmptySessionLayout(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator(".empty-transcript", { hasText: "Start with a workflow." }).waitFor({ timeout: 5_000 });
  await page.locator("[data-empty-quick-start='plan']", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  const assertPromptValue = async (expected: string) => {
    const actual = await page.locator("#prompt").inputValue();
    if (actual !== expected) throw new Error(`Expected prompt quick start ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
  };
  await page.locator("[data-empty-quick-start='plan']").click();
  await assertPromptValue("/plan ");
  await page.locator("#prompt").fill("");
  await page.locator("[data-empty-quick-start='file']").click();
  await assertPromptValue("@");
  await page.locator("#prompt").fill("");
  await page.locator("[data-empty-quick-start='bash']").click();
  await assertPromptValue("!");
  await page.locator("#prompt").fill("");
  await page.screenshot({ path: join(artifactDir, "empty-session-layout.png"), fullPage: true });

  const layout = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom) };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      prompt: rectOf("#prompt"),
      footer: rectOf("footer"),
      transcript: rectOf(".transcript"),
      controls: rectOf(".controls"),
    };
  });

  const promptHeight = layout.prompt?.height ?? 0;
  const footerHeight = layout.footer?.height ?? 0;
  const transcriptHeight = layout.transcript?.height ?? 0;
  if (promptHeight > 80) throw new Error(`Empty session prompt is too tall: ${promptHeight}px`);
  if (footerHeight > 125) throw new Error(`Empty session footer is too tall: ${footerHeight}px`);
  if (transcriptHeight < 600) throw new Error(`Empty session transcript is too short: ${transcriptHeight}px`);
  if (layout.prompt && layout.controls && layout.prompt.left + layout.prompt.width > layout.controls.left) {
    throw new Error(`Empty session controls overlap prompt: prompt right ${layout.prompt.left + layout.prompt.width}px, controls left ${layout.controls.left}px`);
  }
  return { ...(await collectMetrics(page)), layout };
}

async function runMobileLayout(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("piWebSessionSidebarCollapsed", "true");
    localStorage.setItem("piWebRightPanelCollapsed", "true");
    localStorage.setItem("piWebSessionSidebarPinned", "false");
    localStorage.setItem("piWebCollapsedSessionGroups", JSON.stringify(["this-week", "older"]));
  });
  await prepareSession(page);
  await page.locator(".empty-transcript", { hasText: "Start with a workflow." }).waitFor({ timeout: 5_000 });
  const mobileEmptyLayout = await page.evaluate(() => {
    const transcript = document.querySelector(".transcript")?.getBoundingClientRect();
    const quickStarts = document.querySelector(".empty-quick-starts")?.getBoundingClientRect();
    const jumpToLatest = document.querySelector("#jumpToLatest")?.getBoundingClientRect();
    return {
      transcript: transcript ? { height: Math.round(transcript.height), width: Math.round(transcript.width) } : null,
      quickStarts: quickStarts ? { height: Math.round(quickStarts.height), width: Math.round(quickStarts.width) } : null,
      hasJumpToLatest: Boolean(jumpToLatest),
    };
  });
  if (mobileEmptyLayout.hasJumpToLatest) throw new Error("Empty mobile session should not show Jump to latest");
  if ((mobileEmptyLayout.quickStarts?.height ?? 999) > 310) throw new Error(`Mobile quick starts are too tall: ${mobileEmptyLayout.quickStarts?.height}px`);
  if ((mobileEmptyLayout.quickStarts?.width ?? 0) > (mobileEmptyLayout.transcript?.width ?? 0)) throw new Error(`Mobile quick starts overflow transcript: ${JSON.stringify(mobileEmptyLayout)}`);
  await page.screenshot({ path: join(artifactDir, "mobile-empty-quick-starts.png"), fullPage: true });
  const app = page.locator("pi-web-agent");
  if (!await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"))) await page.locator("#toggleSessionSidebar").click();
  await page.locator("#toggleSessionSidebarMobile").waitFor({ timeout: 5_000 });
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".context-usage", { hasText: "Ctx" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("Mobile layout regression draft");
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  const originalSessionId = await page.locator(".session-card.active").getAttribute("data-session-id");
  if (!originalSessionId) throw new Error("Could not find active mobile session before selection smoke.");
  const createdMobileSession = page.waitForResponse((response) => response.url() === `${apiBase}/api/sessions` && response.request().method() === "POST" && response.status() === 201);
  await page.locator(".session-sidebar:not(.collapsed) #newSession").click();
  const mobileSession = await (await createdMobileSession).json() as { id: string };
  await page.waitForFunction((sessionId) => (document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } } | null)?.selectedSession?.id === sessionId, mobileSession.id, { timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(`.session-sidebar:not(.collapsed) [data-session-id="${originalSessionId}"]`).click();
  await page.waitForFunction((sessionId) => (document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } } | null)?.selectedSession?.id === sessionId, originalSessionId, { timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  await page.evaluate(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { sessions?: Array<Record<string, unknown>>; render?: () => void } | null;
    const current = app?.sessions?.[0];
    if (!app?.sessions || !current) return;
    (window as unknown as { __mobileOriginalSessions?: Array<Record<string, unknown>> }).__mobileOriginalSessions = app.sessions;
    const clone = (suffix: string, daysAgo: number, title: string) => {
      const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      return { ...current, id: `${current.id}-${suffix}`, title, lastActivityAt: date, lastOpenedAt: date, status: "idle" };
    };
    app.sessions = [current, clone("yesterday", 1, "Yesterday mobile smoke"), clone("week", 3, "Earlier week mobile smoke"), clone("older", 12, "Older mobile smoke")];
    app.render?.();
  });
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  const drawerOrder = await page.evaluate(() => {
    const drawerElements = Array.from(document.querySelectorAll(".session-sidebar:not(.collapsed) *"));
    const group = (id: string) => {
      const heading = document.querySelector(`[data-session-group='${id}'] .session-group-heading`);
      return {
        expanded: heading?.getAttribute("aria-expanded"),
        cards: document.querySelectorAll(`[data-session-group='${id}'] [data-session-id]`).length,
      };
    };
    return {
      newSessionIndex: drawerElements.findIndex((element) => element.id === "newSession"),
      firstGroupIndex: drawerElements.findIndex((element) => element.classList.contains("session-group-heading")),
      apiBaseIndex: drawerElements.findIndex((element) => element.id === "apiBase"),
      pinButtonCount: document.querySelectorAll("#pinSessionSidebar").length,
      backdropVisible: !!document.querySelector("#sessionSidebarBackdrop"),
      groups: {
        today: group("today"),
        yesterday: group("yesterday"),
        thisWeek: group("this-week"),
        older: group("older"),
      },
    };
  });
  if (!drawerOrder.backdropVisible) throw new Error("Mobile drawer should render a backdrop while open.");
  if (drawerOrder.pinButtonCount !== 0) throw new Error("Mobile drawer should not show the desktop Pin affordance.");
  if (drawerOrder.groups.today.expanded !== "true" || drawerOrder.groups.today.cards < 1) throw new Error(`Mobile Today group should be expanded with sessions: ${JSON.stringify(drawerOrder.groups.today)}`);
  if (drawerOrder.groups.yesterday.expanded !== "true" || drawerOrder.groups.yesterday.cards < 1) throw new Error(`Mobile Yesterday group should be expanded with sessions: ${JSON.stringify(drawerOrder.groups.yesterday)}`);
  if (drawerOrder.groups.thisWeek.expanded !== "false" || drawerOrder.groups.older.expanded !== "false") throw new Error(`Mobile older groups should default collapsed: ${JSON.stringify(drawerOrder.groups)}`);
  await page.evaluate(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { sessions?: Array<Record<string, unknown>>; render?: () => void } | null;
    const original = (window as unknown as { __mobileOriginalSessions?: Array<Record<string, unknown>> }).__mobileOriginalSessions;
    if (app?.sessions && original) {
      app.sessions = original;
      app.render?.();
    }
  });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click());
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "mobile-layout.png"), fullPage: true });

  const layout = await page.evaluate((drawerOrder) => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom), right: Math.round(rect.right) };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      app: rectOf("pi-web-agent"),
      header: rectOf("header"),
      transcript: rectOf(".transcript"),
      footer: rectOf("footer"),
      prompt: rectOf("#prompt"),
      controls: rectOf(".controls"),
      contextUsage: rectOf(".context-usage"),
      contextUsageText: document.querySelector(".context-usage")?.textContent?.trim() ?? "",
      modelThinkingTrigger: rectOf("#modelThinkingToggle"),
      modelThinkingText: document.querySelector("#modelThinkingToggle")?.textContent?.trim() ?? "",
      mobileMenu: rectOf("#toggleSessionSidebarMobile"),
      closedSidebar: rectOf(".session-sidebar.collapsed"),
      rightPanel: rectOf(".right-panel"),
      drawerOrder,
    };
  }, drawerOrder);

  const viewportWidth = layout.viewport.width;
  if (layout.documentWidth > viewportWidth + 2) throw new Error(`Mobile layout has horizontal overflow: document ${layout.documentWidth}px, viewport ${viewportWidth}px`);
  if ((layout.mobileMenu?.width ?? 0) < 30) throw new Error(`Mobile hamburger missing or too small: ${layout.mobileMenu?.width}px`);
  if (layout.closedSidebar !== null) throw new Error(`Mobile closed sidebar should not occupy a rail: ${JSON.stringify(layout.closedSidebar)}`);
  if (layout.rightPanel !== null) throw new Error(`Mobile inspector should be detached, saw ${JSON.stringify(layout.rightPanel)}`);
  if (!layout.contextUsage || !layout.contextUsageText.includes("Ctx")) throw new Error(`Mobile context usage should be visible and compact: ${JSON.stringify({ rect: layout.contextUsage, text: layout.contextUsageText })}`);
  if (!layout.modelThinkingTrigger || !layout.modelThinkingText) throw new Error(`Mobile model/thinking trigger should be visible: ${JSON.stringify({ rect: layout.modelThinkingTrigger, text: layout.modelThinkingText })}`);
  if (layout.drawerOrder.newSessionIndex < 0 || layout.drawerOrder.firstGroupIndex < 0 || layout.drawerOrder.apiBaseIndex < 0 || layout.drawerOrder.newSessionIndex > layout.drawerOrder.firstGroupIndex || layout.drawerOrder.firstGroupIndex > layout.drawerOrder.apiBaseIndex) throw new Error(`Mobile drawer should put session creation/groups before settings: new=${layout.drawerOrder.newSessionIndex}, group=${layout.drawerOrder.firstGroupIndex}, api=${layout.drawerOrder.apiBaseIndex}`);
  if ((layout.header?.height ?? 999) > 140) throw new Error(`Mobile header too tall: ${layout.header?.height}px`);
  if ((layout.footer?.height ?? 999) > 170) throw new Error(`Mobile footer too tall: ${layout.footer?.height}px`);
  if ((layout.transcript?.height ?? 0) < 360) throw new Error(`Mobile transcript too short: ${layout.transcript?.height}px`);
  await page.locator("#modelThinkingToggle").click();
  const mobilePickerPopover = await page.evaluate(() => {
    const element = document.querySelector(".model-thinking-popover");
    if (!element || getComputedStyle(element).display === "none") return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  if (!mobilePickerPopover || mobilePickerPopover.height < 60 || mobilePickerPopover.bottom > mobilePickerPopover.viewportHeight + 1 || mobilePickerPopover.left < -1 || mobilePickerPopover.right > mobilePickerPopover.viewportWidth + 1) throw new Error(`Mobile model/thinking popover should open visibly within the viewport: ${JSON.stringify(mobilePickerPopover)}`);
  await page.locator("#thinking").selectOption("high");
  await page.waitForFunction(() => document.querySelector("#modelThinkingToggle")?.textContent?.includes("high"), null, { timeout: 5_000 });
  if (layout.prompt && layout.controls && layout.prompt.bottom > layout.controls.top) {
    throw new Error(`Mobile controls overlap prompt: prompt bottom ${layout.prompt.bottom}px, controls top ${layout.controls.top}px`);
  }

  await sendPromptAndWaitIdle(page, "Improve mobile title and summary generation controls.");
  await page.locator("#generateMetadata").click();
  await page.locator(".metadata-mobile-popover #metadataSuggestionTitle").waitFor({ timeout: 5_000 });
  const sheet = await page.evaluate(() => {
    const element = document.querySelector(".metadata-mobile-popover");
    const trigger = document.querySelector("#generateMetadata");
    if (!element || !trigger) return null;
    const rect = element.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), viewportHeight: window.innerHeight, triggerBottom: Math.round(triggerRect.bottom) };
  });
  if (!sheet || sheet.bottom > sheet.viewportHeight + 1 || sheet.width < 300 || sheet.top > sheet.triggerBottom + 70) throw new Error(`Mobile metadata popover should be visible near the trigger: ${JSON.stringify(sheet)}`);
  await page.locator(".metadata-mobile-popover #metadataSuggestionTitle").fill("Mobile metadata smoke");
  await page.screenshot({ path: join(artifactDir, "mobile-metadata-popover.png"), fullPage: true });
  await page.locator('.metadata-mobile-popover [data-accept-metadata="title"]', { hasText: "✓" }).click();
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.value === "Mobile metadata smoke", null, { timeout: 5_000 });

  await page.locator("#prompt").fill("Please produce a very long streaming performance response for mobile queued section collapse smoke.");
  await page.locator("#send").click();
  await page.locator("#followUp:not(.hidden)").waitFor({ timeout: 5_000 });
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("mobile queued steer should start collapsed");
  await page.locator("#send").click();
  const collapsedQueue = page.locator(".running-queue.collapsed", { hasText: "1 pending" });
  await collapsedQueue.waitFor({ timeout: 5_000 });
  await page.locator(".queue-pill", { hasText: "mobile queued steer should start collapsed" }).waitFor({ state: "detached", timeout: 2_000 });
  const collapsedQueueLayout = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height), position: style.position };
    };
    return { transcript: rectOf(".transcript"), queue: rectOf(".running-queue"), footer: rectOf("footer") };
  });
  if (collapsedQueueLayout.queue?.position === "absolute") throw new Error(`Mobile queued section should be inline, not overlayed: ${JSON.stringify(collapsedQueueLayout)}`);
  if (collapsedQueueLayout.transcript && collapsedQueueLayout.queue && collapsedQueueLayout.transcript.bottom > collapsedQueueLayout.queue.top + 1) throw new Error(`Mobile queue overlaps transcript: ${JSON.stringify(collapsedQueueLayout)}`);
  if (collapsedQueueLayout.queue && collapsedQueueLayout.footer && collapsedQueueLayout.queue.bottom > collapsedQueueLayout.footer.top + 1) throw new Error(`Mobile queue overlaps footer: ${JSON.stringify(collapsedQueueLayout)}`);
  await page.locator("#toggleRunningQueueSection").click();
  const mobileQueuedPill = page.locator(".running-queue:not(.collapsed) .queue-pill", { hasText: "mobile queued steer should start collapsed" });
  await mobileQueuedPill.waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "mobile-queued-expanded.png"), fullPage: true });

  return { ...(await collectMetrics(page)), layout, metadataPopover: sheet, collapsedQueueLayout };
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
  await page.locator("#prompt").fill("Please produce a long streaming response and consume queued follow-up before transcript so queued follow-up cancellation and editing can be tested.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("queued follow-up consumed before transcript row");
  await page.locator("#followUp").click();
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "", null, { timeout: 5_000 });
  const consumedPill = page.locator(".queue-pill.follow-up", { hasText: "queued follow-up consumed before transcript row" });
  await consumedPill.waitFor({ timeout: 5_000 });
  await page.locator(".queue-pill.pending-transcript", { hasText: "queued follow-up consumed before transcript row" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-pending-transcript.png"), fullPage: true });
  await page.locator(".message.user", { hasText: "queued follow-up consumed before transcript row" }).waitFor({ timeout: 5_000 });
  await consumedPill.waitFor({ state: "detached", timeout: 5_000 });

  const imagePath = join(artifactDir, "fixture.png");
  await page.locator("#prompt").fill("queued steer mixed with follow-ups");
  await page.locator("#send").click();
  await page.locator(".queue-pill.steer", { hasText: "queued steer mixed with follow-ups" }).waitFor({ timeout: 5_000 });

  await chooseImageWithPaperclip(page, imagePath);
  await page.locator(".prompt-image", { hasText: "fixture.png" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("queued follow-up with screenshot");
  await page.locator("#followUp").click();
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".queue-pill.follow-up", { hasText: "queued follow-up with screenshot" }).waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("queued follow-up that should be edited");
  await page.locator("#followUp").click();
  const editPill = page.locator(".queue-pill.follow-up", { hasText: "queued follow-up that should be edited" });
  await editPill.waitFor({ timeout: 5_000 });
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-before-edit.png"), fullPage: true });
  await editPill.locator(".queue-edit").click();
  await editPill.waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "queued follow-up that should be edited" && document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator("#prompt").fill("queued follow-up requeued after edit");
  await page.locator("#followUp").click();
  await page.locator(".queue-pill.follow-up", { hasText: "queued follow-up requeued after edit" }).waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("extra queued steer for overflow");
  await page.locator("#send").click();
  await page.locator(".queue-more", { hasText: "+1 more" }).waitFor({ timeout: 5_000 });
  await page.locator(".queue-more").click();
  await page.locator(".queue-more", { hasText: "Show less" }).waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("queued follow-up that should be canceled");
  await page.locator("#followUp").click();
  const pill = page.locator(".queue-pill.follow-up", { hasText: "queued follow-up that should be canceled" });
  await pill.waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-before-cancel.png"), fullPage: true });
  await pill.locator(".queue-cancel").click();
  await pill.waitFor({ state: "detached", timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-after-cancel.png"), fullPage: true });
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
    const maxScrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    transcript.scrollTop = Math.max(0, Math.floor(maxScrollTop * 0.25));
    transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
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

async function runTranscriptTextSelection(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce a concise markdown response with several words that can be selected for regression coverage.");
  const markdown = page.locator(".message.assistant .markdown-body").last();
  await markdown.waitFor({ timeout: 5_000 });
  const box = await markdown.boundingBox();
  if (!box) throw new Error("Could not find assistant markdown bounds for text selection test.");

  await page.mouse.move(box.x + 12, box.y + Math.min(28, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 12, 260), box.y + Math.min(28, box.height / 2), { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);

  const selectedText = await page.evaluate(() => window.getSelection()?.toString().trim() ?? "");
  if (selectedText.length < 3) throw new Error(`Expected selected markdown text to survive row click handling; saw ${JSON.stringify(selectedText)}`);
  await page.screenshot({ path: join(artifactDir, "transcript-text-selection.png"), fullPage: true });
  return { selectedText, ...(await collectMetrics(page)) };
}

async function runSessionMetadata(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);

  await sendPromptAndWaitIdle(page, "what's next?");
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.placeholder === "New session", null, { timeout: 5_000 });

  await page.locator("#sessionTitle").fill("Manual metadata smoke");
  await page.locator("#sessionTitle").press("Enter");
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.value === "Manual metadata smoke", null, { timeout: 5_000 });
  await ensureSidebarSettingsVisible(page);
  await page.locator(".session-card.active", { hasText: "Manual metadata smoke" }).waitFor({ timeout: 5_000 });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.locator("#sessionSidebarBackdrop").click();

  await page.locator("#prompt").click();
  await page.locator("#prompt").fill("/name Canonical slash title");
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "/name Canonical slash title");
  await page.locator("#send:not([disabled])").click();
  await page.locator(".message.system", { hasText: "Session title set to: Canonical slash title" }).waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.value === "Canonical slash title", null, { timeout: 5_000 });

  await page.locator("#prompt").click();
  await page.locator("#prompt").fill("/name --clear");
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "/name --clear");
  await page.locator("#send:not([disabled])").click();
  await page.locator(".message.system", { hasText: "Session title cleared" }).waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.value === "", null, { timeout: 5_000 });
  const clearedPlaceholder = await page.locator("#sessionTitle").getAttribute("placeholder");
  if (clearedPlaceholder !== "New session") throw new Error(`Expected generic cleared session placeholder to be New session, saw ${clearedPlaceholder}`);

  await sendPromptAndWaitIdle(page, "Improve session summaries and title generation with dedicated harness coverage.");
  await page.locator("#generateMetadata").click();
  await page.locator(".metadata-suggestion", { hasText: "Suggested title" }).waitFor({ timeout: 5_000 });
  await page.locator("#metadataSuggestionTitle").waitFor({ timeout: 5_000 });
  await page.locator("#regenerateMetadata", { hasText: "Regenerate" }).waitFor({ timeout: 5_000 });
  if (await page.locator("#metadataSuggestionSummary").count()) throw new Error("Heuristic metadata should not present fake summaries.");
  await page.locator("#metadataSuggestionTitle").fill("Improve summaries metadata smoke");
  await page.locator('[data-accept-metadata="title"]', { hasText: "✓" }).click();
  await page.waitForFunction(() => (document.querySelector("#sessionTitle") as HTMLInputElement | null)?.value.includes("summaries"), null, { timeout: 5_000 });

  await ensureSidebarSettingsVisible(page);
  const sessionId = await page.locator(".session-card.active").getAttribute("data-session-id");
  if (!sessionId) throw new Error("Could not find active session id for summary patch.");
  const summary = "Manual summary preview from metadata harness. It should appear collapsed in the header and as the session-card snippet.";
  await page.evaluate(async ({ apiBase, sessionId, summary }) => {
    const response = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary }),
    });
    if (!response.ok) throw new Error(`summary patch failed: ${response.status}`);
    await (document.querySelector("pi-web-agent") as unknown as { refresh(): Promise<void> } | null)?.refresh();
  }, { apiBase, sessionId, summary });
  await page.locator("#toggleSessionSummary", { hasText: "Summary — Manual summary preview" }).waitFor({ timeout: 5_000 });
  await page.locator(".session-card.active .session-snippet", { hasText: "Manual summary preview" }).waitFor({ timeout: 5_000 });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.locator("#sessionSidebarBackdrop").click();
  await page.locator("#toggleSessionSummary").click();
  await page.locator(".session-summary-body", { hasText: summary }).waitFor({ timeout: 5_000 });
  await page.locator("#toggleSessionSummary").click();
  await page.locator(".session-summary-body").waitFor({ state: "detached", timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "session-metadata.png"), fullPage: true });
  return collectMetrics(page);
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
  await tool.locator(".message-body").waitFor({ state: "hidden", timeout: 5_000 });
  await tool.locator('[data-row-action="toggle-output"]').click();
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
  await page.locator(".command-autocomplete", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/session");
  await page.locator("#send").click();
  await page.locator(".message.system", { hasText: "Fake session" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/plan choosing the next UX slice");
  await page.locator("#send").click();
  await page.locator(".message.user", { hasText: "Launched /plan workflow." }).waitFor({ timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Focus: choosing the next UX slice" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Question discipline:" }).waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-options button").first().click();
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  const planMessage = page.locator(".message.assistant", { hasText: "Recommendation: start with the smallest vertical slice" }).last();
  await planMessage.waitFor({ timeout: 5_000 });
  await planMessage.locator(".plan-action-row").waitFor({ state: "detached", timeout: 5_000 });
  const planActions = page.locator(".plan-composer-takeover", { hasText: "Plan ready" });
  await planActions.waitFor({ timeout: 5_000 });
  await planActions.locator('[data-plan-action="accept"]').waitFor({ timeout: 5_000 });
  await planActions.locator('[data-plan-action="chat"]').waitFor({ timeout: 5_000 });
  await planActions.locator('[data-plan-action="feedback"]').waitFor({ state: "detached", timeout: 5_000 });
  await planActions.locator('[data-plan-action="cancel"]').waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("#prompt").waitFor({ state: "detached", timeout: 5_000 });
  await planActions.locator('[data-plan-action="chat"]').click();
  await page.locator(".plan-composer-takeover").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("#prompt").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#prompt")?.value ?? "") === "", null, { timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Back to chat" }).waitFor({ state: "detached", timeout: 1_500 }).catch(() => undefined);
  await page.locator(".status.idle").waitFor({ timeout: 10_000 });
  await ensureSidebarSettingsVisible(page);
  await page.locator(".session-card.active .session-snippet", { hasText: "Launched /plan workflow" }).waitFor({ timeout: 5_000 });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.locator("#sessionSidebarBackdrop").click();
  await page.locator("#prompt").fill("/tree");
  await page.locator("#send").click();
  await page.locator(".tree-drawer", { hasText: "Session Tree" }).waitFor({ timeout: 5_000 });
  await page.locator(".tree-drawer", { hasText: "Question discipline:" }).waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("#closeTreeDrawer").click();
  const beforeNewSessions = await page.locator("pi-web-agent").evaluate((element) => ((element as unknown as { sessions?: unknown[] }).sessions ?? []).length);
  await page.locator("#prompt").fill("/new with args");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("Usage: /new"), null, { timeout: 5_000 });
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length === count, beforeNewSessions);
  await page.locator("#prompt").fill("/new");
  await page.locator("#send").click();
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length > count, beforeNewSessions, { timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator("#prompt").fill("/tree");
  await page.locator("#send").click();
  await page.locator(".tree-drawer").waitFor({ timeout: 5_000 });
  await page.locator("#closeTreeDrawer").click();
  return collectMetrics(page);
}

async function runBashCommands(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("!echo bakery bash");
  await page.locator("#send").click();
  const bashRow = page.locator(".message.tool.developer-bash:not(.collapsed)", { hasText: "$ echo bakery bash" }).last();
  await bashRow.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("pi-transcript-row.developer-bash:not(.collapsed)")).some((row) => (row.shadowRoot?.textContent ?? row.textContent ?? "").includes("bakery bash")), null, { timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "", null, { timeout: 5_000 });

  await page.locator("#prompt").fill("!!echo bakery hidden");
  await page.locator("#send").click();
  const hiddenRow = page.locator(".message.tool.developer-bash:not(.collapsed)", { hasText: "$ echo bakery hidden (no context)" }).last();
  await hiddenRow.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("pi-transcript-row.developer-bash:not(.collapsed)")).some((row) => (row.shadowRoot?.textContent ?? row.textContent ?? "").includes("bakery hidden")), null, { timeout: 5_000 });
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("Please produce a long streaming performance response while bash is blocked.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("!echo blocked while running");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("Bash commands are available when the session is idle"), null, { timeout: 5_000 });
  await page.locator(".message.tool", { hasText: "blocked while running" }).waitFor({ state: "detached", timeout: 1_000 });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  return collectMetrics(page);
}

async function runTreeForkNavigation(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  for (let index = 0; index < 12; index += 1) {
    await sendPromptAndWaitIdle(page, `Create tree navigation row ${index + 1}.`);
  }
  await page.locator("#prompt").fill("/tree");
  await page.locator("#prompt").press("Enter");
  await page.locator(".tree-drawer").waitFor({ timeout: 5_000 });
  await page.locator(".tree-line").first().waitFor({ timeout: 5_000 });
  const drawer = page.locator(".tree-drawer");
  await drawer.locator(".tree-current-path", { hasText: "Current path" }).waitFor({ timeout: 5_000 });
  await drawer.locator(".tree-path-segment.leaf").waitFor({ timeout: 5_000 });
  await drawer.locator(".tree-line.current").waitFor({ timeout: 5_000 });
  await drawer.locator(".tree-line.current-path").first().waitFor({ timeout: 5_000 });
  await drawer.locator('.tree-line[tabindex="0"]').waitFor({ timeout: 5_000 });
  await page.locator(".tree-drawer .tree-panel").evaluate((element) => {
    const maxScroll = element.scrollHeight - element.clientHeight;
    if (maxScroll <= 0) throw new Error("Tree drawer is not tall enough to validate scroll behavior");
    if (element.scrollTop > maxScroll / 2) throw new Error(`Newest-first tree opened too far from the current leaf; scrollTop=${element.scrollTop}, max=${maxScroll}`);
  });
  await drawer.locator(".tree-line").first().evaluate((element) => {
    if (!element.classList.contains("current")) throw new Error("Newest-first tree did not render the current leaf first");
    const rect = element.getBoundingClientRect();
    const panel = element.closest(".tree-panel")?.getBoundingClientRect();
    if (!panel || rect.bottom < panel.top || rect.top > panel.bottom) throw new Error("Current leaf row is not visible after opening /tree");
  });
  await drawer.locator(".tree-line").first().focus();
  await page.keyboard.press("ArrowDown");
  await drawer.locator(".tree-line").nth(1).evaluate((element) => {
    if (document.activeElement !== element) throw new Error("ArrowDown did not move tree focus to the next row");
  });
  await page.keyboard.press("Home");
  await drawer.locator(".tree-line").first().evaluate((element) => {
    if (document.activeElement !== element) throw new Error("Home did not move tree focus to the first row");
  });
  await page.screenshot({ path: join(artifactDir, "tree-current-path.png"), fullPage: true });
  await page.keyboard.press("Enter");
  await page.locator(".notice", { hasText: /Navigated|Tree navigation failed/ }).waitFor({ timeout: 5_000 }).catch(() => undefined);
  const forkableRow = page.locator('.tree-line[data-tree-forkable="true"]').first();
  await forkableRow.waitFor({ timeout: 5_000 });
  await forkableRow.focus();
  await page.keyboard.press("f");
  await page.locator(".status.idle").waitFor({ timeout: 5_000 });
  await ensureSidebarSettingsVisible(page);
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

async function runConnectionDisconnected(page: Page, runtime: { stopServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft while backend is down ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await runtime.stopServer();
  await page.locator(".connection-banner").filter({ hasText: /reconnecting|disconnected|retry/i }).waitFor({ timeout: 8_000 });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.screenshot({ path: join(artifactDir, "connection-disconnected.png"), fullPage: true });
  return collectMetrics(page);
}

async function runNarrowToolStream(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 800, height: 900 });
  await prepareSession(page);
  await page.locator("#prompt").fill("Run a tool and produce a long narrow-width streaming response for layout validation.");
  await page.locator("#send").click();
  await page.locator(".status.running").waitFor({ timeout: 5_000 });
  await page.locator(".composer-activity", { hasText: /\$|Pi is/ }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "composer-activity-running.png"), fullPage: true });
  await page.locator(".status.idle").waitFor({ timeout: 30_000 });
  await page.locator(".composer-activity").waitFor({ state: "detached", timeout: 5_000 });
  const tool = page.locator(".message.tool").first();
  await tool.waitFor({ timeout: 5_000 });
  await tool.locator('[data-row-action="toggle-output"]').click();
  await page.waitForFunction(() => !document.querySelector(".message.tool")?.classList.contains("collapsed"));
  await page.waitForFunction(() => {
    const body = document.querySelector<HTMLElement>(".message.tool .message-body");
    return Boolean(body && body.scrollHeight > body.clientHeight && body.clientHeight < 460);
  });
  await tool.locator('[data-row-action="toggle-output"]').click();
  await page.waitForFunction(() => document.querySelector(".message.tool")?.classList.contains("collapsed"));
  await page.waitForFunction(() => {
    const summary = document.querySelector<HTMLElement>(".message.tool .tool-summary")?.textContent ?? "";
    return /\d+ lines ·/.test(summary) && !/running fake tool|stdout:|exit code:\s*0/i.test(summary);
  });
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

async function runToolGrouping(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please run multiple tools for compact grouping validation.");
  const group = page.locator(".tool-run-group").first();
  await group.waitFor({ timeout: 5_000 });
  await page.locator(".tool-run-group summary", { hasText: /Ran 4 tools · \d/ }).waitFor({ timeout: 5_000 });
  await page.locator(".tool-run-group summary", { hasText: "read screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  const visibleToolRowsBefore = await page.locator(".tool-run-group .message.tool:visible").count();
  if (visibleToolRowsBefore !== 0) throw new Error(`Expected grouped tool rows to be hidden before expansion, saw ${visibleToolRowsBefore}`);
  await group.locator("summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".tool-run-group[open] .message.tool").length >= 4);
  await page.locator(".tool-run-group[open] .message.tool", { hasText: "read screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  const overflowButtons = page.locator('.tool-run-group[open] .message.tool [data-row-action="menu"]');
  await overflowButtons.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 1);
  await overflowButtons.nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 1);
  await page.locator(".transcript").click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 0);
  await page.screenshot({ path: join(artifactDir, "tool-grouping-expanded.png"), fullPage: true });
  await group.locator("summary").click();
  await page.waitForFunction(() => !document.querySelector(".tool-run-group")?.hasAttribute("open"));
  return { groups: await page.locator(".tool-run-group").count(), ...(await collectMetrics(page)) };
}

async function runToolImageHeavyTranscript(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce a tool-image-heavy transcript for performance measurement.");
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 80, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 1 && images.slice(0, 12).every((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15_000 });
  const responsiveness = [
    await timed("fill-prompt-after-heavy-transcript", () => page.locator("#prompt").fill("typing after tool/image-heavy transcript")),
    await timed("toggle-inspector-after-heavy-transcript", () => page.locator("#toggleRightPanel").click()),
    await timed("toggle-thinking-after-heavy-transcript", () => page.locator("#showThinking").click()),
  ];
  await page.screenshot({ path: join(artifactDir, "tool-image-heavy-transcript.png"), fullPage: true });
  return {
    responsiveness,
    maxLatencyMs: Math.max(...responsiveness.map((sample) => sample.ms)),
    toolRows: await page.locator(".message.tool").count(),
    artifactImages: await page.locator(".artifact-image img").count(),
    ...(await collectMetrics(page)),
  };
}

async function runMobileLongTranscriptControls(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareSession(page);
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("mobile-layout"), null, { timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Please produce a tool-image-heavy transcript for mobile control latency measurement.");
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 80, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 1 && images.slice(0, 12).every((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15_000 });
  await page.evaluate(() => {
    if (window.__piWebPerf) {
      window.__piWebPerf.renderCount = 0;
      window.__piWebPerf.renderMs = [];
      window.__piWebPerf.patchCount = 0;
      window.__piWebPerf.patchMs = [];
      window.__piWebPerf.rowUpdateCount = 0;
      window.__piWebPerf.rowUpdateMs = [];
    }
    window.__piWebLongTasks = [];
  });

  const responsiveness: Array<{ label: string; ms: number }> = [];
  const app = page.locator("pi-web-agent");
  if (!await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"))) {
    await page.locator("#toggleSessionSidebarMobile").click().catch(async () => page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click()));
    await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  }

  const beforeHamburgerPerf = await page.evaluate(() => ({
    renderCount: window.__piWebPerf?.renderCount ?? 0,
    patchCount: window.__piWebPerf?.patchCount ?? 0,
    rowUpdateCount: window.__piWebPerf?.rowUpdateCount ?? 0,
  }));
  responsiveness.push(await timed("mobile-open-session-drawer", async () => {
    await page.locator("#toggleSessionSidebarMobile").click();
    await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-close-session-drawer", async () => {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click());
    await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  }));
  const hamburgerPerf = await page.evaluate((before) => ({
    renderDelta: (window.__piWebPerf?.renderCount ?? 0) - before.renderCount,
    patchDelta: (window.__piWebPerf?.patchCount ?? 0) - before.patchCount,
    rowUpdateDelta: (window.__piWebPerf?.rowUpdateCount ?? 0) - before.rowUpdateCount,
  }), beforeHamburgerPerf);
  if (hamburgerPerf.renderDelta !== 0 || hamburgerPerf.rowUpdateDelta !== 0) throw new Error(`Mobile hamburger should not full-render or rehydrate transcript rows: ${JSON.stringify(hamburgerPerf)}`);
  responsiveness.push(await timed("mobile-open-model-thinking", async () => {
    await page.locator("#modelThinkingToggle").click();
    await page.locator(".model-thinking-popover").waitFor({ timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-change-thinking", async () => {
    const nextThinking = await page.locator("#thinking").evaluate((select) => {
      const element = select as HTMLSelectElement;
      return Array.from(element.options).find((option) => option.value !== element.value)?.value ?? element.value;
    });
    await page.locator("#thinking").selectOption(nextThinking);
    await page.locator(".model-thinking-popover").waitFor({ state: "detached", timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-fill-prompt-after-heavy-transcript", () => page.locator("#prompt").fill("typing after mobile heavy transcript")));

  const group = page.locator(".tool-run-group").first();
  await group.waitFor({ timeout: 5_000 });
  responsiveness.push(await timed("mobile-open-completed-tool-group", async () => {
    await group.locator("summary").click();
    await page.waitForFunction(() => Boolean(document.querySelector(".tool-run-group[open]")), null, { timeout: 5_000 });
  }));
  const firstToolToggle = page.locator('.tool-run-group[open] .message.tool [data-row-action="toggle-output"]').first();
  responsiveness.push(await timed("mobile-expand-tool-output", async () => {
    await firstToolToggle.click();
    await page.locator(".tool-run-group[open] .message.tool:not(.collapsed) .message-body").first().waitFor({ state: "visible", timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-open-tool-action-menu", async () => {
    await page.locator('.tool-run-group[open] .message.tool [data-row-action="menu"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 1, null, { timeout: 5_000 });
  }));

  const maxLatencyMs = Math.max(...responsiveness.map((sample) => sample.ms));
  await page.screenshot({ path: join(artifactDir, "mobile-long-transcript-controls.png"), fullPage: true });
  return {
    responsiveness,
    maxLatencyMs,
    hamburgerPerf,
    toolRows: await page.locator(".message.tool").count(),
    toolGroups: await page.locator(".tool-run-group").count(),
    artifactImages: await page.locator(".artifact-image img").count(),
    ...(await collectMetrics(page)),
  };
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

async function chooseImageWithPaperclip(page: Page, imagePath: string, options: { forceRenderWhileOpen?: boolean } = {}): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#prompt").focus();
  await page.locator("#attachImages").click();
  const fileChooser = await chooser;
  // Real native file pickers often stay open long enough for unrelated app renders
  // to happen. Force one here so the harness catches input replacement races.
  if (options.forceRenderWhileOpen) {
    await page.evaluate(() => (document.querySelector("pi-web-agent") as unknown as { render?: () => void } | null)?.render?.());
  }
  await page.waitForTimeout(250);
  await fileChooser.setFiles(imagePath);
}

async function runImageAttachments(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const imagePath = join(artifactDir, "fixture.png");
  await chooseImageWithPaperclip(page, imagePath, { forceRenderWhileOpen: true });
  await page.locator(".prompt-image img").waitFor({ timeout: 5_000 });
  await page.locator(".prompt-image button").click();
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });

  await chooseImageWithPaperclip(page, imagePath);
  await page.locator(".prompt-image", { hasText: "fixture.png" }).waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Please inspect this attached image and include an image preview in the reply.");
  await page.locator(".prompt-image").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  await page.locator(".message.assistant img").first().waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

async function runImageArtifactDropUpload(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const imagePath = join(artifactDir, "fixture.png");
  await chooseImageWithPaperclip(page, imagePath);
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes(".bakery/artifacts/"), null, { timeout: 5_000 });
  const artifactPrompt = "Please echo this uploaded screenshot artifact path exactly: " + await page.locator("#prompt").inputValue();
  await sendPromptAndWaitIdle(page, artifactPrompt);
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 1 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/artifacts/raw"))) throw new Error(`Expected dropped artifact screenshots to use artifact raw endpoint, saw ${sources.join(", ")}`);
  await page.locator(".message.user img").first().waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), userImages: await page.locator(".message.user img").count(), sources, ...(await collectMetrics(page)) };
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

async function runRemoteImageArtifactPaths(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list remote screenshot artifact paths for rendering validation.");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img, .markdown-body img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img, .markdown-body img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (sources.some((src) => src.startsWith("file://"))) throw new Error(`Expected remote screenshots to use safe raw-file URLs, saw ${sources.join(", ")}`);
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/files/raw"))) throw new Error(`Expected remote screenshots to use raw-file endpoint, saw ${sources.join(", ")}`);
  await page.locator(".artifact-image figcaption", { hasText: "/screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), renderedImages: sources.length, sources, ...(await collectMetrics(page)) };
}

async function runRemoteImageArtifactUpload(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const remotePath = "/remote/agent/workspace/screenshots/uploaded.png";
  const uploadedFixturePath = join(artifactDir, "fixture.png");
  const upload = spawn("bun", ["scripts/upload-artifact.ts", "--api", apiBase, "--session", sessionId, "--path", remotePath, uploadedFixturePath], {
    cwd: root,
    env: { ...process.env, PI_WEB_AUTH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let uploadOutput = "";
  upload.stdout.on("data", (chunk) => { uploadOutput += String(chunk); });
  upload.stderr.on("data", (chunk) => { uploadOutput += String(chunk); });
  const uploadCode = await new Promise<number | null>((resolve) => upload.on("exit", resolve));
  if (uploadCode !== 0) throw new Error(`Remote artifact upload CLI failed with code ${uploadCode}: ${uploadOutput}`);
  await sendPromptAndWaitIdle(page, "Please list uploaded remote screenshot artifact paths for rendering validation.");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img, .markdown-body img"));
    return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 5_000 });
  const sources = await page.locator(".artifact-image img, .markdown-body img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  if (!sources.every((src) => src.includes("/api/sessions/") && src.includes("/artifacts/raw"))) throw new Error(`Expected uploaded remote screenshots to use artifact raw endpoint, saw ${sources.join(", ")}`);
  await page.locator(".artifact-image figcaption", { hasText: "uploaded.png" }).waitFor({ timeout: 5_000 });
  return { artifactImages: await page.locator(".artifact-image img").count(), renderedImages: sources.length, sources, ...(await collectMetrics(page)) };
}

async function runMissingRemoteImageArtifact(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please list uploaded remote screenshot artifact paths for rendering validation, but do not upload the file first.");
  await page.waitForFunction(() => (window.__piWebFailedImageCount ?? 0) > 0, null, { timeout: 5_000 });
  await page.waitForFunction(() => document.querySelectorAll(".artifact-image img, .markdown-body img").length === 0, null, { timeout: 5_000 });
  await page.waitForTimeout(500);
  const afterInitialFailure = await page.evaluate(() => window.__piWebFailedImageCount ?? 0);
  await page.locator(".message.assistant").first().click();
  await page.waitForTimeout(500);
  const afterRerender = await page.evaluate(() => window.__piWebFailedImageCount ?? 0);
  if (afterRerender > afterInitialFailure) throw new Error(`Expected failed image URLs to be suppressed after first error; saw ${afterRerender - afterInitialFailure} extra image failures`);
  return { failedImageCount: afterRerender, ...(await collectMetrics(page)) };
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
  await page.locator("#modelThinkingToggle").click();
  await page.locator("#model").selectOption("fake/slow");
  await page.waitForFunction(() => document.querySelector("#modelThinkingToggle")?.textContent?.includes("Slow"));
  await page.locator("#modelThinkingToggle").click();
  await page.locator("#thinking").selectOption("high");
  await page.waitForFunction(() => document.querySelector("#modelThinkingToggle")?.textContent?.includes("high"));
  await sendPromptAndWaitIdle(page, "Confirm model and thinking picker remains usable after settings updates.");
  await page.waitForFunction(() => document.querySelector("#modelThinkingToggle")?.textContent?.includes("Slow"));
  await page.waitForFunction(() => document.querySelector("#modelThinkingToggle")?.textContent?.includes("high"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("mobile-layout"), null, { timeout: 5_000 });
  await page.locator("#modelThinkingToggle").click();
  await page.locator(".model-thinking-popover").waitFor({ timeout: 5_000 });
  const mobilePickerState = await page.evaluate(() => {
    const model = document.querySelector<HTMLSelectElement>("#model");
    const thinking = document.querySelector<HTMLSelectElement>("#thinking");
    const popover = document.querySelector(".model-thinking-popover");
    const rect = popover?.getBoundingClientRect();
    return { model: model?.value, thinking: thinking?.value, left: rect ? Math.round(rect.left) : null, right: rect ? Math.round(rect.right) : null, viewportWidth: window.innerWidth };
  });
  if (mobilePickerState.model !== "fake/slow" || mobilePickerState.thinking !== "high" || (mobilePickerState.left ?? -999) < -1 || (mobilePickerState.right ?? 9999) > mobilePickerState.viewportWidth + 1) {
    throw new Error(`Mobile model/thinking picker should preserve selections and stay onscreen: ${JSON.stringify(mobilePickerState)}`);
  }
  await page.screenshot({ path: join(artifactDir, "model-thinking-mobile.png"), fullPage: true });
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

async function runScenario(name: string, page: Page, browser: Browser, runtime: { restartServer: () => Promise<void>; stopServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  if (name === "manual") return runManual(page);
  if (name === "empty-session-layout") return runEmptySessionLayout(page);
  if (name === "mobile-layout") return runMobileLayout(page);
  if (name === "streaming-responsiveness") return runStreamingResponsiveness(page);
  if (name === "queued-follow-up") return runQueuedFollowUp(page);
  if (name === "transcript-scroll-stability") return runTranscriptScrollStability(page);
  if (name === "transcript-text-selection") return runTranscriptTextSelection(page);
  if (name === "session-metadata") return runSessionMetadata(page);
  if (name === "inspector-preview") return runInspectorPreview(page);
  if (name === "slash-commands") return runSlashCommands(page);
  if (name === "bash-commands") return runBashCommands(page);
  if (name === "question-answer") return runQuestionAnswer(page);
  if (name === "tree-fork-navigation") return runTreeForkNavigation(page);
  if (name === "reconnect-controller") return runReconnectController(page);
  if (name === "controller-handoff-edges") return runControllerHandoffEdges(page, browser);
  if (name === "reconnect-draft") return runReconnectDraft(page);
  if (name === "backend-restart") return runBackendRestart(page, runtime);
  if (name === "connection-disconnected") return runConnectionDisconnected(page, runtime);
  if (name === "narrow-tool-stream") return runNarrowToolStream(page);
  if (name === "tool-grouping") return runToolGrouping(page);
  if (name === "tool-image-heavy-transcript") return runToolImageHeavyTranscript(page);
  if (name === "mobile-long-transcript-controls") return runMobileLongTranscriptControls(page);
  if (name === "file-autocomplete") return runFileAutocomplete(page);
  if (name === "image-attachments") return runImageAttachments(page);
  if (name === "image-artifact-drop-upload") return runImageArtifactDropUpload(page);
  if (name === "image-artifact-paths") return runImageArtifactPaths(page);
  if (name === "repeated-image-artifact-paths") return runRepeatedImageArtifactPaths(page);
  if (name === "artifact-path-formats") return runArtifactPathFormats(page);
  if (name === "remote-image-artifact-paths") return runRemoteImageArtifactPaths(page);
  if (name === "remote-image-artifact-upload") return runRemoteImageArtifactUpload(page);
  if (name === "missing-remote-image-artifact") return runMissingRemoteImageArtifact(page);
  if (name === "model-thinking") return runModelThinking(page);
  if (name === "context-usage") return runContextUsage(page);
  if (name === "themes") return runThemes(page);
  if (name === "theme-gallery") return runThemeGallery(page);
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
    PI_WEB_AUTH_TOKEN: "",
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
