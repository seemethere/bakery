import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { apiBase, artifactDir, root, webBase } from "../config";
import {
  assertComposerMode,
  collectMetrics,
  createSessionViaApi,
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

  const secondSessionId = await createSessionViaApi(page);
  if (new URL(page.url()).pathname !== `/sessions/${secondSessionId}`) throw new Error(`Expected second session URL, saw ${page.url()}`);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, firstSessionId);
  if (new URL(page.url()).pathname !== `/sessions/${firstSessionId}`) throw new Error(`Expected Back to restore first session URL, saw ${page.url()}`);

  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.locator(".sessions-page").waitFor({ timeout: 5_000 });
  if (new URL(page.url()).pathname !== "/sessions") throw new Error(`Expected Back to restore sessions page URL, saw ${page.url()}`);

  await page.goto(`${webBase}/sessions/${secondSessionId}`, { waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, secondSessionId);
  await waitForAgentIdle(page, 5_000);
  await page.screenshot({ path: join(artifactDir, "session-routing.png"), fullPage: true });
  return { firstSessionId, secondSessionId, selectedSessionId: await selectedSessionId(page), pathname: new URL(page.url()).pathname };
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
  const mobileQuestionLayout = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      transcript: rectOf(".transcript"),
      question: rectOf(".question-card.pending"),
      footer: rectOf("footer"),
    };
  });
  if (mobileQuestionLayout.documentWidth > mobileQuestionLayout.viewport.width + 2) throw new Error(`Mobile question layout overflowed horizontally: ${JSON.stringify(mobileQuestionLayout)}`);
  if ((mobileQuestionLayout.question?.height ?? 999) > 360) throw new Error(`Mobile normal question card should show its options without becoming oversized: ${JSON.stringify(mobileQuestionLayout)}`);
  if (mobileQuestionLayout.question && mobileQuestionLayout.footer && mobileQuestionLayout.question.bottom > mobileQuestionLayout.footer.top + 1) throw new Error(`Mobile question card overlaps composer: ${JSON.stringify(mobileQuestionLayout)}`);
  if ((mobileQuestionLayout.transcript?.height ?? 0) < 240) throw new Error(`Mobile question state leaves too little transcript: ${JSON.stringify(mobileQuestionLayout)}`);
  const visibleMobileOptions = await page.locator(".question-card.pending [data-question-option-index]").evaluateAll((options) => options.every((option) => {
    const rect = option.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }));
  if (!visibleMobileOptions) throw new Error("Mobile normal question should show all inline options");
  await page.screenshot({ path: join(artifactDir, "question-answer-mobile.png"), fullPage: true });
  await page.locator(".question-card.pending [data-question-option-index='0']").click();
  await page.locator(".question-card.pending").waitFor({ state: "detached", timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);

  await page.locator("#prompt").fill("Please trigger question-answer with many mobile question options for internal scroll coverage.");
  await page.locator("#send").click();
  await page.locator(".question-card.pending", { hasText: "Show all 9 options" }).waitFor({ timeout: 5_000 });
  const manyOptionQuestionLayout = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".question-card.pending");
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { height: Math.round(rect.height), scrollHeight: card.scrollHeight, clientHeight: card.clientHeight, scrollTopBefore: card.scrollTop, documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
  });
  if (!manyOptionQuestionLayout || manyOptionQuestionLayout.height > 360) throw new Error(`Mobile many-option question should stay compact before opening the all-options chooser: ${JSON.stringify(manyOptionQuestionLayout)}`);
  if (manyOptionQuestionLayout.documentWidth > manyOptionQuestionLayout.viewportWidth + 2) throw new Error(`Mobile many-option question overflowed horizontally: ${JSON.stringify(manyOptionQuestionLayout)}`);
  await page.locator(".question-show-all-options").click();
  await page.locator(".question-options-dialog", { hasText: "Option 9" }).waitFor({ timeout: 5_000 });
  const overlayLayout = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(".question-options-dialog");
    const list = document.querySelector<HTMLElement>(".question-options-dialog-list");
    if (!dialog || !list) return null;
    const rect = dialog.getBoundingClientRect();
    const listStyle = getComputedStyle(list);
    return { height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom), listScrollHeight: list.scrollHeight, listClientHeight: list.clientHeight, listOverflowY: listStyle.overflowY, documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
  });
  if (!overlayLayout || overlayLayout.height > 836 || overlayLayout.top < -1 || overlayLayout.listScrollHeight <= overlayLayout.listClientHeight || overlayLayout.listOverflowY === "hidden") throw new Error(`Mobile many-option chooser should open a bounded scrollable overlay: ${JSON.stringify(overlayLayout)}`);
  if (overlayLayout.documentWidth > overlayLayout.viewportWidth + 2) throw new Error(`Mobile many-option chooser overflowed horizontally: ${JSON.stringify(overlayLayout)}`);
  await page.screenshot({ path: join(artifactDir, "question-answer-mobile-all-options.png"), fullPage: true });
  await page.locator("[data-question-overlay-option-index='8']").click();
  await page.locator(".question-card.pending").waitFor({ state: "detached", timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);

  await page.screenshot({ path: join(artifactDir, "question-answer.png"), fullPage: true });
  return { ...(await collectMetrics(page)) };
}

