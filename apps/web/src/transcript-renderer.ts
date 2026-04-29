import { formatToolDuration, isDeveloperBashItem, isRenderableTranscriptItem, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { escapeHtml } from "./utils";

export function renderTranscriptItemShell(item: TranscriptItem): string {
  return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
}

function isToolActivityItem(item: TranscriptItem): boolean {
  return item.kind === "tool"
    && (item.status === "running" || item.status === "done" || item.status === "error")
    && !isDeveloperBashItem(item);
}

function hasRunningTool(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.status === "running");
}

export type TranscriptRenderOptions = {
  activeToolGroupId?: string | undefined;
  nowMs?: number | undefined;
};

export function toolRunGroupId(items: readonly TranscriptItem[]): string {
  return `activity:${items[0]?.id ?? "tool"}`;
}

function toolRunGroupItemIds(items: readonly TranscriptItem[]): string {
  return items.map((item) => item.id).join("|");
}

function groupDurationMs(items: readonly TranscriptItem[], activeNowMs?: number): number | undefined {
  const starts = items
    .map((item) => item.startedAt ? Date.parse(item.startedAt) : Number.NaN)
    .filter(Number.isFinite);
  if (starts.length === 0) return undefined;
  const firstStart = Math.min(...starts);
  if (activeNowMs !== undefined && Number.isFinite(activeNowMs)) return Math.max(0, activeNowMs - firstStart);
  const ends = items
    .map((item) => item.endedAt ? Date.parse(item.endedAt) : Number.NaN)
    .filter(Number.isFinite);
  if (ends.length > 0) return Math.max(0, Math.max(...ends) - firstStart);
  return undefined;
}

function latestRunningToolRun(transcript: readonly TranscriptItem[]): TranscriptItem[] {
  let latest: TranscriptItem[] = [];
  for (let index = 0; index < transcript.length;) {
    if (!isRenderableTranscriptItem(transcript[index]!) || !isToolActivityItem(transcript[index]!)) {
      index++;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isToolActivityItem(transcript[index]!)) {
      group.push(transcript[index]!);
      index++;
    }
    if (hasRunningTool(group)) latest = group;
  }
  return latest;
}

export function latestGroupableToolGroupId(transcript: readonly TranscriptItem[]): string | undefined {
  const latest = latestRunningToolRun(transcript);
  return latest.length > 0 ? toolRunGroupId(latest) : undefined;
}

export function primaryToolLabel(items: readonly TranscriptItem[]): string {
  const primary = [...items].reverse().find((item) => item.status === "running") ?? items[items.length - 1];
  return primary?.title.replace(/^\$\s*/, "") ?? "tool";
}

export function toolRunSummaryText(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): { title: string; meta: string; label: string } {
  const groupId = toolRunGroupId(items);
  const duration = formatToolDuration(groupDurationMs(items, options.activeToolGroupId === groupId ? options.nowMs : undefined));
  const label = primaryToolLabel(items);
  const failedCount = items.filter((item) => item.status === "error").length;
  const meta = [
    `${items.length} ${items.length === 1 ? "tool" : "tools"}`,
    duration,
    failedCount > 0 ? `${failedCount} failed` : "",
  ].filter(Boolean).join(" · ");
  return {
    title: `Running ${label}`,
    meta,
    label,
  };
}

export function renderToolActivity(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): string {
  const groupId = toolRunGroupId(items);
  const summary = toolRunSummaryText(items, options);
  return `<div class="tool-activity-strip" role="status" data-tool-activity="${escapeHtml(groupId)}" data-tool-activity-ids="${escapeHtml(toolRunGroupItemIds(items))}">
      <strong>${escapeHtml(summary.title)}</strong>
      ${summary.meta ? `<em>${escapeHtml(summary.meta)}</em>` : ""}
    </div>`;
}

export function renderTranscriptHtml(transcript: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): string {
  const parts: string[] = [];
  const activeToolGroupId = latestGroupableToolGroupId(transcript);
  const activeToolItems = latestRunningToolRun(transcript);
  const firstActiveToolId = activeToolItems[0]?.id;
  for (const item of transcript) {
    if (!isRenderableTranscriptItem(item)) continue;
    if (activeToolGroupId && item.id === firstActiveToolId) parts.push(renderToolActivity(activeToolItems, { ...options, activeToolGroupId }));
    parts.push(renderTranscriptItemShell(item));
  }
  return parts.join("");
}

export function transcriptElementOrderIndex(transcript: readonly TranscriptItem[], element: Element): number {
  const rowId = (element as HTMLElement).dataset.transcriptId;
  if (rowId) return transcript.findIndex((item) => item.id === rowId);
  const groupIds = ((element as HTMLElement).dataset.toolActivityIds ?? (element as HTMLElement).dataset.toolActivity)?.split("|") ?? [];
  const indexes = groupIds.map((id) => transcript.findIndex((item) => item.id === id)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : Number.POSITIVE_INFINITY;
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
