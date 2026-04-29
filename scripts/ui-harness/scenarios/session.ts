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
  await page.locator("pi-web-agent").evaluate(async (element) => {
    await (element as unknown as { updateSessionTitle: (title: string) => Promise<void> }).updateSessionTitle("Findable sessions page title");
  });
  const secondSession = await page.locator("pi-web-agent").evaluate(async (element) => {
    const session = await (element as unknown as { createSession: () => Promise<{ id: string } | null> }).createSession();
    if (!session) throw new Error("Could not create comparison session");
    return { id: session.id };
  });
  await waitForSelectedSession(page, secondSession.id);

  await ensureSidebarSettingsVisible(page);
  await page.locator('[data-route-path="/sessions"]').click();
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
  await page.locator(".question-panel", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-recommendation", { hasText: "smallest vertical slice" }).waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("[data-question-option-index='0'].recommended-option", { hasText: "Recommended" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "1-9" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-key-hint", { hasText: "Esc" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-custom-field", { hasText: "Custom" }).waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-question-option-index") === "0", null, { timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "question-answer-recommended-option.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("mobile-layout"), null, { timeout: 5_000 });
  await page.locator(".question-touch-hint", { hasText: "Tap an option or type a custom answer." }).waitFor({ timeout: 5_000 });
  const mobileKeyHintDisplay = await page.locator(".question-key-hint").evaluate((element) => getComputedStyle(element).display);
  if (mobileKeyHintDisplay !== "none") throw new Error(`Mobile question panel should hide keyboard shortcuts; saw display=${mobileKeyHintDisplay}`);
  await page.screenshot({ path: join(artifactDir, "question-answer-mobile-touch-hint.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => !document.querySelector("pi-web-agent")?.classList.contains("mobile-layout"), null, { timeout: 5_000 });
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
  await waitForAgentIdle(page, 10_000);

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
  await waitForAgentIdle(page, 10_000);

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
  await viewerPage.locator("#takeControl", { hasText: "Take control" }).waitFor({ timeout: 10_000 });
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
  await userRow.locator('[data-row-action="fork"]').click();
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length > count, beforeSessions, { timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);
  await ensureSidebarSettingsVisible(page);
  await page.locator("[data-session-id]").nth(1).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "transcript-fork-no-tree-ui.png"), fullPage: true });
  return collectMetrics(page);
}


