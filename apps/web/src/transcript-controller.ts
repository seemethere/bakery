import { isRenderableTranscriptItem, isToolCallOnlyAssistant, mergeDuplicateDeveloperBash, mergeDuplicateToolResult, shouldPreferPendingToolTitle, toolCallTitlesForItem, type TranscriptItem } from "./transcript";
import { isRecord } from "./utils";

export type ToolTimingCacheEntry = { startedAt?: string; endedAt?: string; durationMs?: number };

function toolTimingStorageKey(sessionId: string): string {
  return `piWebToolTiming:${sessionId}`;
}

function loadToolTimingCache(storage: Storage, sessionId: string): Map<string, ToolTimingCacheEntry> {
  try {
    const raw = JSON.parse(storage.getItem(toolTimingStorageKey(sessionId)) ?? "{}");
    if (!isRecord(raw)) return new Map();
    return new Map(Object.entries(raw).flatMap(([id, value]) => isRecord(value) ? [[id, {
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
      ...(typeof value.endedAt === "string" ? { endedAt: value.endedAt } : {}),
      ...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
    } satisfies ToolTimingCacheEntry]] : []));
  } catch {
    return new Map();
  }
}

function saveToolTimingCache(storage: Storage, sessionId: string, cache: ReadonlyMap<string, ToolTimingCacheEntry>): void {
  const entries = [...cache.entries()].slice(-500);
  storage.setItem(toolTimingStorageKey(sessionId), JSON.stringify(Object.fromEntries(entries)));
}

export function toolCallIdForTranscriptItem(item: TranscriptItem): string | null {
  if (isRecord(item.raw) && typeof item.raw.toolCallId === "string") return item.raw.toolCallId;
  return item.id.startsWith("tool:") ? item.id.slice("tool:".length) : null;
}

function isGenericToolResultTitle(title: string): boolean {
  return /^(?:tool result(?::|$)|result(?::|$))/i.test(title.trim());
}

function hasToolOutput(item: TranscriptItem): boolean {
  return Boolean(item.body.trim() || item.segments?.length);
}

function mergeSameIdToolResult(existing: TranscriptItem, nextItem: TranscriptItem): TranscriptItem {
  if (existing.kind !== "tool" || nextItem.kind !== "tool" || !isGenericToolResultTitle(nextItem.title)) return { ...existing, ...nextItem };
  const existingHasOutput = hasToolOutput(existing);
  const nextBody = nextItem.body.trim() || !existingHasOutput ? nextItem.body : existing.body;
  const nextSegments = nextItem.segments?.length ? nextItem.segments : nextItem.body.trim() ? undefined : existing.segments;
  const merged: TranscriptItem = {
    ...existing,
    ...nextItem,
    title: isGenericToolResultTitle(existing.title) ? nextItem.title : existing.title,
    body: nextBody,
    raw: { previous: existing.raw, toolResult: nextItem.raw },
  };
  if (nextSegments) merged.segments = nextSegments;
  else delete merged.segments;
  return merged;
}

export class TranscriptController {
  readonly expansion = new Map<string, boolean>();
  readonly dirtyIds = new Set<string>();
  private readonly storage: Storage;
  private pendingToolCallTitles: string[] = [];
  private toolTimingCache = new Map<string, ToolTimingCacheEntry>();
  private _items: TranscriptItem[] = [];
  private _selectedId: string;
  private _structureDirty = false;

  constructor(storage: Storage, selectedId = "") {
    this.storage = storage;
    this._selectedId = selectedId;
  }

  get items(): TranscriptItem[] {
    return this._items;
  }

  set items(items: TranscriptItem[]) {
    this._items = items;
  }

  get selectedId(): string {
    return this._selectedId;
  }

  get structureDirty(): boolean {
    return this._structureDirty;
  }

  set structureDirty(value: boolean) {
    this._structureDirty = value;
  }

  replaceItems(items: TranscriptItem[], options: { selectedFallback?: string } = {}): void {
    this._items = items;
    this.pendingToolCallTitles = [];
    this.dirtyIds.clear();
    this._structureDirty = true;
    if (!this._items.some((item) => item.id === this._selectedId)) this.select(options.selectedFallback ?? this._items.at(-1)?.id ?? "", { persist: false });
  }

  reset(): void {
    this._items = [];
    this.pendingToolCallTitles = [];
    this.dirtyIds.clear();
    this._structureDirty = true;
  }

  select(id: string, options: { persist?: boolean } = {}): void {
    this._selectedId = id;
    if (options.persist !== false) this.storage.setItem("piWebSelectedTranscriptId", id);
  }

