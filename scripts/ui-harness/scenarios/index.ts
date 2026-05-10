import type { Browser, Page } from "playwright";
import type { HarnessRuntime } from "../types";
import { collectMetrics, prepareSession } from "./helpers";
import { isRegisteredScenarioName, scenarioRunners } from "./registry";

async function runManual(page: Page): Promise<Record<string, unknown>> {
  await prepareSession(page);
  console.log(`Manual harness ready at ${page.url()}`);
  console.log("Interact with the headed browser; press Ctrl+C in this terminal when finished.");
  await new Promise(() => undefined);
  return collectMetrics(page);
}

export function assertPerfThresholds(name: string, metrics: Record<string, unknown>): void {
  if (process.env.PI_WEB_PERF_THRESHOLDS === "off") return;
  const perf = metrics.piWebPerf as { render?: { maxMs?: number }; patch?: { maxMs?: number }; rowUpdate?: { maxMs?: number } } | null | undefined;
  const longTaskCount = Number(metrics.longTaskCount ?? 0);
  const longTaskTotalMs = Number(metrics.longTaskTotalMs ?? 0);
  const longTaskMaxMs = Number(metrics.longTaskMaxMs ?? 0);
  const renderMaxMs = Number(perf?.render?.maxMs ?? 0);
  const patchMaxMs = Number(perf?.patch?.maxMs ?? 0);
  const rowUpdateMaxMs = Number(perf?.rowUpdate?.maxMs ?? 0);
  const mobileImageHeavy = name === "mobile-image-stream-stability" || name === "mobile-long-transcript-controls";
  const thresholds = {
    longTaskCount: Number(process.env.PI_WEB_PERF_MAX_LONG_TASKS ?? (mobileImageHeavy ? 50 : 20)),
    longTaskTotalMs: Number(process.env.PI_WEB_PERF_MAX_LONG_TASK_TOTAL_MS ?? (mobileImageHeavy ? 4_000 : 2_500)),
    longTaskMaxMs: Number(process.env.PI_WEB_PERF_MAX_LONG_TASK_MS ?? 1_000),
    renderMaxMs: Number(process.env.PI_WEB_PERF_MAX_RENDER_MS ?? 1_500),
    patchMaxMs: Number(process.env.PI_WEB_PERF_MAX_PATCH_MS ?? 1_500),
    rowUpdateMaxMs: Number(process.env.PI_WEB_PERF_MAX_ROW_UPDATE_MS ?? 1_500),
  };
  const failures: string[] = [];
  if (longTaskCount > thresholds.longTaskCount) failures.push(`longTaskCount ${longTaskCount} > ${thresholds.longTaskCount}`);
  if (longTaskTotalMs > thresholds.longTaskTotalMs) failures.push(`longTaskTotalMs ${longTaskTotalMs} > ${thresholds.longTaskTotalMs}`);
  if (longTaskMaxMs > thresholds.longTaskMaxMs) failures.push(`longTaskMaxMs ${longTaskMaxMs} > ${thresholds.longTaskMaxMs}`);
  if (renderMaxMs > thresholds.renderMaxMs) failures.push(`render.maxMs ${renderMaxMs} > ${thresholds.renderMaxMs}`);
  if (patchMaxMs > thresholds.patchMaxMs) failures.push(`patch.maxMs ${patchMaxMs} > ${thresholds.patchMaxMs}`);
  if (rowUpdateMaxMs > thresholds.rowUpdateMaxMs) failures.push(`rowUpdate.maxMs ${rowUpdateMaxMs} > ${thresholds.rowUpdateMaxMs}`);
  if (failures.length > 0) throw new Error(`Performance thresholds exceeded in ${name}: ${failures.join("; ")}`);
}

export async function runScenario(name: string, page: Page, browser: Browser, runtime: HarnessRuntime): Promise<Record<string, unknown>> {
  if (name === "manual") return runManual(page);
  if (isRegisteredScenarioName(name)) return scenarioRunners[name](page, browser, runtime);
  throw new Error(`Unknown scenario: ${name}`);
}
