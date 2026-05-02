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
import { ensureSidebarSettingsVisible } from "./visual";

export const slashCommandScenarios = [
  "slash-commands",
  "configured-extension-smoke",
  "bash-commands",
  "file-autocomplete",
] as const;

export async function runSlashCommands(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete").waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/session" }).waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/new" }).waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/session");
  await page.locator("#send").click();
  await page.locator(".message.system", { hasText: "Fake session" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/plan choosing the next UX slice");
  await page.locator("#send").click();
  await page.locator(".message.user", { hasText: "Launched /plan workflow." }).waitFor({ timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Focus: choosing the next UX slice" }).waitFor({ timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Question discipline:" }).waitFor({ state: "detached", timeout: 5_000 });
  await page.locator(".question-card", { hasText: "What are you working on today?" }).waitFor({ timeout: 5_000 });
  await page.locator(".question-options button").first().click();
  await waitForAgentIdle(page, 5_000);
  const planMessage = page.locator(".message.assistant", { hasText: "Recommendation: start with the smallest vertical slice" }).last();
  await planMessage.waitFor({ timeout: 5_000 });
  await planMessage.locator(".plan-action-row").waitFor({ state: "detached", timeout: 5_000 });
  const planCard = planMessage.locator(".plan-card", { hasText: "Plan ready" });
  await planCard.waitFor({ timeout: 5_000 });
  await planCard.locator(".plan-card-open-hint", { hasText: "Full plan" }).waitFor({ timeout: 5_000 });
  await planCard.locator('[data-plan-action="accept"]').waitFor({ timeout: 5_000 });
  await page.locator(".plan-composer-takeover").waitFor({ state: "detached", timeout: 5_000 });
  await page.locator("#prompt").waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#prompt")?.value ?? "") === "", null, { timeout: 5_000 });
  await planCard.click();
  await page.locator(".plan-details-dialog", { hasText: "Full plan" }).waitFor({ timeout: 5_000 });
  await page.locator(".plan-details-dialog", { hasText: "Start with the smallest slice" }).waitFor({ timeout: 5_000 });
  await page.locator(".plan-details-dialog [data-close-plan-details]").first().click();
  await page.locator(".plan-details-dialog").waitFor({ state: "detached", timeout: 5_000 });
  await planCard.locator('[data-plan-action="accept"]').click();
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#prompt")?.value ?? "") === "Proceed with the recommended plan.", null, { timeout: 5_000 });
  await page.locator(".message.user", { hasText: "Proceed with the recommended plan" }).waitFor({ state: "detached", timeout: 1_500 }).catch(() => undefined);
  await page.locator("#prompt").fill("");
  await waitForAgentIdle(page, 10_000);
  await ensureSidebarSettingsVisible(page);
  await page.locator('[data-route-path="/sessions"]').click();
  await page.locator(".sessions-page .session-card.active .session-snippet", { hasText: "Launched /plan workflow" }).waitFor({ timeout: 5_000 });
  const currentSessionId = await page.locator(".sessions-page .session-card.active").getAttribute("data-session-id");
  if (!currentSessionId) throw new Error("Expected active session card on sessions page");
  await page.locator(`header [data-route-path="/sessions/${currentSessionId}"]`).click();
  await page.waitForURL(`**/sessions/${currentSessionId}`, { timeout: 5_000 });
  await page.locator("#prompt").waitFor({ timeout: 5_000 });
  await waitForAgentIdle(page, 10_000);
  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete", { hasText: "/tree" }).waitFor({ state: "detached", timeout: 1_500 });
  await page.locator("#prompt").fill("");
  await page.locator(".tree-drawer").waitFor({ state: "detached", timeout: 5_000 });
  const beforeNewSessions = await page.locator("pi-web-agent").evaluate((element) => ((element as unknown as { sessions?: unknown[] }).sessions ?? []).length);
  await page.locator("#prompt").fill("/new with args");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("Usage: /new"), null, { timeout: 5_000 });
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length === count, beforeNewSessions);
  await page.locator("#prompt").fill("/new");
  await page.locator("#send").click();
  await page.waitForFunction((count) => ((document.querySelector("pi-web-agent") as unknown as { sessions?: unknown[] } | null)?.sessions ?? []).length > count, beforeNewSessions, { timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);
  await page.waitForFunction(() => document.activeElement?.id === "prompt", null, { timeout: 5_000 });
  await page.locator(".tree-drawer").waitFor({ state: "detached", timeout: 5_000 });
  return collectMetrics(page);
}