  loadToolTimings(sessionId: string): void {
    this.toolTimingCache = loadToolTimingCache(this.storage, sessionId);
  }

  applyCachedToolTimings(items: TranscriptItem[]): TranscriptItem[] {
    return items.map((item) => {
      if (item.kind !== "tool") return item;
      const toolCallId = toolCallIdForTranscriptItem(item);
      const timing = toolCallId ? this.toolTimingCache.get(toolCallId) : undefined;
      if (!timing) return item;
      const startedAt = item.startedAt ?? timing.startedAt;
      const endedAt = item.endedAt ?? timing.endedAt;
      const durationMs = item.durationMs ?? timing.durationMs;
      return {
        ...item,
        ...(startedAt ? { startedAt } : {}),
        ...(endedAt ? { endedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
    });
  }

  rememberToolTiming(sessionId: string | undefined, item: TranscriptItem): void {
    if (!sessionId || item.kind !== "tool") return;
    const toolCallId = toolCallIdForTranscriptItem(item);
    if (!toolCallId) return;
    const existing = this.toolTimingCache.get(toolCallId) ?? {};
    const next = {
      ...existing,
      ...(item.startedAt ? { startedAt: item.startedAt } : {}),
      ...(item.endedAt ? { endedAt: item.endedAt } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    } satisfies ToolTimingCacheEntry;
    if (!next.startedAt && !next.endedAt && next.durationMs === undefined) return;
    this.toolTimingCache.set(toolCallId, next);
    saveToolTimingCache(this.storage, sessionId, this.toolTimingCache);
  }

  removeByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    this._items = this._items.filter((item) => !idSet.has(item.id));
    for (const id of ids) this.dirtyIds.add(id);
    this._structureDirty = true;
  }

  upsert(item: TranscriptItem, options: { markUnread?: (id: string) => void; selectFallback?: (index: number) => string } = {}): void {
    if (isToolCallOnlyAssistant(item)) {
      this.pendingToolCallTitles.push(...toolCallTitlesForItem(item));
      const existingIndex = this._items.findIndex((candidate) => candidate.id === item.id);
      if (existingIndex !== -1) {
        this._items.splice(existingIndex, 1);
        this._structureDirty = true;
      }
      return;
    }

    let nextItem = item;
    if (nextItem.kind === "tool" && this.pendingToolCallTitles.length > 0) {
      const pendingTitle = this.pendingToolCallTitles.shift();
      if (pendingTitle && shouldPreferPendingToolTitle(nextItem)) nextItem = { ...nextItem, title: pendingTitle };
    } else if (nextItem.kind !== "tool") {
      this.pendingToolCallTitles.length = 0;
    }

    const index = this._items.findIndex((candidate) => candidate.id === nextItem.id);
    if (index === -1) {
      for (let runningBashIndex = this._items.length - 1; runningBashIndex >= 0; runningBashIndex -= 1) {
        const candidate = this._items[runningBashIndex];
        if (candidate && mergeDuplicateDeveloperBash(candidate, nextItem)) {
          this.dirtyIds.add(candidate.id);
          return;
        }
      }
    }
    const previousForMerge = index === -1 ? this._items.at(-1) : this._items[index - 1];
    if (previousForMerge && mergeDuplicateToolResult(previousForMerge, nextItem)) {
      this.dirtyIds.add(previousForMerge.id);
      return;
    }

    if (!isRenderableTranscriptItem(nextItem)) {
      if (index !== -1) {
        this._items.splice(index, 1);
        if (this._selectedId === nextItem.id) this.select(options.selectFallback?.(Math.max(0, index - 1)) ?? this._items[Math.max(0, index - 1)]?.id ?? "", { persist: false });
      }
      this.dirtyIds.delete(nextItem.id);
      this._structureDirty = true;
      return;
    }

    const previousStatus = index === -1 ? undefined : this._items[index]?.status;
    if (index === -1) this._items.push(nextItem);
    else this._items[index] = mergeSameIdToolResult(this._items[index]!, nextItem);
    const nextIndex = index === -1 ? this._items.length - 1 : index;
    this.dirtyIds.add(nextItem.id);
    const previous = this._items[nextIndex - 1];
    const next = this._items[nextIndex + 1];
    if (previous?.kind === "tool") this.dirtyIds.add(previous.id);
    if (next?.kind === "tool") this.dirtyIds.add(next.id);
    if (nextItem.kind === "tool" && (index === -1 || previousStatus !== nextItem.status || nextItem.status === "done" || nextItem.status === "error")) this._structureDirty = true;
    options.markUnread?.(nextItem.id);
    if (!this._selectedId) this.select(nextItem.id, { persist: false });
  }
}
