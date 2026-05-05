import type { Browser, Page } from "playwright";
import type { HarnessRuntime } from "../types";
import { collectMetrics, prepareSession } from "./helpers";
import { runImageArtifactDropUpload, runImageArtifactPaths, runImageAttachments, runArtifactPathFormats, runMissingRemoteImageArtifact, runRemoteImageArtifactPaths, runRemoteImageArtifactUpload, runRepeatedImageArtifactPaths } from "./artifacts";
import { runBackendRestart, runConnectionDisconnected, runControllerHandoffEdges, runReconnectController, runReconnectDraft } from "./lifecycle";
import { runMobileImageStreamStability, runMobileLayout, runMobileLongTranscriptControls } from "./mobile";
import { runInspectorPreview, runModelThinking, runNarrowToolStream, runQueuedFollowUp, runStreamingResponsiveness, runSubagentCard, runToolGrouping, runToolImageHeavyTranscript, runTranscriptScrollStability, runTranscriptTextSelection } from "./transcript";
import { runBashCommands, runConfiguredExtensionSmoke, runFileAutocomplete, runSlashCommands } from "./slash-commands";
import { runContextUsage, runEmptySessionLayout, runQuestionAnswer, runSessionMetadata, runSessionRouting, runSessionsPage, runTreeForkNavigation } from "./session";
import { runThemeGallery, runThemes } from "./visual";

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
  const thresholds = {
    longTaskCount: Number(process.env.PI_WEB_PERF_MAX_LONG_TASKS ?? 20),
    longTaskTotalMs: Number(process.env.PI_WEB_PERF_MAX_LONG_TASK_TOTAL_MS ?? 2_500),
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
  if (name === "empty-session-layout") return runEmptySessionLayout(page);
  if (name === "mobile-layout") return runMobileLayout(page);
  if (name === "session-routing") return runSessionRouting(page);
  if (name === "sessions-page") return runSessionsPage(page);
  if (name === "streaming-responsiveness") return runStreamingResponsiveness(page);
  if (name === "queued-follow-up") return runQueuedFollowUp(page);
  if (name === "transcript-scroll-stability") return runTranscriptScrollStability(page);
  if (name === "transcript-text-selection") return runTranscriptTextSelection(page);
  if (name === "session-metadata") return runSessionMetadata(page);
  if (name === "inspector-preview") return runInspectorPreview(page);
  if (name === "slash-commands") return runSlashCommands(page);
  if (name === "configured-extension-smoke") return runConfiguredExtensionSmoke(page);
  if (name === "bash-commands") return runBashCommands(page);
  if (name === "question-answer") return runQuestionAnswer(page);
  if (name === "tree-fork-navigation") return runTreeForkNavigation(page);
  if (name === "reconnect-controller") return runReconnectController(page);
  if (name === "controller-handoff-edges") return runControllerHandoffEdges(page, browser);
  if (name === "reconnect-draft") return runReconnectDraft(page);
  if (name === "backend-restart") return runBackendRestart(page, runtime);
  if (name === "connection-disconnected") return runConnectionDisconnected(page, runtime);
  if (name === "narrow-tool-stream") return runNarrowToolStream(page);
  if (name === "tool-grouping") return runToolGrouping(page);
  if (name === "tool-image-heavy-transcript") return runToolImageHeavyTranscript(page);
  if (name === "subagent-card") return runSubagentCard(page);
  if (name === "mobile-long-transcript-controls") return runMobileLongTranscriptControls(page);
  if (name === "mobile-image-stream-stability") return runMobileImageStreamStability(page);
  if (name === "file-autocomplete") return runFileAutocomplete(page);
  if (name === "image-attachments") return runImageAttachments(page);
  if (name === "image-artifact-drop-upload") return runImageArtifactDropUpload(page);
  if (name === "image-artifact-paths") return runImageArtifactPaths(page);
  if (name === "repeated-image-artifact-paths") return runRepeatedImageArtifactPaths(page);
  if (name === "artifact-path-formats") return runArtifactPathFormats(page);
  if (name === "remote-image-artifact-paths") return runRemoteImageArtifactPaths(page);
  if (name === "remote-image-artifact-upload") return runRemoteImageArtifactUpload(page);
  if (name === "missing-remote-image-artifact") return runMissingRemoteImageArtifact(page);
  if (name === "model-thinking") return runModelThinking(page);
  if (name === "context-usage") return runContextUsage(page);
  if (name === "themes") return runThemes(page);
  if (name === "theme-gallery") return runThemeGallery(page);
  throw new Error(`Unknown scenario: ${name}`);
}
