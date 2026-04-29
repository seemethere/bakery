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

export const mobileScenarios = [
  "mobile-layout",
  "mobile-long-transcript-controls",
  "mobile-image-stream-stability",
] as const;

export async function runMobileLayout(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    // Seed a desktop-open sidebar preference; mobile should still start with the drawer closed
    // and should not overwrite the desktop pin preference while using the temporary drawer.
    localStorage.setItem("piWebSessionSidebarCollapsed", "false");
    localStorage.setItem("piWebSessionSidebarPinned", "true");
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
  const emptyComposerSendDisabled = await page.locator("#send").evaluate((button: HTMLButtonElement) => button.disabled);
  if (!emptyComposerSendDisabled) throw new Error("Mobile composer send should be disabled before the user enters text or attaches images.");
  await page.screenshot({ path: join(artifactDir, "mobile-empty-quick-starts.png"), fullPage: true });
  const app = page.locator("pi-web-agent");
  if (!await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"))) {
    throw new Error("Mobile initial render should ignore desktop-open sidebar persistence and start with the drawer closed.");
  }
  await page.locator("#toggleSessionSidebarMobile").waitFor({ timeout: 5_000 });
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".context-usage", { hasText: "Ctx" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("Mobile layout regression draft");
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  const originalSessionId = await selectedSessionId(page);
  if (!originalSessionId) throw new Error("Could not find active mobile session before selection smoke.");
  const drawerOrder = await page.evaluate(() => {
    const drawerElements = Array.from(document.querySelectorAll(".session-sidebar:not(.collapsed) *"));
    return {
      chatButtonCount: document.querySelectorAll('.session-sidebar:not(.collapsed) [data-route-path^="/sessions/"], .session-sidebar:not(.collapsed) [data-route-path="/"]').length,
      sessionsIndex: drawerElements.findIndex((element) => element.matches?.('[data-route-path="/sessions"]')),
      newSessionIndex: drawerElements.findIndex((element) => element.id === "newSession"),
      settingsIndex: drawerElements.findIndex((element) => element.matches?.('[data-route-path="/settings"]')),
      apiBaseIndex: drawerElements.findIndex((element) => element.id === "apiBase"),
      pinButtonCount: document.querySelectorAll("#pinSessionSidebar").length,
      backdropVisible: !!document.querySelector("#sessionSidebarBackdrop"),
      sessionCardCount: document.querySelectorAll(".session-sidebar [data-session-id]").length,
    };
  });
  if (!drawerOrder.backdropVisible) throw new Error("Mobile drawer should render a backdrop while open.");
  if (drawerOrder.pinButtonCount !== 0) throw new Error("Mobile drawer should not show the desktop Pin affordance.");
  if (drawerOrder.sessionCardCount !== 0) throw new Error("Mobile navigation drawer should not duplicate the sessions page list.");
  if (drawerOrder.chatButtonCount !== 0) throw new Error("Mobile navigation drawer should not show a redundant chat route button.");
  if (drawerOrder.apiBaseIndex !== -1) throw new Error(`Mobile drawer should move API settings to /settings: ${JSON.stringify(drawerOrder)}`);
  if (!(drawerOrder.sessionsIndex >= 0 && drawerOrder.newSessionIndex > drawerOrder.sessionsIndex && drawerOrder.settingsIndex > drawerOrder.newSessionIndex)) {
    throw new Error(`Mobile drawer navigation/settings order is wrong: ${JSON.stringify(drawerOrder)}`);
  }
  await page.locator('.session-sidebar:not(.collapsed) [data-route-path="/settings"]').click();
  await page.locator(".settings-page #apiBase").waitFor({ timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator('.session-sidebar:not(.collapsed) [data-route-path="/sessions"]').click();
  await page.locator(".sessions-page").waitFor({ timeout: 5_000 });
  await page.locator(`.sessions-page [data-session-id="${originalSessionId}"]`).click();
  await page.waitForFunction((sessionId) => (document.querySelector("pi-web-agent") as unknown as { selectedSession?: { id?: string } } | null)?.selectedSession?.id === sessionId, originalSessionId, { timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click());
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  const preservedDesktopPin = await page.evaluate(() => localStorage.getItem("piWebSessionSidebarPinned"));
  if (preservedDesktopPin !== "true") throw new Error(`Mobile drawer interactions should not overwrite desktop pin preference; saw ${preservedDesktopPin}`);
  await page.evaluate(() => {
    const app = document.querySelector("pi-web-agent") as unknown as { selectedSession?: Record<string, unknown>; sessions?: Array<Record<string, unknown>>; render?: () => void } | null;
    if (!app?.selectedSession) return;
    const isolatedSession = {
      ...app.selectedSession,
      isolationKind: "git_worktree",
      sourceCwd: app.selectedSession.sourceCwd ?? app.selectedSession.cwd,
      worktreePath: app.selectedSession.worktreePath ?? app.selectedSession.cwd,
      worktreeBranch: app.selectedSession.worktreeBranch ?? "bakery/session/mobile-smoke",
      worktreeBaseCommit: app.selectedSession.worktreeBaseCommit ?? "abcdef0",
      worktreeSourceDirty: true,
    };
    app.selectedSession = isolatedSession;
    if (app.sessions) app.sessions = app.sessions.map((session) => session.id === isolatedSession.id ? isolatedSession : session);
    app.render?.();
  });
  await page.locator(".session-isolation-chip", { hasText: "Isolated" }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "mobile-isolated-header.png"), fullPage: true });
  await page.locator(".session-isolation-chip").click();
  await page.locator(".session-details-popover", { hasText: "Worktree" }).waitFor({ timeout: 5_000 });
  await page.locator("#closeSessionDetails").click();
  await page.locator(".session-details-popover").waitFor({ state: "detached", timeout: 5_000 });
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
      mobileDetails: rectOf("#toggleSessionDetails"),
      isolationChip: rectOf(".session-isolation-chip"),
      isolationLabel: document.querySelector(".session-isolation-chip")?.textContent?.trim() ?? "",
      mobileDetailsLabelDisplay: getComputedStyle(document.querySelector(".session-details-label") ?? document.body).display,
      mobileDetailsIconDisplay: getComputedStyle(document.querySelector(".session-details-icon") ?? document.body).display,
      workspaceLine: rectOf(".session-workspace"),
      headerStatus: rectOf(".header-status"),
      closedSidebar: rectOf(".session-sidebar.collapsed"),
      inspectorPanels: document.querySelectorAll(".right-panel, .tree-drawer").length,
      drawerOrder,
    };
  }, drawerOrder);

  const viewportWidth = layout.viewport.width;
  if (layout.documentWidth > viewportWidth + 2) throw new Error(`Mobile layout has horizontal overflow: document ${layout.documentWidth}px, viewport ${viewportWidth}px`);
  if ((layout.mobileMenu?.width ?? 0) < 30) throw new Error(`Mobile hamburger missing or too small: ${layout.mobileMenu?.width}px`);
  if (!layout.mobileDetails || layout.mobileDetails.width > 34 || layout.mobileDetailsLabelDisplay !== "none" || layout.mobileDetailsIconDisplay === "none") throw new Error(`Mobile details affordance should be compact and icon-only: ${JSON.stringify({ rect: layout.mobileDetails, labelDisplay: layout.mobileDetailsLabelDisplay, iconDisplay: layout.mobileDetailsIconDisplay })}`);
  if (!layout.isolationChip || layout.isolationChip.width > 96 || layout.isolationLabel !== "⎇Isolated") throw new Error(`Mobile isolated session chip should be compact and visible: ${JSON.stringify({ rect: layout.isolationChip, label: layout.isolationLabel })}`);
  if (layout.workspaceLine !== null) throw new Error(`Mobile workspace metadata should move out of the persistent header: ${JSON.stringify(layout.workspaceLine)}`);
  if (layout.headerStatus !== null) throw new Error(`Mobile header should hide passive status pills: ${JSON.stringify(layout.headerStatus)}`);
  if (layout.closedSidebar !== null) throw new Error(`Mobile closed sidebar should not occupy a rail: ${JSON.stringify(layout.closedSidebar)}`);
  if (layout.inspectorPanels !== 0) throw new Error(`Mobile inspector/tree panels should be detached, saw ${layout.inspectorPanels}`);
  if (!layout.contextUsage || !layout.contextUsageText.includes("Ctx")) throw new Error(`Mobile context usage should be visible and compact: ${JSON.stringify({ rect: layout.contextUsage, text: layout.contextUsageText })}`);
  if (!layout.modelThinkingTrigger || !layout.modelThinkingText) throw new Error(`Mobile model/thinking trigger should be visible: ${JSON.stringify({ rect: layout.modelThinkingTrigger, text: layout.modelThinkingText })}`);
  if (layout.drawerOrder.newSessionIndex < 0 || layout.drawerOrder.settingsIndex < 0 || layout.drawerOrder.newSessionIndex > layout.drawerOrder.settingsIndex) throw new Error(`Mobile drawer should keep session creation before settings nav: new=${layout.drawerOrder.newSessionIndex}, settings=${layout.drawerOrder.settingsIndex}`);
  if ((layout.header?.height ?? 999) > 64) throw new Error(`Mobile header too tall: ${layout.header?.height}px`);
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
  await page.locator("#toggleSessionDetails").click();
  await page.locator(".session-details-popover #generateMetadata").click();
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
  await waitForAgentRunning(page);
  const runningControls = await page.evaluate(() => {
    const visibleText = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || getComputedStyle(element).display === "none") return "";
      return element.innerText.trim().replace(/\s+/g, " ");
    };
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      sendText: visibleText("#send"),
      followUpText: visibleText("#followUp"),
      abortText: visibleText("#abort"),
      sendDisabled: document.querySelector<HTMLButtonElement>("#send")?.disabled ?? null,
      followUpDisabled: document.querySelector<HTMLButtonElement>("#followUp")?.disabled ?? null,
      send: rectOf("#send"),
      followUp: rectOf("#followUp"),
      abort: rectOf("#abort"),
    };
  });
  if (!runningControls.sendText.includes("Guide") || !runningControls.followUpText.includes("Follow up")) throw new Error(`Mobile running controls should label guidance and follow-up actions: ${JSON.stringify(runningControls)}`);
  if (!runningControls.sendDisabled || !runningControls.followUpDisabled) throw new Error(`Mobile running prompt actions should be disabled again after sending clears the composer: ${JSON.stringify(runningControls)}`);
  if (runningControls.abortText) throw new Error(`Mobile stop control should remain icon-only: ${JSON.stringify(runningControls)}`);
  if ((runningControls.send?.width ?? 0) < 58 || (runningControls.followUp?.width ?? 0) < 82 || (runningControls.abort?.width ?? 999) > 42) throw new Error(`Mobile running controls should expose labels while keeping stop compact: ${JSON.stringify(runningControls)}`);
  await page.screenshot({ path: join(artifactDir, "mobile-running-composer-controls.png"), fullPage: true });
  await page.locator("#prompt").fill("mobile queued steer should start collapsed");
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
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


