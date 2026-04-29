import { formatToolDuration, isDeveloperBashItem, isRenderableTranscriptItem, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { escapeHtml } from "./utils";

export function renderTranscriptItemShell(item: TranscriptItem, options: { toolActivityMemberId?: string | undefined } = {}): string {
  const member = options.toolActivityMemberId ? ` data-tool-activity-member="${escapeHtml(options.toolActivityMemberId)}"` : "";
  return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"${member}></pi-transcript-row>`;
}

function isToolActivityItem(item: TranscriptItem): boolean {
  return item.kind === "tool"
    && (item.status === "running" || item.status === "done" || item.status === "error")
    && item.title !== "Question"
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
  if (activeNowMs !== undefined && Number.isFinite(activeNowMs) && starts.length > 0) {
    return Math.max(0, activeNowMs - Math.min(...starts));
  }

  const durations = items
    .map((item) => item.durationMs)
    .filter((duration): duration is number => duration !== undefined && Number.isFinite(duration) && duration >= 0);
  if (durations.length > 0) return durations.reduce((total, duration) => total + duration, 0);

  if (starts.length > 0) {
    const firstStart = Math.min(...starts);
    const ends = items
      .map((item) => item.endedAt ? Date.parse(item.endedAt) : Number.NaN)
      .filter(Number.isFinite);
    if (ends.length > 0) return Math.max(0, Math.max(...ends) - firstStart);
  }
  return undefined;
}

function toolActivityRuns(transcript: readonly TranscriptItem[]): TranscriptItem[][] {
  const groups: TranscriptItem[][] = [];
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
    groups.push(group);
  }
  return groups;
}

function latestRunningToolRun(transcript: readonly TranscriptItem[]): TranscriptItem[] {
  let latest: TranscriptItem[] = [];
  for (const group of toolActivityRuns(transcript)) {
    if (hasRunningTool(group)) latest = group;
  }
  return latest;
}

function toolActivityRunFor(transcript: readonly TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  return toolActivityRuns(transcript).find((group) => group.some((candidate) => candidate.id === item.id)) ?? [];
}

export function latestGroupableToolGroupId(transcript: readonly TranscriptItem[]): string | undefined {
  const latest = latestRunningToolRun(transcript);
  return latest.length > 0 ? toolRunGroupId(latest) : undefined;
}

export function activeToolActivityMemberIdFor(transcript: readonly TranscriptItem[], item: TranscriptItem): string | undefined {
  const group = toolActivityRunFor(transcript, item);
  return group.length > 0 ? toolRunGroupId(group) : undefined;
}

export function primaryToolLabel(items: readonly TranscriptItem[]): string {
  const primary = [...items].reverse().find((item) => item.status === "running") ?? items[items.length - 1];
  return toolCallDisplayLabel(primary);
}

function toolCallDisplayLabel(item: TranscriptItem | undefined): string {
  if (!item) return "tool";
  return item.title.replace(/^\$\s*/, "bash ");
}

export type ToolActivityRenderModel = {
  id: string;
  itemIds: string[];
  title: string;
  meta: string;
  label: string;
  countLabel: string;
  durationLabel: string;
  currentLabel: string;
  receiptLabel: string;
  failedLabel: string;
  status: "running" | "done" | "error";
  defaultMode: "summary-only";
};

export function toolActivityRenderModel(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): ToolActivityRenderModel {
  const groupId = toolRunGroupId(items);
  const isRunning = hasRunningTool(items);
  const duration = formatToolDuration(groupDurationMs(items, isRunning && options.activeToolGroupId === groupId ? options.nowMs : undefined));
  const label = primaryToolLabel(items);
  const failedCount = items.filter((item) => item.status === "error").length;
  const countLabel = `${items.length} ${items.length === 1 ? "call" : "calls"}`;
  const status = isRunning ? "running" : failedCount > 0 ? "error" : "done";
  const failedLabel = failedCount > 0 ? `${failedCount} failed` : "";
  const meta = [duration, countLabel].filter(Boolean).join(" · ");
  const receiptLabel = [meta || countLabel, failedLabel, isRunning ? label : ""].filter(Boolean).join(" · ");
  return {
    id: groupId,
    itemIds: items.map((item) => item.id),
    title: label,
    meta,
    label,
    countLabel,
    durationLabel: duration,
    currentLabel: isRunning ? label : "",
    receiptLabel,
    failedLabel,
    status,
    defaultMode: "summary-only",
  };
}

export function toolRunSummaryText(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): { title: string; meta: string; label: string } {
  const model = toolActivityRenderModel(items, options);
  return { title: model.title, meta: model.meta, label: model.label };
}

export function renderToolActivity(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): string {
  const model = toolActivityRenderModel(items, options);
  const detailsLabel = `Tool details for ${model.itemIds.length} ${model.itemIds.length === 1 ? "tool" : "tools"}`;
  const gearIcon = `<svg class="tool-activity-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.9 1.5h2.2l.35 1.65c.42.14.82.31 1.18.52l1.42-.91 1.56 1.56-.91 1.42c.21.36.38.76.52 1.18l1.65.35v2.2l-1.65.35c-.14.42-.31.82-.52 1.18l.91 1.42-1.56 1.56-1.42-.91c-.36.21-.76.38-1.18.52l-.35 1.65H6.9l-.35-1.65a5.1 5.1 0 0 1-1.18-.52l-1.42.91-1.56-1.56.91-1.42a5.1 5.1 0 0 1-.52-1.18l-1.65-.35v-2.2l1.65-.35c.14-.42.31-.82.52-1.18l-.91-1.42 1.56-1.56 1.42.91c.36-.21.76-.38 1.18-.52L6.9 1.5Z" /><circle cx="8" cy="8.35" r="2.05" /></svg>`;
  return `<button type="button" class="tool-activity-card" aria-expanded="false" aria-label="Show ${escapeHtml(detailsLabel)}" data-tool-activity="${escapeHtml(model.id)}" data-tool-activity-ids="${escapeHtml(toolRunGroupItemIds(items))}" data-tool-activity-expanded="false" data-tool-activity-status="${escapeHtml(model.status)}" data-default-mode="${escapeHtml(model.defaultMode)}">
      ${gearIcon}
      <span class="tool-activity-receipt" title="${escapeHtml(model.receiptLabel)}">${escapeHtml(model.receiptLabel)}</span>
      <svg class="tool-activity-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
    </button>`;
}

function renderToolActivityRun(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): string {
  const groupId = toolRunGroupId(items);
  return `<div class="tool-activity-run" data-tool-activity-run="${escapeHtml(groupId)}" data-tool-activity-ids="${escapeHtml(toolRunGroupItemIds(items))}">
    ${renderToolActivity(items, options)}
    ${items.map((item) => renderTranscriptItemShell(item, { toolActivityMemberId: groupId })).join("")}
  </div>`;
}

export function renderTranscriptHtml(transcript: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): string {
  const parts: string[] = [];
  const activeToolGroupId = latestGroupableToolGroupId(transcript);
  for (let index = 0; index < transcript.length;) {
    const item = transcript[index]!;
    if (!isRenderableTranscriptItem(item)) {
      index++;
      continue;
    }
    if (isToolActivityItem(item)) {
      const group: TranscriptItem[] = [];
      while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isToolActivityItem(transcript[index]!)) {
        group.push(transcript[index]!);
        index++;
      }
      parts.push(renderToolActivityRun(group, { ...options, activeToolGroupId }));
      continue;
    }
    parts.push(renderTranscriptItemShell(item));
    index++;
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
