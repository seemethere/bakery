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

export const visualScenarios = [
  "themes",
  "theme-gallery",
] as const;

export async function runThemeGallery(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await sendPromptAndWaitIdle(page, "Please create a theme gallery baseline with a local image path, screenshot artifact path, and multiple tools for flat tool activity.");
  await page.locator(".artifact-image img").first().waitFor({ timeout: 5_000 });
  await page.locator(".message.tool").first().waitFor({ timeout: 5_000 });

  await page.locator("#prompt").fill("Please produce a long narrow running tool stream for the theme component gallery.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await page.locator(".message.tool.running").waitFor({ timeout: 10_000 });
  await page.locator("#prompt").fill("Queued follow-up visible in the theme gallery");
  await page.locator("#followUp").click();
  await page.locator(".running-queue").waitFor({ timeout: 5_000 });

  await setWorkbenchTheme(page, "workbench-dark");
  await page.screenshot({ path: join(artifactDir, "theme-gallery-dark.png"), fullPage: true });

  await setWorkbenchTheme(page, "workbench-light");
  await page.screenshot({ path: join(artifactDir, "theme-gallery-light.png"), fullPage: true });

  await waitForAgentIdle(page, 30_000);
  return { ...(await collectMetrics(page)) };
}

export async function ensureSidebarSettingsVisible(page: Page): Promise<void> {
  if (await page.locator('[data-route-path="/settings"]').isVisible().catch(() => false)) return;
  const app = page.locator(".pi-web-agent");
  const collapsed = await app.evaluate((element) => element.classList.contains("session-sidebar-collapsed"));
  if (collapsed) {
    const mobileMenu = page.locator("#toggleSessionSidebarMobile");
    if (await mobileMenu.isVisible().catch(() => false)) await mobileMenu.click();
    else await page.locator("#toggleSessionSidebar").click();
  }
  if (!await page.locator('[data-route-path="/settings"]').isVisible().catch(() => false)) {
    throw new Error("Settings route control did not become visible after opening the sidebar");
  }
  await page.locator('[data-route-path="/settings"]').waitFor({ state: "visible", timeout: 5_000 });
}

export async function setWorkbenchTheme(page: Page, theme: "workbench-dark" | "workbench-light"): Promise<void> {
  await page.locator(".pi-web-agent").waitFor({ timeout: 5_000 });
  await page.evaluate((nextTheme) => {
    localStorage.setItem("piWebThemePreference", nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme === "workbench-light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", nextTheme === "workbench-dark");
  }, theme);
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  if (await page.locator("#sessionSidebarBackdrop").isVisible().catch(() => false)) await page.locator("#sessionSidebarBackdrop").click();
}

export async function runThemes(page: Page): Promise<Record<string, unknown>> {
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


