import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { apiBase, artifactDir, root, webBase } from "../config";
import { chooseImageWithPaperclip } from "./artifacts";
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

export const transcriptScenarios = [
  "streaming-responsiveness",
  "queued-follow-up",
  "transcript-scroll-stability",
  "transcript-text-selection",
  "inspector-preview",
  "narrow-tool-stream",
  "tool-grouping",
  "tool-image-heavy-transcript",
  "subagent-card",
  "subagent-card-reconnect",
  "model-thinking",
  "context-usage",
] as const;

export async function runSubagentCard(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please run a fake subagent card scenario for renderer validation.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  const runningCard = page.locator(".subagent-card.running", { hasText: "reviewer" });
  await runningCard.waitFor({ timeout: 5_000 });
  const runningSnapshot = await runningCard.evaluate((card) => ({
    text: (card as HTMLElement).textContent ?? "",
    activities: Array.from((card as HTMLElement).querySelectorAll(".subagent-activity"), (node) => node.textContent ?? ""),
  }));
  if (!runningSnapshot.activities.some((text) => text.includes("read") || text.includes("Review the current Bakery subagent card implementation"))) {
    throw new Error(`Expected running Subagent Card activity row, saw ${JSON.stringify(runningSnapshot)}`);
  }
  await waitForAgentIdle(page, 10_000);
  const finalCard = page.locator(".subagent-card.completed", { hasText: "Reviewer approved" });
  const sawFinalCard = await finalCard.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!sawFinalCard) {
    const subagentDom = await page.evaluate(() => Array.from(document.querySelectorAll(".message, .subagent-card"), (node) => ({ className: (node as HTMLElement).className, text: ((node as HTMLElement).textContent ?? "").slice(0, 300) })));
    throw new Error(`Expected completed Subagent Card, saw ${JSON.stringify(subagentDom)}`);
  }
  await finalCard.locator(".subagent-result-title", { hasText: "reviewer" }).waitFor({ timeout: 5_000 });
  const cardRow = page.locator(".message.subagent-card-result").last();
  await cardRow.waitFor({ timeout: 5_000 });
  const desktopLayout = await cardRow.evaluate((row) => {
    const element = row as HTMLElement;
    const body = element.querySelector<HTMLElement>(".message-body");
    const card = element.querySelector<HTMLElement>(".subagent-card");
    const actionArea = element.querySelector<HTMLElement>(".standalone-card-action-area");
    const actionButton = actionArea?.querySelector<HTMLElement>('[data-row-action="menu"]');
    const style = body ? getComputedStyle(body) : null;
    const rect = element.getBoundingClientRect();
    return {
      classes: Array.from(element.classList),
      hasCard: Boolean(card),
      hasGenericHeader: Boolean(element.querySelector(".message-header")),
      hasActionArea: Boolean(actionArea),
      hasActionButton: Boolean(actionButton),
      overflowY: style?.overflowY ?? null,
      maxHeight: style?.maxHeight ?? null,
      bodyScrollHeight: body?.scrollHeight ?? null,
      bodyClientHeight: body?.clientHeight ?? null,
      width: Math.round(rect.width),
    };
  });
  if (!desktopLayout.hasCard || desktopLayout.hasGenericHeader || desktopLayout.classes.includes("collapsible") || desktopLayout.classes.includes("collapsed")) {
    throw new Error(`Expected Subagent Card to render as a non-collapsible standalone card, saw ${JSON.stringify(desktopLayout)}`);
  }
  if (!desktopLayout.hasActionArea || !desktopLayout.hasActionButton) {
    throw new Error(`Expected standalone Subagent Card action menu, saw ${JSON.stringify(desktopLayout)}`);
  }
  if (desktopLayout.overflowY !== "visible" || desktopLayout.maxHeight !== "none" || ((desktopLayout.bodyScrollHeight ?? 0) > (desktopLayout.bodyClientHeight ?? 0) + 2)) {
    throw new Error(`Expected Subagent Card body to avoid nested scrolling, saw ${JSON.stringify(desktopLayout)}`);
  }
  if (desktopLayout.width <= 0 || desktopLayout.width > 660) {
    throw new Error(`Expected desktop Subagent Card width cap near 640px, saw ${JSON.stringify(desktopLayout)}`);
  }
  await cardRow.locator('[data-row-action="menu"]').click();
  await page.locator('.message-action-menu [data-row-action="copy"]').waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 0, null, { timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "subagent-card.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await cardRow.scrollIntoViewIfNeeded();
  const mobileLayout = await cardRow.evaluate((row) => {
    const element = row as HTMLElement;
    const transcript = document.querySelector<HTMLElement>(".transcript");
    const rect = element.getBoundingClientRect();
    const transcriptRect = transcript?.getBoundingClientRect();
    return {
      mobile: window.matchMedia("(max-width: 767px)").matches || document.querySelector(".pi-web-agent, pi-web-agent")?.classList.contains("mobile-layout") || false,
      width: Math.round(rect.width),
      transcriptWidth: transcriptRect ? Math.round(transcriptRect.width) : null,
      hasCard: Boolean(element.querySelector(".subagent-card")),
      hasGenericHeader: Boolean(element.querySelector(".message-header")),
      text: element.textContent?.slice(0, 160) ?? "",
    };
  });
  if (!mobileLayout.mobile || !mobileLayout.hasCard || mobileLayout.hasGenericHeader) {
    throw new Error(`Expected mobile Subagent Card to stay standalone instead of generic tool row, saw ${JSON.stringify(mobileLayout)}`);
  }
  if ((mobileLayout.transcriptWidth ?? 0) > 0 && mobileLayout.width < (mobileLayout.transcriptWidth ?? 0) * 0.78) {
    throw new Error(`Expected mobile Subagent Card to use available transcript width, saw ${JSON.stringify(mobileLayout)}`);
  }
  await page.screenshot({ path: join(artifactDir, "subagent-card-mobile.png"), fullPage: true });
  return collectMetrics(page);
}

