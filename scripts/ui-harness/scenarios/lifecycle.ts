import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { apiBase, artifactDir, root, webBase } from "../config";
import {
  assertComposerMode,
  collectMetrics,
  delay,
  prepareSession,
  selectedSessionId,
  sendPromptAndWaitIdle,
  timed,
  waitForAgentIdle,
  waitForAgentRunning,
  waitForPromptDisabled,
  waitForPromptEnabled,
  waitForSelectedSession,
} from "./helpers";

export const lifecycleScenarios = [
  "reconnect-controller",
  "controller-handoff-edges",
  "reconnect-draft",
  "backend-restart",
  "connection-disconnected",
] as const;

export async function runReconnectController(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const context = page.context();
  const viewer = await context.newPage();
  await viewer.addInitScript((id) => localStorage.removeItem(`piWebClientId:${id}`), sessionId);
  await viewer.goto(`${webBase}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  await viewer.locator("#prompt").waitFor({ state: "visible" });
  await viewer.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await viewer.locator("#takeControl").click();
  await viewer.locator("#takeControl").waitFor({ state: "detached", timeout: 5_000 });
  await waitForPromptEnabled(viewer);
  await page.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await waitForPromptDisabled(page);
  await viewer.locator("#prompt").fill("controller handoff smoke");
  await viewer.locator("#send").click();
  await waitForAgentIdle(viewer, 8_000);
  await viewer.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await waitForAgentIdle(page, 5_000);
  return collectMetrics(page);
}

export async function runControllerHandoffEdges(page: Page, browser: Browser): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const context = page.context();
  const viewer = await context.newPage();
  await viewer.addInitScript((id) => localStorage.removeItem(`piWebClientId:${id}`), sessionId);
  await viewer.goto(`${webBase}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  await viewer.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("Please produce a long streaming takeover response.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await viewer.locator("#takeControl").click();
  await viewer.locator("#takeControl").waitFor({ state: "detached", timeout: 5_000 });
  await waitForPromptEnabled(viewer);
  await page.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await waitForPromptDisabled(page);
  await waitForAgentIdle(viewer, 30_000);

  await page.locator("#takeControl").click();
  await page.locator("#takeControl").waitFor({ state: "detached", timeout: 5_000 });
  await waitForPromptEnabled(page);
  await viewer.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await waitForPromptDisabled(viewer);

  const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const owner = await isolated.newPage();
  const isolatedSessionId = await prepareSession(owner);
  const requester = await isolated.newPage();
  await requester.addInitScript((id) => localStorage.removeItem(`piWebClientId:${id}`), isolatedSessionId);
  await requester.goto(`${webBase}/sessions/${isolatedSessionId}`, { waitUntil: "domcontentloaded" });
  await requester.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 5_000 });
  await requester.locator("#takeControl").click();
  await requester.locator("#takeControl").waitFor({ state: "detached", timeout: 5_000 });
  await waitForPromptEnabled(requester);
  await owner.close();
  await requester.locator("#prompt").fill("disconnected controller handoff smoke");
  await requester.locator("#send").click();
  await waitForAgentIdle(requester, 8_000);
  const metrics = await collectMetrics(requester);
  await isolated.close();
  return metrics;
}

export async function runReconnectDraft(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft survives reload ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#prompt").waitFor({ state: "visible" });
  await waitForAgentIdle(page, 10_000);
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  return collectMetrics(page);
}

export async function runBackendRestart(page: Page, runtime: { restartServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft survives backend restart ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await runtime.restartServer();
  await page.locator(".connection-banner").filter({ hasText: /not connected|reconnecting|disconnected|retry/i }).waitFor({ timeout: 8_000 }).catch(() => undefined);
  await waitForAgentIdle(page, 20_000);
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Confirm the session is usable after backend restart while preserving my draft context.");
  return collectMetrics(page);
}

export async function runConnectionDisconnected(page: Page, runtime: { stopServer: () => Promise<void> }): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const draft = `draft while backend is down ${Date.now()}`;
  await page.locator("#prompt").fill(draft);
  await runtime.stopServer();
  await page.locator(".connection-banner").filter({ hasText: /not connected|reconnecting|disconnected|retry/i }).waitFor({ timeout: 8_000 });
  await page.waitForFunction((expected) => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === expected, draft);
  await page.screenshot({ path: join(artifactDir, "connection-disconnected.png"), fullPage: true });
  return collectMetrics(page);
}


