import type { Page } from "playwright";
import { join } from "node:path";
import { artifactDir } from "../config";
import { collectMetrics, delay, prepareSession, sendPromptAndWaitIdle, timed, waitForAgentIdle, waitForAgentRunning, waitForPromptEnabled, waitForSelectedSession } from "./helpers";

const MIN_LONG_TRANSCRIPT_ROWS = 90;
const LARGE_TRANSCRIPT_SOURCE_ROWS = 256;
const LARGE_TRANSCRIPT_MIN_REOPENED_ROWS = 500;
const LOOSE_LONG_TASK_MAX_MS = 2_500;
const LOOSE_LONG_TASK_TOTAL_MS = 8_000;
const LOOSE_READY_MS = 8_000;

type LongTranscriptBuildOptions = {
  includeOverflowTurn?: boolean;
  sourceRows?: number;
  minRows?: number;
  minToolRows?: number;
};

type BaselineMetrics = Record<string, unknown> & {
  longTaskCount?: number;
  longTaskTotalMs?: number;
  longTaskMaxMs?: number;
  piWebPerf?: { transcript?: { lastSnapshotToUsableMs?: number } } | null;
};

type GuardrailOptions = {
  readyMs?: number;
  maxLatencyMs?: number;
  requireTranscriptMetrics?: boolean;
  longTaskMaxMs?: number;
  longTaskTotalMs?: number;
  readyThresholdMs?: number;
};

export async function resetLongTranscriptPerf(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__piWebLongTasks = [];
    window.__piWebPerf = {
      renderCount: 0,
      renderMs: [],
      patchCount: 0,
      patchMs: [],
      rowUpdateCount: 0,
      rowUpdateMs: [],
      eventCounts: {},
      reasonCounts: {},
      recentEvents: [],
      transcript: { samples: {} },
    };
  });
}

export async function buildLongTranscript(page: Page, options: LongTranscriptBuildOptions = {}): Promise<{ rows: number; toolRows: number; artifactImages: number }> {
  const sourceRows = options.sourceRows ?? 96;
  const minRows = options.minRows ?? MIN_LONG_TRANSCRIPT_ROWS;
  const minToolRows = options.minToolRows ?? 80;
  await sendPromptAndWaitIdle(page, `Please produce a tool-image-heavy transcript with ${sourceRows} rows for long transcript performance baseline measurement.`);
  await page.waitForFunction((minimumRows) => document.querySelectorAll("[data-transcript-id]").length >= minimumRows, minRows, { timeout: 30_000 });
  await page.waitForFunction((minimumToolRows) => document.querySelectorAll(".message.tool").length >= minimumToolRows, minToolRows, { timeout: 20_000 });
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>(".artifact-image img"));
    return images.some((image) => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15_000 });

  if (options.includeOverflowTurn) {
    await sendPromptAndWaitIdle(page, `${"long-transcript-overflow-token-".repeat(10)}\n\nPlease produce a mobile overflow transcript with long unbroken markdown and code tokens.`);
    await page.locator(".message.assistant", { hasText: "Mobile overflow probe" }).waitFor({ timeout: 5_000 });
  }

  return longTranscriptDomState(page);
}

async function longTranscriptDomState(page: Page): Promise<{ rows: number; toolRows: number; artifactImages: number; bottomGap: number; promptEnabled: boolean }> {
  return await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
    const bottomGap = transcript ? Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) : -1;
    return {
      rows: document.querySelectorAll("[data-transcript-id]").length,
      toolRows: document.querySelectorAll(".message.tool").length,
      artifactImages: document.querySelectorAll(".artifact-image img").length,
      bottomGap,
      promptEnabled: Boolean(prompt && !prompt.disabled),
    };
  });
}

