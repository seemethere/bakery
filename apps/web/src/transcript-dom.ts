import { isRenderableTranscriptItem, PiTranscriptRow, type TranscriptItem } from "./transcript";
import { isAfterRunningTool, renderToolRunGroup, toolGroupPositionFor, toolRunForItem, toolRunGroupId, transcriptElementOrderIndex, type TranscriptRenderOptions } from "./transcript-renderer";

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

export type ToolRunGroupOptions = {
  expandedToolGroupIds: Set<string>;
  renderOptions?: TranscriptRenderOptions | undefined;
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

export function bindToolRunGroups(root: ParentNode, options: ToolRunGroupOptions): void {
  root.querySelectorAll<HTMLDetailsElement>(".tool-run-group[data-tool-run-group]").forEach((group) => {
    if (group.dataset.toolRunBound === "true") return;
    group.dataset.toolRunBound = "true";
    let userToggled = false;
    const markUserToggle = () => {
      userToggled = true;
    };
    group.querySelector("summary")?.addEventListener("pointerdown", markUserToggle);
    group.querySelector("summary")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") markUserToggle();
    });
    group.addEventListener("toggle", () => {
      if (group.dataset.liveToolStack === "true" && !userToggled) return;
      userToggled = false;
      const id = group.dataset.toolRunGroup ?? "";
      if (!id) return;
      if (group.open) options.expandedToolGroupIds.add(id);
      else options.expandedToolGroupIds.delete(id);
    });
  });
}

export function hydrateTranscriptRows(root: ParentNode, transcript: TranscriptItem[], rowOptions: TranscriptRowStateOptions, bindingState: TranscriptBindingState, bindingOptions: TranscriptBindingOptions, toolGroupOptions: ToolRunGroupOptions): void {
  root.querySelectorAll<PiTranscriptRow>("pi-transcript-row[data-transcript-id]").forEach((row) => {
    bindTranscriptElement(row, bindingState, bindingOptions);
    const item = transcript.find((candidate) => candidate.id === row.dataset.transcriptId);
    if (item) updateTranscriptRow(row, transcript, item, rowOptions);
  });
  bindToolRunGroups(root, toolGroupOptions);
}

function existingToolRunGroupForItems(root: ParentNode, groupId: string, itemIds: Set<string>): HTMLDetailsElement | null {
  const exact = root.querySelector<HTMLDetailsElement>(`.tool-run-group[data-tool-run-group="${CSS.escape(groupId)}"]`);
  if (exact) return exact;
  return Array.from(root.querySelectorAll<HTMLDetailsElement>(".tool-run-group[data-tool-run-item-ids]")).find((group) => {
    const ids = (group.dataset.toolRunItemIds ?? "").split("|");
    return ids.some((id) => itemIds.has(id));
  }) ?? null;
}

function restoreGroupRows(root: ParentNode, group: HTMLElement): void {
  group.querySelectorAll<HTMLElement>("pi-transcript-row[data-transcript-id]").forEach((placeholder) => {
    const id = placeholder.dataset.transcriptId;
    const existing = id ? findTranscriptElement(root, id) : null;
    if (existing) {
      placeholder.replaceWith(existing);
      return;
    }
    const row = document.createElement("pi-transcript-row") as PiTranscriptRow;
    if (id) row.dataset.transcriptId = id;
    placeholder.replaceWith(row);
  });
}

function insertToolRunGroupInOrder(transcriptElement: HTMLElement, transcript: TranscriptItem[], group: HTMLElement, firstItem: TranscriptItem): void {
  const itemIndex = transcript.findIndex((candidate) => candidate.id === firstItem.id);
  const nextSibling = Array.from(transcriptElement.children).find((child) => transcriptElementOrderIndex(transcript, child) > itemIndex);
  transcriptElement.insertBefore(group, nextSibling ?? null);
}

export function patchDirtyToolRunGroups(root: ParentNode, transcriptElement: HTMLElement, transcript: TranscriptItem[], dirtyTranscriptIds: Set<string>, rowOptions: TranscriptRowStateOptions, bindingState: TranscriptBindingState, bindingOptions: TranscriptBindingOptions, toolGroupOptions: ToolRunGroupOptions): Set<string> {
  const patchedIds = new Set<string>();
  const groups = new Map<string, TranscriptItem[]>();
  for (const id of dirtyTranscriptIds) {
    const items = toolRunForItem(transcript, id);
    if (items.length > 0) groups.set(toolRunGroupId(items), items);
  }

  for (const [groupId, items] of groups) {
    const itemIds = new Set(items.map((item) => item.id));
    const existingGroup = existingToolRunGroupForItems(root, groupId, itemIds);
    const existingRows = items.map((item) => findTranscriptElement(root, item.id)).filter((row): row is PiTranscriptRow => Boolean(row));
    const insertionMarker = !existingGroup && existingRows[0]?.parentNode ? document.createComment("tool-run-group") : null;
    if (insertionMarker && existingRows[0]?.parentNode) existingRows[0].parentNode.insertBefore(insertionMarker, existingRows[0]);
    const template = document.createElement("template");
    template.innerHTML = renderToolRunGroup(items, toolGroupOptions.expandedToolGroupIds, toolGroupOptions.renderOptions);
    const group = template.content.firstElementChild as HTMLDetailsElement | null;
    if (!group) continue;
    restoreGroupRows(root, group);
    for (const row of group.querySelectorAll<PiTranscriptRow>("pi-transcript-row[data-transcript-id]")) {
      bindTranscriptElement(row, bindingState, bindingOptions);
      const item = transcript.find((candidate) => candidate.id === row.dataset.transcriptId);
      if (item) updateTranscriptRow(row, transcript, item, rowOptions);
    }
    for (const id of itemIds) patchedIds.add(id);
    if (existingGroup) {
      existingGroup.replaceWith(group);
      insertionMarker?.remove();
    } else if (insertionMarker) {
      insertionMarker.replaceWith(group);
    } else {
      insertToolRunGroupInOrder(transcriptElement, transcript, group, items[0]!);
    }
  }
  bindToolRunGroups(root, toolGroupOptions);
  return patchedIds;
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
