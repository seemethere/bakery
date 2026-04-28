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

export type TranscriptRenderOptions = {
  activeToolGroupId?: string | undefined;
  nowMs?: number | undefined;
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
    if (!isRenderableTranscriptItem(transcript[index]!) || !isGroupableToolItem(transcript[index]!)) {
      index++;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isGroupableToolItem(transcript[index]!)) {
      group.push(transcript[index]!);
      index++;
    }
    if (group.length >= 2) latest = group;
  }
  return latest.length >= 2 ? toolGroupId(latest) : undefined;
}

export function renderToolRunGroup(items: TranscriptItem[], expandedToolGroupIds: ReadonlySet<string>, options: TranscriptRenderOptions = {}): string {
  const groupId = toolGroupId(items);
  const expanded = expandedToolGroupIds.has(groupId);
  const labels = items
    .slice(0, 3)
    .map((item) => item.title.replace(/^\$\s*/, ""))
    .join(" · ");
  const duration = formatToolDuration(groupDurationMs(items, options.activeToolGroupId === groupId ? options.nowMs : undefined));
  return `<details class="tool-run-group" data-tool-run-group="${escapeHtml(groupId)}" ${expanded ? "open" : ""}>
      <summary>
        <strong>Ran ${items.length} tools${duration ? ` · ${escapeHtml(duration)}` : ""}</strong>
        ${labels ? `<span>${escapeHtml(labels)}${items.length > 3 ? " …" : ""}</span>` : ""}
      </summary>
      <div class="tool-run-items">
        ${items.map((item) => renderTranscriptItemShell(item)).join("")}
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
    if (!isGroupableToolItem(item)) {
      parts.push(renderTranscriptItemShell(item));
      index++;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < transcript.length && isRenderableTranscriptItem(transcript[index]!) && isGroupableToolItem(transcript[index]!)) {
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
  const previousGrouped = index > 0 && isGroupableToolItem(transcript[index - 1]!);
  const nextGrouped = index < transcript.length - 1 && isGroupableToolItem(transcript[index + 1]!);
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
  const isQuestionTool = item.kind === "tool" && item.title === "Question";
  return item.kind === "system" || isDeveloperBashItem(item) || (item.status === "running" && !isQuestionTool) || item.status === "error";
}