export async function runMobileImageStreamStability(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("pi-web-agent")?.classList.contains("mobile-layout"), null, { timeout: 5_000 });
  await sendPromptAndWaitIdle(page, "Please produce a tool-image-heavy transcript for mobile image stability measurement.");
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img, .rendered-image img, .transcript-markdown-image"));
    return images.length >= 1 && images[0]!.complete && images[0]!.naturalWidth > 0;
  }, null, { timeout: 15_000 });
  const before = await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>(".artifact-image img, .rendered-image img, .transcript-markdown-image");
    if (!image) throw new Error("Expected a loaded transcript image before streaming");
    window.__piWebStableImage = image;
    return { src: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight, toolRows: document.querySelectorAll(".message.tool").length };
  });

  await page.locator("#prompt").fill("Please run multiple tools while streaming a long mobile image stability response.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await page.waitForFunction((toolRows) => document.querySelectorAll(".message.tool").length > toolRows, before.toolRows, { timeout: 10_000 });
  await delay(700);
  const during = await page.evaluate(() => {
    const image = window.__piWebStableImage;
    return {
      stillConnected: Boolean(image?.isConnected),
      stillComplete: Boolean(image?.complete && image.naturalWidth > 0),
      sameFirstImage: document.querySelector(".artifact-image img, .rendered-image img, .transcript-markdown-image") === image,
      failedImageCount: window.__piWebFailedImageCount ?? 0,
    };
  });
  if (!during.stillConnected || !during.stillComplete || !during.sameFirstImage) throw new Error(`Transcript image was replaced or unloaded during streaming: ${JSON.stringify(during)}`);
  await waitForAgentIdle(page, 30_000);
  await page.screenshot({ path: join(artifactDir, "mobile-image-stream-stability.png"), fullPage: true });
  return { before, during, ...(await collectMetrics(page)) };
}

export async function runMobileLongTranscriptControls(page: Page): Promise<Record<string, unknown>> {
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
      window.__piWebPerf.eventCounts = {};
      window.__piWebPerf.reasonCounts = {};
      window.__piWebPerf.recentEvents = [];
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

  const firstTool = page.locator(".message.tool").first();
  await firstTool.waitFor({ timeout: 5_000 });
  responsiveness.push(await timed("mobile-focus-flat-tool-receipt", async () => {
    await firstTool.scrollIntoViewIfNeeded();
    await firstTool.waitFor({ state: "visible", timeout: 5_000 });
  }));
  const firstToolToggle = page.locator('.message.tool [data-row-action="toggle-output"]').first();
  responsiveness.push(await timed("mobile-expand-tool-output", async () => {
    await firstToolToggle.click();
    await page.locator(".message.tool:not(.collapsed) .message-body").first().waitFor({ state: "visible", timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-open-tool-action-menu", async () => {
    await page.locator('.message.tool [data-row-action="menu"]').first().click();
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


