import type { Page } from "playwright";
import { apiBase, webBase } from "../config";

declare global {
  interface Window {
    __piWebLongTasks?: Array<{ name: string; startTime: number; duration: number }>;
    __piWebPerf?: { renderCount: number; renderMs: number[]; patchCount: number; patchMs: number[]; rowUpdateCount?: number; rowUpdateMs?: number[]; eventCounts?: Record<string, number>; reasonCounts?: Record<string, number>; recentEvents?: unknown[] };
    __piWebStableImage?: HTMLImageElement;
    __piWebFailedImageCount?: number;
  }
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForUrl(url: string, label: string, timeoutMs = 20_000): Promise<void> {
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

export async function timed(label: string, action: () => Promise<unknown>): Promise<{ label: string; ms: number }> {
  const start = performance.now();
  await action();
  return { label, ms: Math.round(performance.now() - start) };
}

export async function collectMetrics(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0]?.toJSON?.() ?? null;
    const resources = performance.getEntriesByType("resource").length;
    const transcript = document.querySelector('[data-testid="transcript"], .transcript');
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
      renderedImages: document.querySelectorAll('[data-transcript-kind] img, .message img').length,
      inspectorPanels: document.querySelectorAll(".right-panel, .tree-drawer").length,
      treeRows: document.querySelectorAll(".tree-line").length,
      sessionButtons: document.querySelectorAll("[data-session-id]").length,
      longTaskCount: longTasks.length,
      longTaskTotalMs: Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
      longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks.map((task) => task.duration))) : 0,
      piWebPerf: perf ? {
        renderCount: perf.renderCount,
        patchCount: perf.patchCount,
        rowUpdateCount: perf.rowUpdateCount ?? 0,
        eventCounts: perf.eventCounts ?? {},
        reasonCounts: perf.reasonCounts ?? {},
        recentEvents: perf.recentEvents ?? [],
        render: summarize(perf.renderMs),
        patch: summarize(perf.patchMs),
        rowUpdate: summarize(perf.rowUpdateMs ?? []),
      } : null,
    };
  });
}

async function harnessWorkspace(page: Page): Promise<string> {
  return await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/workspaces`);
    if (!response.ok) throw new Error(`workspaces fetch failed: ${response.status}`);
    const workspaces = await response.json() as Array<{ path: string }>;
    const path = workspaces[0]?.path;
    if (!path) throw new Error("Harness expected at least one workspace");
    return path;
  }, apiBase);
}

export async function prepareSession(page: Page): Promise<string> {
  await page.addInitScript(({ apiBase }) => {
    localStorage.setItem("piWebApiBase", apiBase);
    localStorage.setItem("piWebAuthToken", "");
    localStorage.setItem("piWebSidebarCollapsed", "true");
  }, { apiBase });
  await page.goto(`${webBase}/sessions`, { waitUntil: "domcontentloaded" });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) {
    await page.locator(".pi-web-agent").evaluate((element) => {
      element.classList.add("session-sidebar-collapsed");
      element.classList.remove("session-sidebar-overlay-open");
      element.querySelector(".session-sidebar")?.classList.add("collapsed");
      element.querySelector("#sessionSidebarBackdrop")?.remove();
    });
  }
  const mobileMenu = page.locator("#toggleSessionSidebarMobile");
  if (await mobileMenu.isVisible().catch(() => false)) await mobileMenu.click();
  await page.locator("#newSession").waitFor({ state: "visible", timeout: 5_000 });
  const sessionId = await createSessionViaApi(page);
  await page.locator("#prompt").waitFor({ state: "visible" });
  await waitForAgentIdle(page, 5_000);
  if (await page.locator("#toggleSessionSidebarMobile").isVisible().catch(() => false)) {
    const sidebarOpen = await page.locator(".pi-web-agent").evaluate((element) => !element.classList.contains("session-sidebar-collapsed"));
    if (sidebarOpen) await page.locator("#toggleSessionSidebar").click();
  }
  return sessionId;
}

export async function selectedSessionId(page: Page): Promise<string | null> {
  return await page.locator(".pi-web-agent").evaluate((element) => element.getAttribute("data-selected-session-id") || null);
}

export async function waitForSelectedSession(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction((id) => document.querySelector(".pi-web-agent")?.getAttribute("data-selected-session-id") === id, sessionId, { timeout: 5_000 });
}

export async function createSessionViaApi(page: Page): Promise<string> {
  const session = await page.evaluate(async ({ base, cwd }) => {
    const response = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (!response.ok) throw new Error(`create session failed: ${response.status}`);
    return await response.json() as { id: string };
  }, { base: apiBase, cwd: await harnessWorkspace(page) });
  await page.goto(`${webBase}/sessions/${session.id}`, { waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, session.id);
  return session.id;
}

export async function waitForNoSelectedSession(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector(".pi-web-agent")?.getAttribute("data-selected-session-id") ?? "") === "", null, { timeout: 5_000 });
}

export async function waitForMobileLayout(page: Page): Promise<void> {
  await page.waitForFunction(() => window.matchMedia("(max-width: 767px)").matches, null, { timeout: 5_000 });
}

export async function waitForSidebarCollapsed(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector(".pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
}

export async function waitForAgentIdle(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector(".pi-web-agent");
    return Boolean(app?.getAttribute("data-selected-session-id")) && app?.getAttribute("data-agent-status") === "idle";
  }, undefined, { timeout });
}

export async function waitForAgentRunning(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector(".pi-web-agent");
    return app?.getAttribute("data-agent-status") === "running";
  }, undefined, { timeout });
}

export async function assertComposerMode(page: Page, expected: "idle" | "running"): Promise<void> {
  const state = await page.evaluate(() => {
    const mode = document.querySelector<HTMLElement>(".composer-mode");
    const footer = document.querySelector<HTMLElement>("footer");
    const followUp = document.querySelector<HTMLElement>("#followUp");
    const abort = document.querySelector<HTMLElement>("#abort");
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
    return {
      modeText: mode?.querySelector("strong")?.textContent ?? "",
      modeClass: mode?.className ?? "",
      footerClass: footer?.className ?? "",
      followUpPresent: Boolean(followUp),
      abortPresent: Boolean(abort),
      promptPlaceholder: prompt?.placeholder ?? "",
    };
  });
  const running = expected === "running";
  if (running && (!state.followUpPresent || !state.abortPresent)) throw new Error(`Expected running controls, saw ${JSON.stringify(state)}`);
  if (!running && (state.followUpPresent || state.abortPresent)) throw new Error(`Expected idle controls without running buttons, saw ${JSON.stringify(state)}`);
  if (running && !state.promptPlaceholder.includes("Steer")) throw new Error(`Expected running placeholder, saw ${JSON.stringify(state)}`);
  if (!running && !state.promptPlaceholder.includes("Ask pi")) throw new Error(`Expected idle placeholder, saw ${JSON.stringify(state)}`);
}

export async function sendPromptAndWaitIdle(page: Page, text: string): Promise<void> {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await waitForAgentIdle(page, 30_000);
}

export async function waitForPromptEnabled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
    return Boolean(prompt && !prompt.disabled);
  }, undefined, { timeout: 5_000 });
}

export async function waitForPromptDisabled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
    return Boolean(prompt?.disabled);
  }, undefined, { timeout: 5_000 });
}
