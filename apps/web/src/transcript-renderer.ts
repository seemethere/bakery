import { isDeveloperBashItem, isRenderableTranscriptItem, itemHasRenderedImage, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { escapeHtml } from "./utils";

export function renderTranscriptItemShell(item: TranscriptItem): string {
  return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
}

export function isGroupableToolItem(item: TranscriptItem): boolean {
  return item.kind === "tool"
    && item.status === "done"
    && !isDeveloperBashItem(item)
    && !itemHasRenderedImage(item);
}

export function renderToolRunGroup(items: TranscriptItem[], expandedToolGroupIds: ReadonlySet<string>): string {
  const groupId = items.map((item) => item.id).join("|");
  const expanded = expandedToolGroupIds.has(groupId);
  const labels = items
    .slice(0, 3)
    .map((item) => item.title.replace(/^\$\s*/, ""))
    .join(" · ");
  return `<details class="tool-run-group" data-tool-run-group="${escapeHtml(groupId)}" ${expanded ? "open" : ""}>
      <summary>
        <strong>Ran ${items.length} tools</strong>
        ${labels ? `<span>${escapeHtml(labels)}${items.length > 3 ? " …" : ""}</span>` : ""}
      </summary>
      <div class="tool-run-items">
        ${items.map((item) => renderTranscriptItemShell(item)).join("")}
      </div>
    </details>`;
}

export function renderTranscriptHtml(transcript: readonly TranscriptItem[], expandedToolGroupIds: ReadonlySet<string>): string {
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
    if (group.length >= 2) parts.push(renderToolRunGroup(group, expandedToolGroupIds));
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