export async function runContextUsage(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator(".context-usage").waitFor({ timeout: 5_000 });
  const before = await page.locator(".context-usage").textContent();
  if (!before?.includes("Context") || (!before.includes("/") && !before.includes("unknown"))) throw new Error(`Missing context usage label; saw ${before}`);
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
  const sessionId = await prepareSession(page);

  await sendPromptAndWaitIdle(page, "what's next?");

  await page.evaluate(async ({ apiBase, sessionId }) => {
    const response = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Manual metadata smoke" }),
    });
    if (!response.ok) throw new Error(`title patch failed: ${response.status}`);
  }, { apiBase, sessionId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("header", { hasText: "Manual metadata smoke" }).waitFor({ timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);

  await sendPromptAndWaitIdle(page, "Improve session summaries and title generation with dedicated harness coverage.");
  const summary = "Manual summary preview from metadata harness. It should appear in the details dialog and as the session-card snippet.";
  await page.evaluate(async ({ apiBase, sessionId, summary }) => {
    const response = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Improve summaries metadata smoke", summary }),
    });
    if (!response.ok) throw new Error(`summary patch failed: ${response.status}`);
  }, { apiBase, sessionId, summary });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("header", { hasText: "Improve summaries metadata smoke" }).waitFor({ timeout: 5_000 });
  await page.locator('[aria-label="Session details"]').click();
  await page.locator('[role="dialog"]', { hasText: summary }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "session-metadata.png"), fullPage: true });
  return collectMetrics(page);
}


export async function runTreeForkNavigation(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const beforeSessions = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/sessions`);
    if (!response.ok) throw new Error(`sessions fetch failed: ${response.status}`);
    return ((await response.json()) as unknown[]).length;
  }, apiBase);
  await sendPromptAndWaitIdle(page, "Create a transcript fork row without showing tree navigation UI.");
  await page.locator(".tree-drawer").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Create a transcript fork row" }).last().waitFor({ timeout: 5_000 });
  await page.locator(".message.assistant").last().waitFor({ timeout: 5_000 });
  const afterSessions = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/sessions`);
    if (!response.ok) throw new Error(`sessions fetch failed: ${response.status}`);
    return ((await response.json()) as unknown[]).length;
  }, apiBase);
  if (afterSessions !== beforeSessions) throw new Error(`Tree/fork smoke should not create sessions without clicking fork: before=${beforeSessions} after=${afterSessions}`);
  await waitForAgentIdle(page, 5_000);
  await ensureSidebarSettingsVisible(page);
  await page.screenshot({ path: join(artifactDir, "transcript-fork-no-tree-ui.png"), fullPage: true });
  return collectMetrics(page);
}