export async function runSubagentCardReconnect(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  await page.locator("#prompt").fill("Please run a slow fake subagent card reconnect scenario for renderer validation.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  const runningCard = page.locator(".subagent-card.running", { hasText: "reviewer" });
  await runningCard.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.querySelector(".subagent-card.running")?.textContent?.includes("read"), null, { timeout: 5_000 });
  const beforeReload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".subagent-card.running").length,
    text: document.querySelector(".transcript")?.textContent?.replace(/\s+/g, " ").slice(0, 240) ?? "",
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, sessionId);
  await waitForAgentRunning(page, 8_000);
  await page.locator(".subagent-card.running", { hasText: "reviewer" }).waitFor({ timeout: 5_000 });
  const afterReload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".subagent-card.running").length,
    text: document.querySelector(".transcript")?.textContent?.replace(/\s+/g, " ").slice(0, 240) ?? "",
  }));
  if (afterReload.cards < 1) throw new Error(`Expected running Subagent Card after reload, before=${JSON.stringify(beforeReload)} after=${JSON.stringify(afterReload)}`);
  await page.screenshot({ path: join(artifactDir, "subagent-card-reconnect-running.png"), fullPage: true });
  await waitForAgentIdle(page, 12_000);
  await page.locator(".subagent-card.completed", { hasText: "Reviewer approved" }).waitFor({ timeout: 5_000 });
  const completed = await page.evaluate(() => ({
    completedCards: document.querySelectorAll(".subagent-card.completed").length,
    cardRows: document.querySelectorAll(".message.subagent-card-result").length,
    text: document.querySelector(".transcript")?.textContent?.replace(/\s+/g, " ").slice(0, 320) ?? "",
  }));
  if (completed.completedCards !== 1 || completed.cardRows !== 1) throw new Error(`Expected exactly one completed Subagent Card after reconnect, saw ${JSON.stringify(completed)}`);
  await page.screenshot({ path: join(artifactDir, "subagent-card-reconnect-completed.png"), fullPage: true });
  return collectMetrics(page);
}