export async function runConfiguredExtensionSmoke(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  const catalog = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/api/extensions`);
    if (!response.ok) throw new Error(`catalog failed: ${response.status}`);
    return await response.json() as { webModules: Array<{ extensionId: string; entryUrl: string }>; cards: Array<{ kind: string; component: string }>; issues: Array<{ path: string; message: string }> };
  }, apiBase);
  if (!catalog.webModules.some((module) => module.extensionId === "local.demo")) throw new Error(`Expected local.demo web module in catalog: ${JSON.stringify(catalog)}`);
  if (!catalog.cards.some((card) => card.kind === "local.demo.card" && card.component === "local-demo-card")) throw new Error(`Expected local.demo card in catalog: ${JSON.stringify(catalog)}`);
  if (!catalog.issues.some((issue) => issue.message.includes("extension path does not exist"))) throw new Error(`Expected configured missing extension issue: ${JSON.stringify(catalog.issues)}`);

  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete", { hasText: "/local-demo" }).waitFor({ timeout: 5_000 });
  await page.locator(".command-autocomplete", { hasText: "/plan" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/local-demo harness says hello");
  await page.locator("#send").click();
  await page.locator("local-demo-card", { hasText: "Local extension card" }).waitFor({ timeout: 5_000 });
  await page.locator("local-demo-card", { hasText: "harness says hello" }).waitFor({ timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);

  await page.locator("#prompt").fill("/reload");
  await page.locator("#prompt").press("Enter");
  await page.locator(".message", { hasText: "Bakery extensions loaded" }).waitFor({ timeout: 5_000 });
  await page.locator(".message", { hasText: "Extension issues" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").fill("/");
  await page.locator(".command-autocomplete", { hasText: "/local-demo" }).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}

export async function runBashCommands(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("!echo bakery bash");
  await page.locator("#send").click();
  const bashRow = page.locator(".message.tool.developer-bash:not(.collapsed)", { hasText: "$ echo bakery bash" }).last();
  await bashRow.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("pi-transcript-row.developer-bash:not(.collapsed)")).some((row) => (row.shadowRoot?.textContent ?? row.textContent ?? "").includes("bakery bash")), null, { timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value === "", null, { timeout: 5_000 });

  await page.locator("#prompt").fill("!!echo bakery hidden");
  await page.locator("#send").click();
  const hiddenRow = page.locator(".message.tool.developer-bash:not(.collapsed)", { hasText: "$ echo bakery hidden (no context)" }).last();
  await hiddenRow.waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("pi-transcript-row.developer-bash:not(.collapsed)")).some((row) => (row.shadowRoot?.textContent ?? row.textContent ?? "").includes("bakery hidden")), null, { timeout: 5_000 });
  await waitForAgentIdle(page, 5_000);

  await page.locator("#prompt").fill("Please produce a long streaming performance response while bash is blocked.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);
  await page.locator("#prompt").fill("!echo blocked while running");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector(".notice")?.textContent?.includes("Bash commands are available when the session is idle"), null, { timeout: 5_000 });
  await page.locator(".message.tool", { hasText: "blocked while running" }).waitFor({ state: "detached", timeout: 1_000 });
  await waitForAgentIdle(page, 30_000);
  return collectMetrics(page);
}


export async function runFileAutocomplete(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await page.locator("#prompt").fill("Please inspect @Button");
  await page.locator(".file-autocomplete", { hasText: "src/components/Button.ts" }).waitFor({ timeout: 5_000 });
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes("@src/components/Button.ts "));

  await page.locator("#prompt").fill("Open @src/");
  await page.locator(".file-autocomplete", { hasText: "components/" }).waitFor({ timeout: 5_000 });
  await page.getByRole("option", { name: /src\/components\/$/ }).click();
  await page.waitForFunction(() => (document.querySelector("#prompt") as HTMLTextAreaElement | null)?.value.includes("@src/components/"));
  await page.locator(".file-autocomplete", { hasText: "Button.ts" }).waitFor({ timeout: 5_000 });
  return collectMetrics(page);
}


