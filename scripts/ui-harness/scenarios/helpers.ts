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
      renderedImages: document.querySelectorAll(".message img").length,
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

export async function prepareSession(page: Page): Promise<string> {
  await page.addInitScript(({ apiBase }) => {
    localStorage.setItem("piWebApiBase", apiBase);
    localStorage.setItem("piWebAuthToken", "");
  }, { apiBase });
  await page.goto(`${webBase}/settings`, { waitUntil: "domcontentloaded" });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) {
    await page.locator("pi-web-agent").evaluate((element) => {
      element.classList.add("session-sidebar-collapsed");
      element.classList.remove("session-sidebar-overlay-open");
      element.querySelector(".session-sidebar")?.classList.add("collapsed");
      element.querySelector("#sessionSidebarBackdrop")?.remove();
    });
  }
  await page.locator("#apiBase").fill(apiBase);
  await page.locator("#token").fill("");
  await page.locator("#saveSettings").click();
  if (await page.locator("#workspace").count() === 0) {
    const mobileMenu = page.locator("#toggleSessionSidebarMobile");
    if (await mobileMenu.isVisible().catch(() => false)) await mobileMenu.click();
    else if (await page.locator("#toggleSessionSidebar").count() > 0) await page.locator("#toggleSessionSidebar").click();
  }
  await page.waitForFunction(() => document.querySelectorAll("#workspace option").length > 0, undefined, { timeout: 5_000 });
  const created = page.waitForResponse((response) => response.url() === `${apiBase}/api/sessions` && response.request().method() === "POST" && response.status() === 201);
  await page.locator("#newSession").click();
  const response = await created;
  const session = await response.json() as { id: string };
  await page.locator("#prompt").waitFor({ state: "visible" });
  await waitForAgentIdle(page, 5_000);
  if (await page.locator("#toggleSessionSidebarMobile").isVisible().catch(() => false)) {
    const sidebarOpen = await page.locator("pi-web-agent").evaluate((element) => !element.classList.contains("session-sidebar-collapsed"));
    if (sidebarOpen) await page.locator("#toggleSessionSidebar").click();
  }
  return session.id;
}

export async function selectedSessionId(page: Page): Promise<string | null> {
  return await page.locator("pi-web-agent").evaluate((element) => ((element as unknown as { selectedSession?: { id?: string } | null }).selectedSession?.id ?? null));
}

export async function waitForSelectedSession(page: Page, sessionId: string): Promise<void> {
  await page.waitForFunction((id) => ((document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } | null } | null)?.selectedSession?.id ?? null) === id, sessionId, { timeout: 5_000 });
}

export async function waitForAgentIdle(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } | null; status?: string } | null;
    return Boolean(app?.selectedSession?.id) && app?.status === "idle";
  }, undefined, { timeout });
}

export async function waitForAgentRunning(page: Page, timeout = 5_000): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { status?: string } | null;
    return app?.status === "running";
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
      followUpHidden: followUp?.classList.contains("hidden") ?? null,
      abortHidden: abort?.classList.contains("hidden") ?? null,
      promptPlaceholder: prompt?.placeholder ?? "",
    };
  });
  const running = expected === "running";
  const expectedText = running ? "Running input" : "Prompt";
  if (state.modeText !== expectedText) throw new Error(`Expected composer mode ${expectedText}, saw ${JSON.stringify(state)}`);
  if (!state.modeClass.includes(expected)) throw new Error(`Expected composer mode class ${expected}, saw ${JSON.stringify(state)}`);
  if (state.footerClass.includes("running-footer") !== running) throw new Error(`Expected footer running=${running}, saw ${JSON.stringify(state)}`);
  if (state.followUpHidden !== !running || state.abortHidden !== !running) throw new Error(`Expected running controls hidden=${!running}, saw ${JSON.stringify(state)}`);
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