function assertLoosePerfGuardrails(label: string, metrics: BaselineMetrics, extra: GuardrailOptions = {}): void {
  const failures: string[] = [];
  const longTaskMaxMs = Number(metrics.longTaskMaxMs ?? 0);
  const longTaskTotalMs = Number(metrics.longTaskTotalMs ?? 0);
  const snapshotToUsableMs = metrics.piWebPerf?.transcript?.lastSnapshotToUsableMs;
  const longTaskMaxThreshold = extra.longTaskMaxMs ?? LOOSE_LONG_TASK_MAX_MS;
  const longTaskTotalThreshold = extra.longTaskTotalMs ?? LOOSE_LONG_TASK_TOTAL_MS;
  const readyThreshold = extra.readyThresholdMs ?? LOOSE_READY_MS;
  if (longTaskMaxMs > longTaskMaxThreshold) failures.push(`longTaskMaxMs ${longTaskMaxMs} > ${longTaskMaxThreshold}`);
  if (longTaskTotalMs > longTaskTotalThreshold) failures.push(`longTaskTotalMs ${longTaskTotalMs} > ${longTaskTotalThreshold}`);
  if (extra?.requireTranscriptMetrics && !metrics.piWebPerf?.transcript) failures.push("missing piWebPerf.transcript metrics");
  if (snapshotToUsableMs !== undefined && snapshotToUsableMs > readyThreshold) failures.push(`snapshotToUsableMs ${snapshotToUsableMs} > ${readyThreshold}`);
  if ((extra.readyMs ?? 0) > readyThreshold) failures.push(`readyMs ${extra.readyMs} > ${readyThreshold}`);
  if ((extra?.maxLatencyMs ?? 0) > 1_500) failures.push(`maxLatencyMs ${extra?.maxLatencyMs} > 1500`);
  if (failures.length > 0) throw new Error(`${label} exceeded loose long-transcript guardrails: ${failures.join(", ")}; metrics=${JSON.stringify(metrics)}`);
}

export async function runLongTranscriptReopen(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const before = await buildLongTranscript(page);
  await page.screenshot({ path: join(artifactDir, "long-transcript-reopen-before.png"), fullPage: true });

  const reloadStart = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, sessionId);
  await waitForPromptEnabled(page, 10_000);
  await page.waitForFunction((minimumRows) => document.querySelectorAll("[data-transcript-id]").length >= minimumRows, MIN_LONG_TRANSCRIPT_ROWS, { timeout: 15_000 });
  await page.waitForFunction(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    return !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
  }, null, { timeout: 8_000 });
  const readyMs = Date.now() - reloadStart;
  const after = await longTranscriptDomState(page);
  if (!after.promptEnabled || after.rows < MIN_LONG_TRANSCRIPT_ROWS || after.toolRows < 80 || after.bottomGap > 120) {
    throw new Error(`Long transcript reopen did not restore a usable bottom-pinned transcript: ${JSON.stringify({ before, after, readyMs })}`);
  }
  await page.screenshot({ path: join(artifactDir, "long-transcript-reopen-after.png"), fullPage: true });
  const metrics = await collectMetrics(page) as BaselineMetrics;
  assertLoosePerfGuardrails("long-transcript-reopen", metrics, { readyMs, requireTranscriptMetrics: true });
  return { before, after, readyMs, ...metrics };
}

export async function runLongTranscriptLargeReopen(page: Page): Promise<Record<string, unknown>> {
  const sessionId = await prepareSession(page);
  const before = await buildLongTranscript(page, {
    sourceRows: LARGE_TRANSCRIPT_SOURCE_ROWS,
    minRows: LARGE_TRANSCRIPT_SOURCE_ROWS,
    minToolRows: LARGE_TRANSCRIPT_SOURCE_ROWS,
  });
  await page.screenshot({ path: join(artifactDir, "long-transcript-large-reopen-before.png"), fullPage: true });

  const reloadStart = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForSelectedSession(page, sessionId);
  await waitForPromptEnabled(page, 20_000);
  await page.waitForFunction((minimumRows) => document.querySelectorAll("[data-transcript-id]").length >= minimumRows, LARGE_TRANSCRIPT_MIN_REOPENED_ROWS, { timeout: 30_000 });
  const readyMs = Date.now() - reloadStart;
  const after = await longTranscriptDomState(page);
  if (!after.promptEnabled || after.rows < LARGE_TRANSCRIPT_MIN_REOPENED_ROWS || after.toolRows < LARGE_TRANSCRIPT_SOURCE_ROWS) {
    throw new Error(`Large long transcript reopen did not restore a usable transcript: ${JSON.stringify({ before, after, readyMs })}`);
  }
  await page.screenshot({ path: join(artifactDir, "long-transcript-large-reopen-after.png"), fullPage: true });
  const metrics = await collectMetrics(page) as BaselineMetrics;
  assertLoosePerfGuardrails("long-transcript-large-reopen", metrics, {
    readyMs,
    requireTranscriptMetrics: true,
    longTaskMaxMs: 5_000,
    longTaskTotalMs: 30_000,
    readyThresholdMs: 20_000,
  });
  return { before, after, readyMs, ...metrics };
}