export async function runStreamingResponsiveness(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);

  await page.locator("#prompt").fill("Please produce a long streaming performance response with markdown and code.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await assertComposerMode(page, "running");

  const responsiveness: Array<{ label: string; ms: number }> = [];
  for (let i = 0; i < 12; i++) {
    responsiveness.push(await timed(`fill-prompt-${i}`, () => page.locator("#prompt").fill(`steer while streaming ${i}`)));
    if (i % 3 === 0 && await page.locator("#modelThinkingToggle").isVisible().catch(() => false)) responsiveness.push(await timed(`toggle-model-menu-${i}`, () => page.locator("#modelThinkingToggle").click()));
    if (i % 4 === 0 && await page.locator("#showThinking").isVisible().catch(() => false)) responsiveness.push(await timed(`toggle-thinking-${i}`, () => page.locator("#showThinking").click()));
    await page.waitForTimeout(75);
  }

  await waitForAgentIdle(page, 30_000);
  await assertComposerMode(page, "idle");
  const maxLatencyMs = Math.max(...responsiveness.map((sample) => sample.ms));
  const slowSamples = responsiveness.filter((sample) => sample.ms > 750);
  if (slowSamples.length > 0) {
    throw new Error(`Responsiveness threshold exceeded; max ${maxLatencyMs}ms; slow samples: ${JSON.stringify(slowSamples)}`);
  }

  return { responsiveness, maxLatencyMs, ...(await collectMetrics(page)) };
}

export async function runQueuedFollowUp(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please produce a long streaming response and consume queued follow-up before transcript so queued follow-up cancellation and editing can be tested.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);

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
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForAgentRunning(page, 10_000);
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
  await waitForAgentIdle(page, 30_000);
  await page.screenshot({ path: join(artifactDir, "queued-follow-up-final.png"), fullPage: true });
  return collectMetrics(page);
}

export async function runTranscriptScrollStability(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  await page.locator("#prompt").fill("Please produce a very long streaming performance response with many paragraphs, markdown, code, and enough text to overflow the transcript while still streaming.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
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
  await waitForAgentIdle(page, 30_000);

  await page.evaluate(() => {
    localStorage.setItem("piWebAutoScroll", "false");
    const transcript = document.querySelector(".transcript") as HTMLElement | null;
    if (!transcript) return;
    transcript.scrollTop = 0;
    transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.goto(`${webBase}/sessions`, { waitUntil: "domcontentloaded" });
  await page.locator(`.sessions-page [data-session-id="${sessionId}"]`).click();
  await waitForSelectedSession(page, sessionId);
  await page.waitForFunction(() => {
    const transcript = document.querySelector(".transcript") as HTMLElement | null;
    return Boolean(transcript && transcript.scrollHeight > transcript.clientHeight && transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 80 && !document.querySelector("#jumpToLatest"));
  }, null, { timeout: 5_000 });

  const reopened = await page.evaluate(() => {
    const transcript = document.querySelector(".transcript") as HTMLElement;
    return { top: transcript.scrollTop, height: transcript.scrollHeight, clientHeight: transcript.clientHeight, bottomGap: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop };
  });
  return { before, after, drift, reopened, ...(await collectMetrics(page)) };
}

export async function runTranscriptTextSelection(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce a concise markdown response with several words that can be selected for regression coverage.");
  const markdown = page.locator(".message.assistant .markdown-body").last();
  await markdown.waitFor({ timeout: 5_000 });
  await page.locator('.message.user [data-message-timestamp="true"]').last().waitFor({ timeout: 5_000 });
  await page.locator('.message.assistant [data-message-timestamp="true"]').last().waitFor({ timeout: 5_000 });
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


export async function runInspectorPreview(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce markdown with an image screenshot preview and run a tool for inspector removal validation.");
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".tree-drawer").waitFor({ state: "detached", timeout: 5_000 });
  const assistant = page.locator(".message.assistant").last();
  await assistant.waitFor({ timeout: 5_000 });
  await assistant.locator('[data-row-action="copy"]').first().click();
  const tool = page.locator(".message.tool").first();
  await tool.waitFor({ timeout: 5_000 });
  if (!(await tool.evaluate((row) => row.classList.contains("collapsed")))) {
    await tool.locator('[data-row-action="toggle-output"]').click();
    await page.waitForFunction(() => document.querySelector<HTMLElement>(".message.tool")?.classList.contains("collapsed"));
  }
  await tool.locator('[data-row-action="toggle-output"]').click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(".message.tool")).some((row) => getComputedStyle(row).display !== "none" && !row.classList.contains("collapsed") && row.querySelector(".message-body")));
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "inspector-removal-transcript.png"), fullPage: true });
  return collectMetrics(page);
}


