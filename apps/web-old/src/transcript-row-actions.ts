import { type TranscriptItem } from "./transcript";
import { defaultTranscriptExpanded } from "./transcript-renderer";

export type TranscriptRowAction = "copy" | "fork" | "toggle-output";
export type TranscriptRowMenuAction = TranscriptRowAction | "menu";

export interface TranscriptRowActionContext {
  items: readonly TranscriptItem[];
  expansion: Map<string, boolean>;
  dirtyIds: Set<string>;
  openActionMenuId: string;
  setOpenActionMenuId(id: string): void;
  selectItem(id: string, shouldRender?: boolean): void;
  preserveNextScrollSync(): void;
  render(): void;
  copyText(value: string): Promise<void>;
  forkEntryIdForItem(item: TranscriptItem): string | null;
  forkFromEntry(entryId: string): Promise<void>;
  refreshTree(): Promise<void>;
  setNotice(message: string): void;
}

export async function handleTranscriptRowAction(context: TranscriptRowActionContext, action: TranscriptRowMenuAction, transcriptId: string): Promise<void> {
  const item = context.items.find((candidate) => candidate.id === transcriptId);
  if (!item) return;

  if (action === "toggle-output") {
    const currentExpanded = context.expansion.get(transcriptId) ?? defaultTranscriptExpanded(item);
    context.expansion.set(transcriptId, !currentExpanded);
    context.dirtyIds.add(transcriptId);
    context.preserveNextScrollSync();
    context.render();
    return;
  }

  if (action === "menu") {
    context.setOpenActionMenuId(context.openActionMenuId === transcriptId ? "" : transcriptId);
    context.selectItem(transcriptId, false);
    if (!context.forkEntryIdForItem(item)) await context.refreshTree();
    context.render();
    return;
  }

  context.setOpenActionMenuId("");
  if (action === "copy") {
    await context.copyText(item.body);
    return;
  }

  if (action === "fork") {
    const entryId = context.forkEntryIdForItem(item);
    if (entryId) await context.forkFromEntry(entryId);
    else {
      context.setNotice("Fork is only available after this event appears in the session tree.");
      context.render();
    }
  }
}
