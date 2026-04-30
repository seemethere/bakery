import { isRenderableTranscriptItem, PiTranscriptRow, type TranscriptItem } from "./transcript";
import { isAfterRunningTool, toolGroupPositionFor, transcriptElementOrderIndex } from "./transcript-renderer";

export type TranscriptPointerDown = { id: string; x: number; y: number } | null;

export type TranscriptBindingState = {
  pointerDown: TranscriptPointerDown;
};

export type TranscriptBindingOptions = {
  onCloseActionMenu: () => void;
  onSelect: (id: string) => void;
};

export type TranscriptRowStateOptions = {
  showThinking: boolean;
  selectedTranscriptId: string;
  transcriptExpansion: Map<string, boolean>;
  openActionMenuId: string;
  canFork: (item: TranscriptItem) => boolean;
  renderedSegmentCache: Map<string, string>;
  localImageUrl: (path: string) => string | null;
};

export function findTranscriptElement(root: ParentNode, id: string): PiTranscriptRow | null {
  return root.querySelector<PiTranscriptRow>(`.transcript pi-transcript-row[data-transcript-id="${CSS.escape(id)}"]`);
}

export function insertTranscriptRowInOrder(transcriptElement: HTMLElement, transcript: TranscriptItem[], row: PiTranscriptRow, item: TranscriptItem): void {
  const itemIndex = transcript.findIndex((candidate) => candidate.id === item.id);
  if (itemIndex < 0) {
    transcriptElement.append(row);
    return;
  }
  const nextSibling = Array.from(transcriptElement.children).find((child) => transcriptElementOrderIndex(transcript, child) > itemIndex);
  transcriptElement.insertBefore(row, nextSibling ?? null);
}

export function bindTranscriptElement(element: HTMLElement, bindingState: TranscriptBindingState, options: TranscriptBindingOptions): void {
  if (element.dataset.transcriptBound === "true") return;
  element.dataset.transcriptBound = "true";
  element.addEventListener("pointerdown", (event) => {
    bindingState.pointerDown = { id: element.dataset.transcriptId ?? "", x: event.clientX, y: event.clientY };
  });
  element.addEventListener("click", (event) => {
    if ((event.target as HTMLElement | null)?.closest(".message-action-area, .message-action-bar")) return;
    if ((event.target as HTMLElement | null)?.closest(".message-header") && element.classList.contains("collapsible")) return;
    if (shouldPreserveTextSelection(element, event, bindingState.pointerDown)) return;
    options.onCloseActionMenu();
    options.onSelect(element.dataset.transcriptId ?? "");
  });
}

export function shouldPreserveTextSelection(element: HTMLElement, event: MouseEvent, pointerDown: TranscriptPointerDown): boolean {
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (range.intersectsNode(element)) return true;
    }
  }

  if (!pointerDown || pointerDown.id !== (element.dataset.transcriptId ?? "")) return false;
  const movedX = Math.abs(event.clientX - pointerDown.x);
  const movedY = Math.abs(event.clientY - pointerDown.y);
  return movedX > 4 || movedY > 4;
}

export function updateTranscriptRow(row: PiTranscriptRow, transcript: TranscriptItem[], item: TranscriptItem, options: TranscriptRowStateOptions): void {
  row.setState(item, {
    showThinking: options.showThinking,
    selected: item.id === options.selectedTranscriptId,
    expanded: options.transcriptExpansion.get(item.id),
    actionMenuOpen: item.id === options.openActionMenuId,
    canFork: options.canFork(item),
    afterRunningTool: isAfterRunningTool(transcript, item),
    toolGroupPosition: toolGroupPositionFor(transcript, item),
    cache: options.renderedSegmentCache,
    localImageUrl: options.localImageUrl,
  });
}

export function hydrateTranscriptRows(root: ParentNode, transcript: TranscriptItem[], rowOptions: TranscriptRowStateOptions, bindingState: TranscriptBindingState, bindingOptions: TranscriptBindingOptions): void {
  root.querySelectorAll<PiTranscriptRow>("pi-transcript-row[data-transcript-id]").forEach((row) => {
    bindTranscriptElement(row, bindingState, bindingOptions);
    const item = transcript.find((candidate) => candidate.id === row.dataset.transcriptId);
    if (item) updateTranscriptRow(row, transcript, item, rowOptions);
  });
}

export function patchDirtyTranscriptRows(root: ParentNode, transcriptElement: HTMLElement, transcript: TranscriptItem[], dirtyTranscriptIds: Set<string>, rowOptions: TranscriptRowStateOptions, bindingState: TranscriptBindingState, bindingOptions: TranscriptBindingOptions): void {
  for (const id of dirtyTranscriptIds) {
    const item = transcript.find((candidate) => candidate.id === id);
    const existing = findTranscriptElement(root, id);
    if (!item || !isRenderableTranscriptItem(item)) {
      existing?.remove();
      continue;
    }
    if (existing) {
      updateTranscriptRow(existing, transcript, item, rowOptions);
    } else {
      const next = document.createElement("pi-transcript-row") as PiTranscriptRow;
      next.dataset.transcriptId = item.id;
      bindTranscriptElement(next, bindingState, bindingOptions);
      updateTranscriptRow(next, transcript, item, rowOptions);
      insertTranscriptRowInOrder(transcriptElement, transcript, next, item);
    }
  }
}
