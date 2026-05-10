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
  waitForMobileLayout,
  waitForPromptDisabled,
  waitForPromptEnabled,
  waitForSelectedSession,
  waitForSidebarCollapsed,
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
  await page.locator(".empty-session-greeting", { hasText: "New Bakery session" }).waitFor({ timeout: 5_000 });
  await page.locator(".empty-quick-start-chips [data-empty-quick-start='plan']", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  const mobileEmptyLayout = await page.evaluate(() => {
    const transcript = document.querySelector(".transcript")?.getBoundingClientRect();
    const footer = document.querySelector("footer")?.getBoundingClientRect();
    const quickStarts = document.querySelector(".empty-quick-start-chips")?.getBoundingClientRect();
    const jumpToLatest = document.querySelector("#jumpToLatest")?.getBoundingClientRect();
    return {
      viewport: { height: window.innerHeight, width: window.innerWidth },
      transcript: transcript ? { height: Math.round(transcript.height), width: Math.round(transcript.width) } : null,
      footer: footer ? { top: Math.round(footer.top), bottom: Math.round(footer.bottom), height: Math.round(footer.height), width: Math.round(footer.width) } : null,
      quickStarts: quickStarts ? { height: Math.round(quickStarts.height), width: Math.round(quickStarts.width) } : null,
      hasJumpToLatest: Boolean(jumpToLatest),
    };
  });
  if (mobileEmptyLayout.hasJumpToLatest) throw new Error("Empty mobile session should not show Jump to latest");
  if ((mobileEmptyLayout.quickStarts?.height ?? 999) > 120) throw new Error(`Mobile quick start chips are too tall: ${mobileEmptyLayout.quickStarts?.height}px`);
  if ((mobileEmptyLayout.quickStarts?.width ?? 0) > (mobileEmptyLayout.viewport.width ?? 0)) throw new Error(`Mobile quick start chips overflow viewport: ${JSON.stringify(mobileEmptyLayout)}`);
  const footerCenter = ((mobileEmptyLayout.footer?.top ?? 0) + (mobileEmptyLayout.footer?.bottom ?? 0)) / 2;
  if (Math.abs(footerCenter - mobileEmptyLayout.viewport.height / 2) > 170) throw new Error(`Mobile empty composer is not centered enough: ${JSON.stringify(mobileEmptyLayout)}`);
  const emptyComposerSendDisabled = await page.locator("#send").evaluate((button: HTMLButtonElement) => button.disabled);
  if (!emptyComposerSendDisabled) throw new Error("Mobile composer send should be disabled before the user enters text or attaches images.");
  await page.screenshot({ path: join(artifactDir, "mobile-empty-quick-starts.png"), fullPage: true });

  await page.locator("#prompt").focus();
  await page.locator("#prompt").fill("Mobile layout regression draft\nwith enough text to exercise wrapping and composer growth before sending.");
  await page.setViewportSize({ width: 360, height: 780 });
  await waitForMobileLayout(page);
  const composerMetrics = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom), right: Math.round(rect.right) };
    };
    const intersects = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
    const promptStyle = prompt ? getComputedStyle(prompt) : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      prompt: rectOf("#prompt"),
      footer: rectOf("footer"),
      transcript: rectOf(".transcript"),
      attach: rectOf("#attachImages"),
      send: rectOf("#send"),
      attachSendOverlap: intersects(rectOf("#attachImages"), rectOf("#send")),
      promptFontSize: promptStyle ? Number.parseFloat(promptStyle.fontSize) : 0,
      promptLineHeight: promptStyle?.lineHeight ?? "",
      promptScrollHeight: prompt?.scrollHeight ?? 0,
      promptClientHeight: prompt?.clientHeight ?? 0,
    };
  });
  if (composerMetrics.promptFontSize < 16) throw new Error(`Mobile prompt font should avoid focus zoom; saw ${JSON.stringify(composerMetrics)}`);
  if (composerMetrics.documentWidth > composerMetrics.viewport.width + 2) throw new Error(`Mobile composer focus created horizontal overflow: ${JSON.stringify(composerMetrics)}`);
  if (composerMetrics.attachSendOverlap) throw new Error(`Mobile attach input overlaps send button: ${JSON.stringify(composerMetrics)}`);
  if ((composerMetrics.footer?.height ?? 999) > 190) throw new Error(`Mobile focused composer footer too tall: ${JSON.stringify(composerMetrics)}`);
  if ((composerMetrics.transcript?.height ?? 0) < 320) throw new Error(`Mobile focused composer leaves too little transcript: ${JSON.stringify(composerMetrics)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForMobileLayout(page);
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await waitForAgentIdle(page, 30_000);
  await page.locator(".message.user", { hasText: "Mobile layout regression draft" }).waitFor({ timeout: 5_000 });
  await page.setViewportSize({ width: 360, height: 780 });
  await waitForMobileLayout(page);
  const compactHeader = await page.evaluate(() => {
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none") return null;
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      viewportWidth: window.innerWidth,
      title: rectOf(".session-title"),
      titleText: document.querySelector(".session-title")?.textContent?.trim() ?? "",
      mobileMenu: rectOf("#toggleSessionSidebarMobile"),
      details: rectOf('[aria-label="Session details"]'),
      workspace: rectOf(".session-workspace"),
      status: rectOf(".header-status"),
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  if ((compactHeader.mobileMenu?.width ?? 0) < 28) throw new Error(`Compact mobile header should preserve hamburger access: ${JSON.stringify(compactHeader)}`);
  if (!compactHeader.title || !compactHeader.titleText || compactHeader.title.right > (compactHeader.details?.left ?? compactHeader.viewportWidth) - 4) throw new Error(`Compact mobile header title should not crowd actions: ${JSON.stringify(compactHeader)}`);
  if (compactHeader.workspace !== null || compactHeader.status !== null) throw new Error(`Compact mobile header should hide workspace/status chrome: ${JSON.stringify(compactHeader)}`);
  if (compactHeader.documentWidth > compactHeader.viewportWidth + 2) throw new Error(`Compact mobile header created horizontal overflow: ${JSON.stringify(compactHeader)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForMobileLayout(page);

  const app = page.locator(".pi-web-agent");
  if (!await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"))) {
    throw new Error("Mobile initial render should ignore desktop-open sidebar persistence and start with the drawer closed.");
  }
  await page.locator("#toggleSessionSidebarMobile").waitFor({ timeout: 5_000 });
  await page.locator(".right-panel").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".context-usage").waitFor({ state: "hidden", timeout: 5_000 });
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  const originalSessionId = await selectedSessionId(page);
  if (!originalSessionId) throw new Error("Could not find active mobile session before selection smoke.");
  const drawerOrder = await page.evaluate(() => {
    const drawerElements = Array.from(document.querySelectorAll(".session-sidebar:not(.collapsed) *"));
    return {
      chatButtonCount: document.querySelectorAll('.session-sidebar:not(.collapsed) [data-route-path^="/sessions/"], .session-sidebar:not(.collapsed) [data-route-path="/"]').length,
      brandIndex: drawerElements.findIndex((element) => element.textContent?.trim().toLowerCase() === "bakery"),
      searchIndex: drawerElements.findIndex((element) => element.textContent?.includes("Search sessions")),
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
  if (drawerOrder.sessionCardCount < 1) throw new Error("Mobile navigation drawer should show the session list.");
  if (drawerOrder.chatButtonCount !== 0) throw new Error("Mobile navigation drawer should not show a redundant chat route button.");
  if (drawerOrder.brandIndex !== -1) throw new Error(`Mobile drawer should skip static Bakery branding and start with actions/sessions: ${JSON.stringify(drawerOrder)}`);
  if (drawerOrder.searchIndex !== -1) throw new Error(`Mobile drawer should keep command search out of the primary session switcher: ${JSON.stringify(drawerOrder)}`);
  if (drawerOrder.apiBaseIndex !== -1) throw new Error(`Mobile drawer should move API settings to /settings: ${JSON.stringify(drawerOrder)}`);
  if (!(drawerOrder.newSessionIndex >= 0 && drawerOrder.settingsIndex > drawerOrder.newSessionIndex)) {
    throw new Error(`Mobile drawer navigation/settings order is wrong: ${JSON.stringify(drawerOrder)}`);
  }
  await page.locator('.session-sidebar:not(.collapsed) [data-route-path="/settings"]').click();
  await page.locator(".settings-page #apiBase").waitFor({ timeout: 5_000 });
  await page.setViewportSize({ width: 360, height: 780 });
  await waitForMobileLayout(page);
  const mobileSettingsDialog = await page.evaluate(() => {
    const element = document.querySelector(".settings-dialog");
    if (!element || getComputedStyle(element).display === "none") return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, documentWidth: document.documentElement.scrollWidth };
  });
  if (!mobileSettingsDialog || mobileSettingsDialog.left < -1 || mobileSettingsDialog.right > mobileSettingsDialog.viewportWidth + 1 || mobileSettingsDialog.bottom > mobileSettingsDialog.viewportHeight + 1 || mobileSettingsDialog.documentWidth > mobileSettingsDialog.viewportWidth + 2) throw new Error(`Mobile Settings dialog should stay within viewport: ${JSON.stringify(mobileSettingsDialog)}`);
  await page.keyboard.press("Escape");
  await page.locator(".settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.keyboard.press("Escape");
  await page.goto(`${webBase}/sessions`, { waitUntil: "domcontentloaded" });
  await page.locator(".sessions-page").waitFor({ timeout: 5_000 });
  await page.locator(`.sessions-page [data-session-id="${originalSessionId}"]`).click();
  await waitForSelectedSession(page, originalSessionId);
  await page.locator("#toggleSessionSidebarMobile").click();
  await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click());
  await waitForSidebarCollapsed(page);
  const preservedDesktopPin = await page.evaluate(() => localStorage.getItem("piWebSessionSidebarPinned"));
  if (preservedDesktopPin !== "true") throw new Error(`Mobile drawer interactions should not overwrite desktop pin preference; saw ${preservedDesktopPin}`);
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
      app: rectOf(".pi-web-agent"),
      header: rectOf("header"),
      headerTitle: rectOf(".session-title"),
      headerTitleText: document.querySelector(".session-title")?.textContent?.trim() ?? "",
      transcript: rectOf(".transcript"),
      footer: rectOf("footer"),
      prompt: rectOf("#prompt"),
      controls: rectOf(".controls"),
      contextUsage: rectOf(".context-usage"),
      contextUsageText: document.querySelector(".context-usage")?.textContent?.trim() ?? "",
      modelThinkingTrigger: rectOf("#modelThinkingToggle"),
      modelThinkingText: document.querySelector("#modelThinkingToggle")?.textContent?.trim() ?? "",
      mobileMenu: rectOf("#toggleSessionSidebarMobile"),
      mobileDetails: rectOf('[aria-label="Session details"]'),
      mobileDetailsLabelDisplay: "none",
      mobileDetailsIconDisplay: document.querySelector('[aria-label="Session details"] svg') ? "block" : "none",
      workspaceLine: rectOf(".session-workspace"),
      headerStatus: rectOf(".header-status"),
      closedSidebar: rectOf(".session-sidebar.collapsed"),
      inspectorPanels: document.querySelectorAll(".right-panel, .tree-drawer").length,
      drawerOrder,
    };
  }, drawerOrder);

  const viewportWidth = layout.viewport.width;
  if (layout.documentWidth > viewportWidth + 2) throw new Error(`Mobile layout has horizontal overflow: document ${layout.documentWidth}px, viewport ${viewportWidth}px`);
  if ((layout.mobileMenu?.width ?? 0) < 28) throw new Error(`Mobile hamburger missing or too small: ${layout.mobileMenu?.width}px`);
  if (!layout.headerTitle || !layout.headerTitleText || layout.headerTitle.right > (layout.mobileDetails?.left ?? viewportWidth) - 4) throw new Error(`Mobile header title should stay visible without crowding primary actions: ${JSON.stringify({ title: layout.headerTitle, text: layout.headerTitleText, details: layout.mobileDetails })}`);
  if (!layout.mobileDetails || layout.mobileDetails.width > 40 || layout.mobileDetailsLabelDisplay !== "none" || layout.mobileDetailsIconDisplay === "none") throw new Error(`Mobile details affordance should be compact and icon-only: ${JSON.stringify({ rect: layout.mobileDetails, labelDisplay: layout.mobileDetailsLabelDisplay, iconDisplay: layout.mobileDetailsIconDisplay })}`);
  if (layout.workspaceLine !== null) throw new Error(`Mobile workspace metadata should move out of the persistent header: ${JSON.stringify(layout.workspaceLine)}`);
  if (layout.headerStatus !== null) throw new Error(`Mobile header should hide passive status pills: ${JSON.stringify(layout.headerStatus)}`);
  if (layout.closedSidebar !== null) throw new Error(`Mobile closed sidebar should not occupy a rail: ${JSON.stringify(layout.closedSidebar)}`);
  if (layout.inspectorPanels !== 0) throw new Error(`Mobile inspector/tree panels should be detached, saw ${layout.inspectorPanels}`);
  if (layout.contextUsage !== null) throw new Error(`Mobile context usage should collapse to protect composer space: ${JSON.stringify({ rect: layout.contextUsage, text: layout.contextUsageText })}`);
  if (!layout.modelThinkingTrigger || !layout.modelThinkingText) throw new Error(`Mobile model/thinking trigger should be visible: ${JSON.stringify({ rect: layout.modelThinkingTrigger, text: layout.modelThinkingText })}`);
  if (layout.drawerOrder.newSessionIndex < 0 || layout.drawerOrder.settingsIndex < 0 || layout.drawerOrder.newSessionIndex > layout.drawerOrder.settingsIndex) throw new Error(`Mobile drawer should keep session creation before settings nav: new=${layout.drawerOrder.newSessionIndex}, settings=${layout.drawerOrder.settingsIndex}`);
  if ((layout.header?.height ?? 999) > 72) throw new Error(`Mobile header too tall: ${layout.header?.height}px`);
  if ((layout.footer?.height ?? 999) > 190) throw new Error(`Mobile footer too tall: ${layout.footer?.height}px`);
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

  await page.setViewportSize({ width: 360, height: 780 });
  await waitForMobileLayout(page);
  await page.locator('[aria-label="Session details"]').click();
  await page.locator(".session-details-dialog").waitFor({ timeout: 5_000 });
  const mobileDetailsDialog = await page.evaluate(() => {
    const element = document.querySelector(".session-details-dialog");
    if (!element || getComputedStyle(element).display === "none") return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, documentWidth: document.documentElement.scrollWidth };
  });
  if (!mobileDetailsDialog || mobileDetailsDialog.left < -1 || mobileDetailsDialog.right > mobileDetailsDialog.viewportWidth + 1 || mobileDetailsDialog.bottom > mobileDetailsDialog.viewportHeight + 1 || mobileDetailsDialog.documentWidth > mobileDetailsDialog.viewportWidth + 2) throw new Error(`Mobile Session Details dialog should stay within viewport: ${JSON.stringify(mobileDetailsDialog)}`);
  await page.keyboard.press("Escape");
  await page.locator(".session-details-dialog").waitFor({ state: "detached", timeout: 5_000 });

  await page.getByRole("button", { name: /Prompt|Steer/ }).click();
  const mobileModeMenu = await page.evaluate(() => {
    const element = document.querySelector(".composer-mode-menu");
    if (!element || getComputedStyle(element).display === "none") return null;
    const rect = element.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  if (!mobileModeMenu || mobileModeMenu.left < -1 || mobileModeMenu.right > mobileModeMenu.viewportWidth + 1 || mobileModeMenu.top < -1 || mobileModeMenu.bottom > mobileModeMenu.viewportHeight + 1) throw new Error(`Mobile composer mode menu should stay within viewport: ${JSON.stringify(mobileModeMenu)}`);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForMobileLayout(page);

  const sheet = null;

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
  if (!runningControls.sendDisabled || !runningControls.followUpDisabled) throw new Error(`Mobile running prompt actions should be disabled again after sending clears the composer: ${JSON.stringify(runningControls)}`);
  if ((runningControls.send?.width ?? 0) < 28 || (runningControls.followUp?.width ?? 0) < 28 || (runningControls.abort?.width ?? 999) > 42) throw new Error(`Mobile running controls should remain touchable while keeping stop compact: ${JSON.stringify(runningControls)}`);
  await page.screenshot({ path: join(artifactDir, "mobile-running-composer-controls.png"), fullPage: true });
  await page.locator("#prompt").fill("mobile queued steer should start collapsed");
  await page.locator("#send:not([disabled])").waitFor({ timeout: 5_000 });
  await page.locator("#send").click();
  const collapsedQueue = page.locator(".running-queue", { hasText: "1 pending" });
  await collapsedQueue.waitFor({ timeout: 5_000 });
  await page.locator(".queue-pill", { hasText: "mobile queued steer should start collapsed" }).waitFor({ timeout: 5_000 });
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
  const mobileQueuedPill = page.locator(".running-queue .queue-pill", { hasText: "mobile queued steer should start collapsed" });
  await mobileQueuedPill.waitFor({ timeout: 5_000 });
  await page.screenshot({ path: join(artifactDir, "mobile-queued-expanded.png"), fullPage: true });

  return { ...(await collectMetrics(page)), layout, metadataPopover: sheet, collapsedQueueLayout };
}


export async function runMobileImageStreamStability(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForMobileLayout(page);
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
  const imageOverflow = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  if (imageOverflow.documentWidth > imageOverflow.viewportWidth + 2) throw new Error(`Mobile image transcript created horizontal overflow: ${JSON.stringify(imageOverflow)}`);
  await page.screenshot({ path: join(artifactDir, "mobile-image-stream-stability.png"), fullPage: true });
  return { before, during, imageOverflow, ...(await collectMetrics(page)) };
}

export async function runMobileLongTranscriptControls(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareSession(page);
  await waitForMobileLayout(page);
  await sendPromptAndWaitIdle(page, "Please produce a tool-image-heavy transcript for mobile control latency measurement.");
  await page.waitForFunction(() => document.querySelectorAll(".message.tool").length >= 80, null, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.some((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15_000 });
  await sendPromptAndWaitIdle(page, `${"mobile-user-overflow-token-".repeat(14)}\n\nPlease produce a mobile overflow transcript with long unbroken markdown and code tokens.`);
  await page.locator(".message.assistant", { hasText: "Mobile overflow probe" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.assistant", { hasText: "fenced-code-token" }).waitFor({ timeout: 5_000 });
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
  const app = page.locator(".pi-web-agent");
  if (!await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"))) {
    await page.locator("#toggleSessionSidebarMobile").click().catch(async () => page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click()));
    await waitForSidebarCollapsed(page);
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
    await waitForSidebarCollapsed(page);
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
    await page.locator("#prompt").click();
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
  const transcriptOverflow = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const overflowing = Array.from(document.querySelectorAll<HTMLElement>(".message, .markdown-body, pre, code, .artifact-image, .message-action-menu"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { className: element.className, tagName: element.tagName, left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), text: element.textContent?.slice(0, 80) ?? "" };
      })
      .filter((rect) => rect.left < -2 || rect.right > viewportWidth + 2);
    return { documentWidth: document.documentElement.scrollWidth, viewportWidth, overflowing };
  });
  if (transcriptOverflow.documentWidth > transcriptOverflow.viewportWidth + 2 || transcriptOverflow.overflowing.length > 0) throw new Error(`Mobile transcript content overflowed viewport: ${JSON.stringify(transcriptOverflow)}`);
  await page.screenshot({ path: join(artifactDir, "mobile-long-transcript-controls.png"), fullPage: true });
  return {
    responsiveness,
    transcriptOverflow,
    maxLatencyMs,
    hamburgerPerf,
    toolRows: await page.locator(".message.tool").count(),
    toolGroups: await page.locator(".tool-run-group").count(),
    artifactImages: await page.locator(".artifact-image img").count(),
    ...(await collectMetrics(page)),
  };
}