export async function runNarrowToolStream(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareSession(page);
  await page.locator("#prompt").fill("Please run many long narrow tools and produce a streaming response for layout validation.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 1, null, { timeout: 15_000 });
  const mobileActivityDefault = await page.evaluate(() => {
    const tool = document.querySelector<HTMLElement>(".message.tool.running") ?? document.querySelector<HTMLElement>(".message.tool");
    const transcript = document.querySelector<HTMLElement>(".transcript");
    return {
      mobile: window.matchMedia("(max-width: 767px)").matches,
      collapsed: tool?.classList.contains("collapsed") ?? false,
      toolRunning: tool?.classList.contains("running") ?? false,
      activityCards: document.querySelectorAll(".tool-activity-card, .tool-activity-run").length,
      activityMembers: document.querySelectorAll('pi-transcript-row[data-tool-activity-member]').length,
      hasJumpToLatest: Boolean(document.querySelector("#jumpToLatest")),
      bottomGap: transcript ? Math.round(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop) : null,
    };
  });
  if (!mobileActivityDefault.mobile || mobileActivityDefault.activityCards !== 0 || mobileActivityDefault.activityMembers !== 0) {
    throw new Error(`Expected running tool row without activity wrappers on mobile, saw ${JSON.stringify(mobileActivityDefault)}`);
  }
  if (mobileActivityDefault.hasJumpToLatest || (mobileActivityDefault.bottomGap ?? 999) > 80) {
    throw new Error(`Expected transcript auto-scroll to stay pinned during running tool stream, saw ${JSON.stringify(mobileActivityDefault)}`);
  }
  await page.evaluate(() => {
    if (window.__piWebPerf) {
      window.__piWebPerf.renderCount = 0;
      window.__piWebPerf.renderMs = [];
      window.__piWebPerf.patchCount = 0;
      window.__piWebPerf.patchMs = [];
      window.__piWebPerf.rowUpdateCount = 0;
      window.__piWebPerf.rowUpdateMs = [];
      window.__piWebPerf.eventCounts = {};
      window.__piWebPerf.reasonCounts = {};
      window.__piWebPerf.recentEvents = [];
    }
  });
  await page.screenshot({ path: join(artifactDir, "tool-stream.png"), fullPage: true });
  await waitForAgentIdle(page, 30_000);
  await page.waitForFunction(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    return Boolean(transcript && transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 80 && !document.querySelector("#jumpToLatest"));
  }, null, { timeout: 5_000 });
  const completedActivityDefault = await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    return {
      activityCards: document.querySelectorAll(".tool-activity-card, .tool-activity-run").length,
      activityMembers: document.querySelectorAll('pi-transcript-row[data-tool-activity-member]').length,
      collapsedTools: document.querySelectorAll(".message.tool.collapsed").length,
      hasJumpToLatest: Boolean(document.querySelector("#jumpToLatest")),
      bottomGap: transcript ? Math.round(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop) : null,
    };
  });
  if (completedActivityDefault.activityCards !== 0 || completedActivityDefault.activityMembers !== 0 || completedActivityDefault.collapsedTools < 1) {
    throw new Error(`Expected completed tools to remain collapsed flat rows, saw ${JSON.stringify(completedActivityDefault)}`);
  }
  if (completedActivityDefault.hasJumpToLatest || (completedActivityDefault.bottomGap ?? 999) > 80) {
    throw new Error(`Expected transcript auto-scroll to finish pinned after narrow tool stream, saw ${JSON.stringify(completedActivityDefault)}`);
  }
  const toolStreamPerf = await page.evaluate(() => window.__piWebPerf ? { renderCount: window.__piWebPerf.renderCount, patchCount: window.__piWebPerf.patchCount, rowUpdateCount: window.__piWebPerf.rowUpdateCount ?? 0 } : null);
  if ((toolStreamPerf?.renderCount ?? 0) > 2) throw new Error(`Expected tool streaming to avoid repeated full renders, saw ${JSON.stringify(toolStreamPerf)}`);
  const tool = page.locator('.message.tool').first();
  await tool.waitFor({ timeout: 5_000 });
  await tool.locator('[data-row-action="toggle-output"]').click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(".message.tool")).some((row) => getComputedStyle(row).display !== "none" && !row.classList.contains("collapsed")));
  await page.locator(".message.tool:not(.collapsed)").first().waitFor({ timeout: 5_000 });
  await page.locator('.message.tool:not(.collapsed) [data-row-action="toggle-output"]').first().click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>(".message.tool.collapsed")).some((row) => getComputedStyle(row).display !== "none"));
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
  return { toolStreamPerf, ...(await collectMetrics(page)) };
}

