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
import { ensureSidebarSettingsVisible, setWorkbenchTheme } from "./visual";

export const sessionScenarios = [
  "empty-session-layout",
  "session-routing",
  "sessions-page",
  "session-metadata",
  "question-answer",
  "tree-fork-navigation",
] as const;

export async function runSessionsPage(page: Page): Promise<Record<string, unknown>> {
  const firstSessionId = await prepareSession(page);
  await page.evaluate(async ({ base, id }) => {
    const response = await fetch(`${base}/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Findable sessions page title" }),
    });
    if (!response.ok) throw new Error(`rename failed: ${response.status}`);
  }, { base: apiBase, id: firstSessionId });
  const secondSession = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    if (!response.ok) throw new Error(`create session failed: ${response.status}`);
    return await response.json() as { id: string };
  }, apiBase);
  await page.goto(`${webBase}/sessions/${secondSession.id}`, { waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, secondSession.id);

  await page.goto(`${webBase}/sessions`, { waitUntil: "domcontentloaded" });
  await page.locator(".sessions-page").waitFor({ timeout: 5_000 });
  if (new URL(page.url()).pathname !== "/sessions") throw new Error(`Expected sessions page URL, saw ${page.url()}`);
  const initialCards = await page.locator(".sessions-page [data-session-id]").count();
  if (initialCards < 2) throw new Error(`Expected at least two sessions on page, saw ${initialCards}`);

  await page.locator("#sessionsSearch").fill("Findable");
  await page.waitForFunction(() => document.querySelectorAll(".sessions-page [data-session-id]").length === 1, undefined, { timeout: 5_000 });
  await page.locator(".sessions-page [data-session-id]").click();
  await waitForSelectedSession(page, firstSessionId);
  if (new URL(page.url()).pathname !== `/sessions/${firstSessionId}`) throw new Error(`Expected resumed session URL, saw ${page.url()}`);
  await page.screenshot({ path: join(artifactDir, "sessions-page.png"), fullPage: true });
  return { firstSessionId, secondSessionId: secondSession.id, initialCards, selectedSessionId: await selectedSessionId(page), pathname: new URL(page.url()).pathname };
}

export async function runSessionRouting(page: Page): Promise<Record<string, unknown>> {
  const firstSessionId = await prepareSession(page);
  await waitForSelectedSession(page, firstSessionId);
  if (new URL(page.url()).pathname !== `/sessions/${firstSessionId}`) throw new Error(`Expected first session URL, saw ${page.url()}`);

  const secondSession = await page.locator("pi-web-agent").evaluate(async (element) => {
    const session = await (element as unknown as { createSession: () => Promise<{ id: string } | null> }).createSession();
    if (!session) throw new Error("Could not create second session");
    return { id: session.id };
  });
  await waitForSelectedSession(page, secondSession.id);
  if (new URL(page.url()).pathname !== `/sessions/${secondSession.id}`) throw new Error(`Expected second session URL, saw ${page.url()}`);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, firstSessionId);
  if (new URL(page.url()).pathname !== `/sessions/${firstSessionId}`) throw new Error(`Expected Back to restore first session URL, saw ${page.url()}`);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => ((document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } | null } | null)?.selectedSession ?? null) === null, null, { timeout: 5_000 });
  if (new URL(page.url()).pathname !== "/") throw new Error(`Expected Back to restore home URL, saw ${page.url()}`);

  await page.goto(`${webBase}/sessions/${secondSession.id}`, { waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, secondSession.id);
  await waitForAgentIdle(page, 5_000);
  await page.screenshot({ path: join(artifactDir, "session-routing.png"), fullPage: true });
  return { firstSessionId, secondSessionId: secondSession.id, selectedSessionId: await selectedSessionId(page), pathname: new URL(page.url()).pathname };
}


export async function runQuestionAnswer(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);

  await page.locator("#prompt").fill("Please trigger the question-answer scenario.");
  await page.locator("#send").click();
  await page.locator(".question-card.pending", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator("[data-question-option-index='0'].recommended-option", { hasText: "Recommended" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "reply normally in the composer" }).waitFor({ timeout: 5_000 });
  await page.locator("#questionCustomToggle").waitFor({ state: "detached", timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);
  await page.locator("#prompt").fill("Freeform answer with normal composer");
  await page.locator("#send").click();
  await page.locator(".question-card.pending").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".question-card.readonly.checkpoint", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Freeform answer with normal composer" }).waitFor({ timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);

  await page.locator("#prompt").fill("Please trigger question-answer for option tap.");
  await page.locator("#send").click();
  await page.locator(".question-card.pending", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-light.png"), fullPage: true });
  await page.locator("[data-question-option-index='1']").click();
  await page.locator(".question-card.pending").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Bug fix" }).waitFor({ timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);

  await page.locator("#prompt").fill("Please trigger question-answer for mobile tap targets.");
  await page.locator("#send").click();
  await page.locator(".question-card.pending", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.matchMedia("(max-width: 767px)").matches, null, { timeout: 5_000 });
  await page.locator(".question-touch-hint", { hasText: "Reply below or tap an option." }).waitFor({ timeout: 5_000 });
  const mobileShortcutDisplay = await page.locator(".question-options .option-shortcut").first().evaluate((element) => getComputedStyle(element).display);
  if (mobileShortcutDisplay !== "none") throw new Error(`Mobile question option shortcut should be hidden; saw display=${mobileShortcutDisplay}`);
  await page.screenshot({ path: join(artifactDir, "question-answer-mobile.png"), fullPage: true });
  await page.locator("[data-question-option-index='0']").click();
  await waitForAgentIdle(page, 10_000);

  await page.screenshot({ path: join(artifactDir, "question-answer.png"), fullPage: true });
  return { ...(await collectMetrics(page)) };
}

export async function runContextUsage(page: Page): Promise<Record<string, unknown>> {
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

export async function runEmptySessionLayout(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator(".empty-session-greeting").waitFor({ timeout: 5_000 });
  await page.locator(".empty-session-greeting", { hasText: "New Bakery session" }).waitFor({ timeout: 5_000 });
  await page.locator("[data-empty-quick-start='plan']", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "empty-session-initial.png"), fullPage: true });
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
      chips: rectOf(".empty-quick-start-chips"),
      greeting: rectOf(".empty-session-greeting"),
    };
  });

  const viewportCenter = layout.viewport.height / 2;
  const footerCenter = ((layout.footer?.top ?? 0) + (layout.footer?.bottom ?? 0)) / 2;
  if (Math.abs(footerCenter - viewportCenter) > 180) throw new Error(`Empty session composer is not centered enough: ${JSON.stringify(layout)}`);
  if ((layout.prompt?.height ?? 0) < 60) throw new Error(`Empty session prompt is too short: ${layout.prompt?.height}px`);
  if ((layout.chips?.top ?? 0) <= (layout.footer?.top ?? 0)) throw new Error(`Empty session chips should render below the composer: ${JSON.stringify(layout)}`);
  if (layout.prompt && layout.controls && layout.prompt.left + layout.prompt.width > layout.controls.left) {
    throw new Error(`Empty session controls overlap prompt: prompt right ${layout.prompt.left + layout.prompt.width}px, controls left ${layout.controls.left}px`);
  }

  await page.locator("#prompt").fill("Line one\nLine two\nLine three\nLine four");
  await page.waitForFunction(() => document.querySelector("footer")?.classList.contains("empty-session-composer-grown"), null, { timeout: 5_000 });
  await page.locator(".empty-quick-start-chips").waitFor({ state: "hidden", timeout: 5_000 });
  await page.locator(".empty-session-greeting").waitFor({ state: "hidden", timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "empty-session-grown.png"), fullPage: true });
  return { ...(await collectMetrics(page)), layout };
}


export async function runSessionMetadata(page: Page): Promise<Record<string, unknown>> {
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
  await page.locator("#toggleSessionDetails").click();
  await page.locator(".session-details-popover #generateMetadata").click();
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


export async function runTreeForkNavigation(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const beforeSessions = await page.locator("pi-web-agent").evaluate((element) => ((element as unknown as { sessions?: unknown[] }).sessions ?? []).length);
  await sendPromptAndWaitIdle(page, "Create a transcript fork row without showing tree navigation UI.");
  await page.locator(".tree-drawer").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  const userRow = page.locator(".message.user", { hasText: "Create a transcript fork row" }).last();
  await userRow.locator('[data-row-action="fork"]').waitFor({ timeout: 5_000 });
  const assistantRow = page.locator(".message.assistant").last();
  await assistantRow.locator('[data-row-action="fork"]').waitFor({ timeout: 5_000 });
  await userRow.locator('[data-row-action="fork"]').click();
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length > count, beforeSessions, { timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);
  await ensureSidebarSettingsVisible(page);
  await page.screenshot({ path: join(artifactDir, "transcript-fork-no-tree-ui.png"), fullPage: true });
  return collectMetrics(page);
}


