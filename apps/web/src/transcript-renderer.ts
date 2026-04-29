import { formatToolDuration, isDeveloperBashItem, isRenderableTranscriptItem, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { escapeHtml } from "./utils";

export function renderTranscriptItemShell(item: TranscriptItem): string {
  return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
}

export function isGroupableToolItem(item: TranscriptItem): boolean {
  return item.kind === "tool"
    && item.status === "done"
    && !isDeveloperBashItem(item);
}

function isLiveToolStackItem(item: TranscriptItem): boolean {
  return item.kind === "tool"
    && (item.status === "running" || item.status === "done" || item.status === "error")
    && !isDeveloperBashItem(item);
}

function shouldRenderLiveToolStack(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.status === "running");
}

function visibleLiveToolItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.slice(-5);
}

export type TranscriptRenderOptions = {
  activeToolGroupId?: string | undefined;
  nowMs?: number | undefined;
  compactLiveToolGroups?: boolean | undefined;
};

function toolGroupId(items: readonly TranscriptItem[]): string {
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

export function latestGroupableToolGroupId(transcript: readonly TranscriptItem[]): string | undefined {
  let latest: TranscriptItem[] = [];
  for (let index = 0; index < transcript.length;) {
    if (!isRenderableTranscriptItem(transcript[index]!) || !isLiveToolStackItem(transcript[index]!)) {
      index++;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isLiveToolStackItem(transcript[index]!)) {
      group.push(transcript[index]!);
      index++;
    }
    if (group.length >= 2) latest = group;
  }
  return latest.length >= 2 ? toolGroupId(latest) : undefined;
}

export function primaryToolLabel(items: readonly TranscriptItem[], liveStack = shouldRenderLiveToolStack(items)): string {
  const primary = liveStack ? [...items].reverse().find((item) => item.status === "running") ?? items[items.length - 1] : items[items.length - 1];
  return primary?.title.replace(/^\$\s*/, "") ?? "tool";
}

export function toolRunSummaryText(items: readonly TranscriptItem[], options: TranscriptRenderOptions = {}): { title: string; meta: string; label: string } {
  const groupId = toolGroupId(items);
  const liveStack = shouldRenderLiveToolStack(items);
  const hiddenCount = liveStack ? Math.max(0, items.length - visibleLiveToolItems(items).length) : 0;
  const duration = formatToolDuration(groupDurationMs(items, options.activeToolGroupId === groupId ? options.nowMs : undefined));
  const label = primaryToolLabel(items, liveStack);
  const meta = [
    liveStack ? `${items.length} ${items.length === 1 ? "tool" : "tools"}` : duration,
    liveStack ? duration : "",
    liveStack && hiddenCount > 0 ? `${hiddenCount} earlier` : "",
  ].filter(Boolean).join(" · ");
  return {
    title: liveStack ? `Running ${label}` : `Ran ${items.length} ${items.length === 1 ? "tool" : "tools"}`,
    meta,
    label,
  };
}

export function renderToolRunGroup(items: TranscriptItem[], expandedToolGroupIds: ReadonlySet<string>, options: TranscriptRenderOptions = {}): string {
  const groupId = toolGroupId(items);
  const liveStack = shouldRenderLiveToolStack(items);
  const expanded = liveStack ? (!options.compactLiveToolGroups || expandedToolGroupIds.has(groupId)) : expandedToolGroupIds.has(groupId);
  const visibleItems = liveStack ? visibleLiveToolItems(items) : items;
  const summary = toolRunSummaryText(items, options);
  const label = liveStack ? "" : summary.label;
  const liveAttr = liveStack ? ' data-live-tool-stack="true"' : "";
  return `<details class="tool-run-group${liveStack ? " live-tool-stack" : ""}" data-tool-run-group="${escapeHtml(groupId)}"${liveAttr} ${expanded ? "open" : ""}>
      <summary>
        <strong>${escapeHtml(summary.title)}</strong>
        ${summary.meta ? `<em>${escapeHtml(summary.meta)}</em>` : ""}
        ${label ? `<span title="${escapeHtml(label)}">${escapeHtml(label)}</span>` : ""}
      </summary>
      <div class="tool-run-items">
        ${visibleItems.map((item, visibleIndex) => `<div class="tool-run-stack-slot tool-run-stack-slot-${visibleIndex + 1} ${item.status === "error" ? "failed" : item.status === "running" ? "running" : "done"}">${renderTranscriptItemShell(item)}</div>`).join("")}
      </div>
    </details>`;
}

export function renderTranscriptHtml(transcript: readonly TranscriptItem[], expandedToolGroupIds: ReadonlySet<string>, options: TranscriptRenderOptions = {}): string {
  const parts: string[] = [];
  for (let index = 0; index < transcript.length;) {
    const item = transcript[index]!;
    if (!isRenderableTranscriptItem(item)) {
      index++;
      continue;
    }
    if (!isLiveToolStackItem(item)) {
      parts.push(renderTranscriptItemShell(item));
      index++;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isLiveToolStackItem(transcript[index]!)) {
      group.push(transcript[index]!);
      index++;
    }
    if (group.length >= 2) parts.push(renderToolRunGroup(group, expandedToolGroupIds, options));
    else parts.push(renderTranscriptItemShell(group[0]!));
  }
  return parts.join("");
}

export function transcriptElementOrderIndex(transcript: readonly TranscriptItem[], element: Element): number {
  const rowId = (element as HTMLElement).dataset.transcriptId;
  if (rowId) return transcript.findIndex((item) => item.id === rowId);
  const groupIds = (element as HTMLElement).dataset.toolRunGroup?.split("|") ?? [];
  const indexes = groupIds.map((id) => transcript.findIndex((item) => item.id === id)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : Number.POSITIVE_INFINITY;
}

export function toolGroupPositionFor(transcript: readonly TranscriptItem[], item: TranscriptItem): ToolGroupPosition {
  const index = transcript.findIndex((candidate) => candidate.id === item.id);
  if (index === -1 || !isGroupableToolItem(item)) return "single";
  const previousGrouped = index > 0 && isLiveToolStackItem(transcript[index - 1]!);
  const nextGrouped = index < transcript.length - 1 && isLiveToolStackItem(transcript[index + 1]!);
  if (previousGrouped && nextGrouped) return "middle";
  if (nextGrouped) return "start";
  if (previousGrouped) return "end";
  return "single";
}

export function isAfterRunningTool(transcript: readonly TranscriptItem[], item: TranscriptItem): boolean {
  const index = transcript.findIndex((candidate) => candidate.id === item.id);
  if (index <= 0 || item.kind !== "tool" || item.status !== "done") return false;
  const previous = transcript[index - 1];
  return previous?.kind === "tool" && previous.status === "running";
}

export function defaultTranscriptExpanded(item: TranscriptItem): boolean {
  return item.kind === "system" || isDeveloperBashItem(item) || (item.kind !== "tool" && item.status === "error");
}