export async function runToolGrouping(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please run multiple tools with one failed tool for flat tool-row alignment validation.");
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 4, null, { timeout: 5_000 });
  const groups = await page.locator(".tool-run-group").count();
  if (groups !== 0) throw new Error(`Expected no legacy nested tool-run groups, saw ${groups} groups`);
  const activityRuns = await page.locator(".tool-activity-run, .tool-activity-card").count();
  if (activityRuns !== 0) throw new Error(`Expected no tool activity wrappers, saw ${activityRuns}`);
  const activityMembers = await page.locator('pi-transcript-row[data-tool-activity-member]').count();
  if (activityMembers !== 0) throw new Error(`Expected no hidden tool activity members, saw ${activityMembers}`);
  await page.locator(".message.tool", { hasText: "read screenshots/fixture.png" }).waitFor({ timeout: 5_000 });
  const failedExpanded = page.locator(".message.tool.error:not(.collapsed)").first();
  if (await failedExpanded.isVisible().catch(() => false)) {
    await failedExpanded.locator('[data-row-action="toggle-output"]').click();
    await page.waitForFunction(() => document.querySelector(".message.tool.error.collapsed"));
  }
  const collapsedBefore = await page.locator(".message.tool.collapsed").count();
  if (collapsedBefore < 3) throw new Error(`Expected flat tool receipts to remain collapsed, saw ${collapsedBefore}`);
  const overflowButtons = page.locator('.message.tool [data-row-action="menu"]');
  await overflowButtons.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".message-action-menu").length === 0);
  const alignment = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
    };
    const successRow = document.querySelector<HTMLElement>(".message.tool.done.collapsed");
    const failedRow = document.querySelector<HTMLElement>(".message.tool.error.collapsed");
    if (!successRow || !failedRow) {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".message.tool")).map((row) => ({ classes: row.className, text: row.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) }));
      throw new Error(`Expected successful and failed collapsed tool rows for alignment check: ${JSON.stringify(rows)}`);
    }
    const successId = successRow.dataset.transcriptId;
    const failedId = failedRow.dataset.transcriptId;
    const successToggle = rectOf(`[data-transcript-id="${CSS.escape(successId ?? "")}"] .message-expand-toggle`);
    const failedToggle = rectOf(`[data-transcript-id="${CSS.escape(failedId ?? "")}"] .message-expand-toggle`);
    const successTitle = rectOf(`[data-transcript-id="${CSS.escape(successId ?? "")}"] .message-header strong`);
    const failedTitle = rectOf(`[data-transcript-id="${CSS.escape(failedId ?? "")}"] .message-header strong`);
    const successHeader = rectOf(`[data-transcript-id="${CSS.escape(successId ?? "")}"] .message-header`);
    const failedHeader = rectOf(`[data-transcript-id="${CSS.escape(failedId ?? "")}"] .message-header`);
    return {
      toggleLeftDelta: Math.abs(successToggle.left - failedToggle.left),
      titleLeftDelta: Math.abs(successTitle.left - failedTitle.left),
      headerHeightDelta: Math.abs(successHeader.height - failedHeader.height),
      toggleTopOffsetDelta: Math.abs(successToggle.top - successHeader.top - (failedToggle.top - failedHeader.top)),
    };
  });
  if (alignment.toggleLeftDelta > 1 || alignment.titleLeftDelta > 1 || alignment.headerHeightDelta > 1 || alignment.toggleTopOffsetDelta > 1) {
    throw new Error(`Failed tool row alignment regressed: ${JSON.stringify(alignment)}`);
  }
  await page.screenshot({ path: join(artifactDir, "tool-grouping-expanded.png"), fullPage: true });
  return { groups, activityRuns, activityMembers, alignment, toolRows: await page.locator(".message.tool").count(), ...(await collectMetrics(page)) };
}

