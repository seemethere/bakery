import { latestGroupableToolGroupId, toolRunSummaryText } from "./transcript-renderer";
import type { TranscriptItem } from "./transcript";
import { recordPerfEvent, recordPerfSample } from "./utils";

function existingTranscriptRows(root: ParentNode): Map<string, HTMLElement> {
  const existingRows = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>("pi-transcript-row[data-transcript-id]").forEach((row) => {
    const id = row.dataset.transcriptId;
    if (id) existingRows.set(id, row);
  });
  return existingRows;
}

function restoreTranscriptRows(root: ParentNode, existingRows: Map<string, HTMLElement>): void {
  root.querySelectorAll<HTMLElement>("pi-transcript-row[data-transcript-id]").forEach((placeholder) => {
    const id = placeholder.dataset.transcriptId;
    const existing = id ? existingRows.get(id) : undefined;
    if (existing) placeholder.replaceWith(existing);
  });
}

export function replaceHtmlPreservingTranscript(host: HTMLElement, html: string): void {
  const existingRows = existingTranscriptRows(host);
  const template = document.createElement("template");
  template.innerHTML = html;
  restoreTranscriptRows(template.content, existingRows);
  host.replaceChildren(template.content);
}

export function patchTranscriptStructure(options: {
  host: HTMLElement;
  transcript: HTMLElement;
  items: TranscriptItem[];
  dirtyIds: ReadonlySet<string>;
  renderTranscript: () => string;
  hydrateRows: () => void;
  markClean: () => void;
}): void {
  recordPerfEvent("structurePatch", "transcript-structure-dirty", { transcriptItems: options.items.length, dirtyRows: options.dirtyIds.size });
  const existingRows = existingTranscriptRows(options.host);
  const template = document.createElement("template");
  template.innerHTML = options.renderTranscript();
  restoreTranscriptRows(template.content, existingRows);
  options.transcript.replaceChildren(template.content);
  options.hydrateRows();
  options.markClean();
}

export function patchRunningToolGroupElapsed(root: ParentNode, items: TranscriptItem[]): boolean {
  const groupId = latestGroupableToolGroupId(items);
  if (!groupId) return false;
  const activity = Array.from(root.querySelectorAll<HTMLElement>("[data-tool-activity]"))
    .find((element) => element.dataset.toolActivity === groupId);
  const card = activity?.closest<HTMLElement>(".tool-activity-card");
  const receipt = card?.querySelector<HTMLElement>(".tool-activity-receipt");
  if (!receipt) return false;

  const itemIds = new Set((activity?.dataset.toolActivityIds ?? "").split("|").filter(Boolean));
  const groupItems = items.filter((item) => itemIds.has(item.id));
  if (groupItems.length === 0) return false;
  const summary = toolRunSummaryText(groupItems, { activeToolGroupId: groupId, nowMs: Date.now() });
  const receiptText = summary.receiptLabel;
  const changed = receipt.textContent !== receiptText;
  if (changed) receipt.textContent = receiptText;
  receipt.title = receiptText;
  recordPerfEvent("receiptPatch", changed ? "changed" : "unchanged", { itemCount: groupItems.length });
  return true;
}

export function syncOpenActionMenus(root: ParentNode, openActionMenuId: string): void {
  root.querySelectorAll<HTMLElement>("pi-transcript-row[data-transcript-id]").forEach((row) => {
    const isOpenRow = Boolean(openActionMenuId) && row.dataset.transcriptId === openActionMenuId;
    if (isOpenRow) return;
    row.querySelectorAll<HTMLElement>(".message-action-menu").forEach((menu) => menu.remove());
    row.querySelectorAll<HTMLButtonElement>('.message-overflow[aria-expanded="true"]').forEach((button) => button.setAttribute("aria-expanded", "false"));
  });
}

export function recordTranscriptPatchSample(start: number, kind: "structure" | "dirty-rows"): void {
  recordPerfSample("patch", performance.now() - start, kind);
}