export async function runLongTranscriptStreaming(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  await resetLongTranscriptPerf(page);
  await page.locator("#prompt").fill("Please produce a very long streaming performance response with many paragraphs, markdown, code, and enough text to stress live transcript rendering while still streaming.");
  await page.locator("#send").click();
  await waitForAgentRunning(page);

  const responsiveness: Array<{ label: string; ms: number }> = [];
  for (let index = 0; index < 14; index++) {
    responsiveness.push(await timed(`stream-fill-prompt-${index}`, () => page.locator("#prompt").fill(`long transcript live steer probe ${index}`)));
    if (index % 4 === 0 && await page.locator("#modelThinkingToggle").isVisible().catch(() => false)) {
      responsiveness.push(await timed(`stream-toggle-model-${index}`, async () => {
        await page.locator("#modelThinkingToggle").click();
        await page.locator("#prompt").click();
      }));
    }
    await delay(60);
  }

  await waitForAgentIdle(page, 35_000);
  await waitForPromptEnabled(page, 5_000);
  const maxLatencyMs = Math.max(...responsiveness.map((sample) => sample.ms));
  const after = await longTranscriptDomState(page);
  if (!after.promptEnabled || after.rows < 2) throw new Error(`Long transcript streaming did not return to usable prompt state: ${JSON.stringify(after)}`);
  await page.screenshot({ path: join(artifactDir, "long-transcript-streaming.png"), fullPage: true });
  const metrics = await collectMetrics(page) as BaselineMetrics;
  assertLoosePerfGuardrails("long-transcript-streaming", metrics, { maxLatencyMs, requireTranscriptMetrics: true });
  return { responsiveness, maxLatencyMs, after, ...metrics };
}

export async function runMobileLongTranscriptPerformance(page: Page): Promise<Record<string, unknown>> {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareSession(page);
  await page.waitForFunction(() => window.matchMedia("(max-width: 767px)").matches, null, { timeout: 5_000 });
  const built = await buildLongTranscript(page, { includeOverflowTurn: true });
  const buildMetrics = await collectMetrics(page) as BaselineMetrics;
  assertLoosePerfGuardrails("mobile-long-transcript-performance-build", buildMetrics, { requireTranscriptMetrics: true });
  await resetLongTranscriptPerf(page);

  const responsiveness: Array<{ label: string; ms: number }> = [];
  responsiveness.push(await timed("mobile-fill-prompt-after-long-transcript", () => page.locator("#prompt").fill("typing after mobile long transcript baseline")));
  responsiveness.push(await timed("mobile-open-session-drawer-after-long-transcript", async () => {
    await page.locator("#toggleSessionSidebarMobile").click();
    await page.locator(".session-sidebar:not(.collapsed) #newSession").waitFor({ timeout: 5_000 });
  }));
  responsiveness.push(await timed("mobile-close-session-drawer-after-long-transcript", async () => {
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.click());
    await page.waitForFunction(() => document.querySelector(".pi-web-agent")?.classList.contains("session-sidebar-collapsed"), null, { timeout: 5_000 });
  }));
  await page.evaluate(() => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (transcript) transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - 900);
  });
  await page.locator("#jumpToLatest").waitFor({ timeout: 5_000 });
  responsiveness.push(await timed("mobile-jump-to-latest-after-long-transcript", async () => {
    await page.locator("#jumpToLatest").click();
    await page.waitForFunction(() => {
      const transcript = document.querySelector<HTMLElement>(".transcript");
      return !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
    }, null, { timeout: 5_000 });
  }));

  const maxLatencyMs = Math.max(...responsiveness.map((sample) => sample.ms));
  const overflow = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  if (overflow.documentWidth > overflow.viewportWidth + 2) throw new Error(`Mobile long transcript created horizontal overflow: ${JSON.stringify(overflow)}`);
  const after = await longTranscriptDomState(page);
  if (!after.promptEnabled || after.rows < MIN_LONG_TRANSCRIPT_ROWS || after.bottomGap > 120) throw new Error(`Mobile long transcript controls did not remain usable: ${JSON.stringify({ built, after, overflow })}`);
  await page.screenshot({ path: join(artifactDir, "mobile-long-transcript-performance.png"), fullPage: true });
  const metrics = await collectMetrics(page) as BaselineMetrics;
  assertLoosePerfGuardrails("mobile-long-transcript-performance", metrics, { maxLatencyMs });
  return { built, after, overflow, responsiveness, maxLatencyMs, buildMetrics, ...metrics };
}