export async function runToolImageHeavyTranscript(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please produce a tool-image-heavy transcript for performance measurement.");
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 80, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.length >= 1 && images.slice(0, 12).every((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15_000 });
  const responsiveness = [
    await timed("fill-prompt-after-heavy-transcript", () => page.locator("#prompt").fill("typing after tool/image-heavy transcript")),
    await timed("toggle-model-settings-after-heavy-transcript", async () => {
      await page.locator("#modelThinkingToggle").click();
      await page.locator(".model-thinking-popover").waitFor({ timeout: 5_000 });
    }),
    await timed("open-tool-menu-after-heavy-transcript", async () => {
      await page.locator('.message.tool [data-row-action="menu"]').first().click();
      await page.locator(".message-action-menu").waitFor({ timeout: 5_000 });
    }),
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


export async function runModelThinking(page: Page): Promise<Record<string, unknown>> {
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
  await page.waitForFunction(() => window.matchMedia("(max-width: 767px)").matches, null, { timeout: 5_000 });
  await page.locator("#modelThinkingToggle").click();
  await page.locator(".model-thinking-popover").waitFor({ timeout: 5_000 });
  const mobilePickerState = await page.evaluate(() => {
    const popover = document.querySelector(".model-thinking-popover");
    const thinkingSlider = document.querySelector('[role="radiogroup"][aria-label="Thinking level"]');
    const rect = popover?.getBoundingClientRect();
    const sliderRect = thinkingSlider?.getBoundingClientRect();
    return {
      left: rect ? Math.round(rect.left) : null,
      right: rect ? Math.round(rect.right) : null,
      sliderWidth: sliderRect ? Math.round(sliderRect.width) : null,
      viewportWidth: window.innerWidth,
    };
  });
  if ((mobilePickerState.sliderWidth ?? 0) < 140 || (mobilePickerState.left ?? -999) < -1 || (mobilePickerState.right ?? 9999) > mobilePickerState.viewportWidth + 1) {
    throw new Error(`Mobile model/thinking picker should preserve selections and stay onscreen: ${JSON.stringify(mobilePickerState)}`);
  }
  await page.screenshot({ path: join(artifactDir, "model-thinking-mobile.png"), fullPage: true });
  return collectMetrics(page);
}

