import { isDeveloperBashItem, isRenderableTranscriptItem, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { escapeHtml } from "./utils";

export function renderTranscriptItemShell(item: TranscriptItem): string {
  return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
}

export type TranscriptRenderOptions = Record<string, never>;

export function renderTranscriptHtml(transcript: readonly TranscriptItem[], _options: TranscriptRenderOptions = {}): string {
  return transcript
    .filter(isRenderableTranscriptItem)
    .map((item) => renderTranscriptItemShell(item))
    .join("");
}

export function transcriptElementOrderIndex(transcript: readonly TranscriptItem[], element: Element): number {
  const rowId = (element as HTMLElement).dataset.transcriptId;
  if (!rowId) return Number.POSITIVE_INFINITY;
  const index = transcript.findIndex((item) => item.id === rowId);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

export function toolGroupPositionFor(_transcript: readonly TranscriptItem[], _item: TranscriptItem): ToolGroupPosition {
  return "single";
}

export function isAfterRunningTool(_transcript: readonly TranscriptItem[], _item: TranscriptItem): boolean {
  return false;
}

export function defaultTranscriptExpanded(item: TranscriptItem): boolean {
  return item.kind === "system" || isDeveloperBashItem(item) || (item.kind !== "tool" && item.status === "error");
}
