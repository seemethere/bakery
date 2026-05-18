import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon } from "lucide-react";
import type { ExtensionCatalog, SessionTreeNode } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "@/lib/transcript";
import { isAskQuestionToolItem, toolHeaderDisplay } from "@/lib/transcript";
import { isNonInformativeSubagentManagementReceipt } from "./SubagentCard";
import { TranscriptRow } from "./TranscriptRow";
import { ExperimentalToolGroup } from "./ExperimentalToolGroup";
import { Button } from "@/components/ui/button";
import { useToolUiPreference } from "@/lib/tool-ui-preference";

const AUTO_SCROLL_STORAGE_KEY = "piWebAutoScroll";

function loadAutoScrollPreference(): boolean {
  try {
    return localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveAutoScrollPreference(value: boolean): void {
  try {
    localStorage.setItem(AUTO_SCROLL_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage failures in private/locked-down browser contexts.
  }
}

type RenderEntry =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "toolGroup"; id: string; items: TranscriptItem[] };

function supportedToolGroupAction(item: TranscriptItem): boolean {
  if (item.kind !== "tool" || item.status === "running" || item.status === "error") return false;
  const { action } = toolHeaderDisplay(item);
  return action === "bash" || action === "read" || action === "edit" || action === "write" || action === "grep" || action === "find";
}

function toolGroupCategory(item: TranscriptItem): "command" | "file" | "search" | null {
  const { action } = toolHeaderDisplay(item);
  if (action === "bash") return "command";
  if (action === "grep" || action === "find") return "search";
  if (action === "read" || action === "edit" || action === "write") return "file";
  return null;
}

function shouldGroupTools(items: TranscriptItem[]): boolean {
  if (items.length < 3) return false;
  const categories = new Set(items.map(toolGroupCategory).filter(Boolean));
  return categories.size >= 2;
}

function renderEntriesForToolUi(items: TranscriptItem[], enabled: boolean): RenderEntry[] {
  if (!enabled) return items.map((item) => ({ kind: "item", item }));
  const entries: RenderEntry[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index]!;
    if (!supportedToolGroupAction(item)) {
      entries.push({ kind: "item", item });
      index += 1;
      continue;
    }
    const group: TranscriptItem[] = [];
    while (index < items.length && supportedToolGroupAction(items[index]!)) {
      group.push(items[index]!);
      index += 1;
    }
    if (shouldGroupTools(group)) entries.push({ kind: "toolGroup", id: `tool-group:${group.map((tool) => tool.id).join(":")}`, items: group });
    else entries.push(...group.map((tool) => ({ kind: "item" as const, item: tool })));
  }
  return entries;
}

type Props = {
  items: TranscriptItem[];
  connectionStatus: string;
  showThinking: boolean;
  sessionId: string;
  sessionCwd: string | null;
  apiBase: string;
  token: string;
  extensionCatalog: ExtensionCatalog | null;
  sessionTreeNodes: SessionTreeNode[];
  onFork: (entryId: string) => void | Promise<void>;
  onAcceptPlan?: () => void;
};

export function TranscriptView({ items, connectionStatus, showThinking, sessionId, sessionCwd, apiBase, token, extensionCatalog, sessionTreeNodes, onFork, onAcceptPlan }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(loadAutoScrollPreference());
  const unreadIdsRef = useRef(new Set<string>());
  const previousVisibleSignaturesRef = useRef(new Map<string, string>());
  const smoothJumpRef = useRef(false);
  const smoothJumpFrameRef = useRef<number | null>(null);
  const pendingInitialBottomScrollSessionRef = useRef<string | null>(null);
  const initialBottomScrollInProgressRef = useRef(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(autoScrollRef.current);
  const [unreadCount, setUnreadCount] = useState(0);
  const toolUiPreference = useToolUiPreference();
  const visibleItems = useMemo(
    () => items.filter((item) => !isAskQuestionToolItem(item) && !isNonInformativeSubagentManagementReceipt(item)),
    [items],
  );
  const renderEntries = useMemo(
    () => renderEntriesForToolUi(visibleItems, toolUiPreference !== "default"),
    [visibleItems, toolUiPreference],
  );

  function markBottomState(atBottom: boolean) {
    if ((pendingInitialBottomScrollSessionRef.current || initialBottomScrollInProgressRef.current) && !atBottom) return;
    if (smoothJumpRef.current && !atBottom) return;
    autoScrollRef.current = atBottom;
    saveAutoScrollPreference(atBottom);
    setIsFollowingLatest(atBottom);
    if (atBottom) {
      smoothJumpRef.current = false;
      unreadIdsRef.current.clear();
      setUnreadCount(0);
    }
  }

  function cancelSmoothJump() {
    if (smoothJumpFrameRef.current !== null) {
      cancelAnimationFrame(smoothJumpFrameRef.current);
      smoothJumpFrameRef.current = null;
    }
  }

  function followLatest() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function easeOutCubic(progress: number): number {
    return 1 - (1 - progress) ** 3;
  }

  function smoothFollowLatest() {
    const el = containerRef.current;
    if (!el) return;
    const scroller = el;
    cancelSmoothJump();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      followLatest();
      smoothJumpRef.current = false;
      return;
    }

    const startTop = scroller.scrollTop;
    const startTime = performance.now();
    const duration = Math.min(1_180, Math.max(560, Math.abs(scroller.scrollHeight - scroller.clientHeight - startTop) * 0.38));

    function tick(now: number) {
      const targetTop = scroller.scrollHeight - scroller.clientHeight;
      const progress = Math.min(1, (now - startTime) / duration);
      scroller.scrollTop = startTop + (targetTop - startTop) * easeOutCubic(progress);
      if (progress < 1 && Math.abs(targetTop - scroller.scrollTop) > 1) {
        smoothJumpFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      scroller.scrollTop = targetTop;
      smoothJumpFrameRef.current = null;
      smoothJumpRef.current = false;
      markBottomState(true);
    }

    smoothJumpFrameRef.current = requestAnimationFrame(tick);
  }

  // Detect manual scroll-up → disable auto-scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      markBottomState(atBottom);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [items.length]);

  useEffect(() => {
    const root = containerRef.current;
    const bottom = bottomRef.current;
    if (!root || !bottom) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const atBottom = entry?.isIntersecting ?? false;
        markBottomState(atBottom);
      },
      { root, threshold: 1 },
    );

    observer.observe(bottom);
    return () => observer.disconnect();
  }, [items.length]);

  useLayoutEffect(() => {
    pendingInitialBottomScrollSessionRef.current = sessionId;
    autoScrollRef.current = true;
    unreadIdsRef.current.clear();
    previousVisibleSignaturesRef.current = new Map(visibleItems.map((item) => [item.id, `${item.status ?? ""}:${item.body.length}:${item.segments?.length ?? 0}`]));
    setUnreadCount(0);
    setIsFollowingLatest(true);
  }, [sessionId]);

  useLayoutEffect(() => {
    if (pendingInitialBottomScrollSessionRef.current !== sessionId || visibleItems.length === 0) return;
    pendingInitialBottomScrollSessionRef.current = null;
    initialBottomScrollInProgressRef.current = true;
    followLatest();
    let secondFrame: number | null = null;
    const firstFrame = requestAnimationFrame(() => {
      followLatest();
      secondFrame = requestAnimationFrame(() => {
        followLatest();
        const el = containerRef.current;
        const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        initialBottomScrollInProgressRef.current = false;
        markBottomState(atBottom);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) cancelAnimationFrame(secondFrame);
      initialBottomScrollInProgressRef.current = false;
    };
  }, [sessionId, visibleItems.length]);

  // Follow streaming updates while the reader is already at the latest item.
  useLayoutEffect(() => {
    const nextSignatures = new Map(visibleItems.map((item) => [item.id, `${item.status ?? ""}:${item.body.length}:${item.segments?.length ?? 0}`]));
    if (!autoScrollRef.current) {
      if (previousVisibleSignaturesRef.current.size === 0 && unreadIdsRef.current.size === 0) {
        previousVisibleSignaturesRef.current = nextSignatures;
        return;
      }
      for (const item of visibleItems) {
        if (previousVisibleSignaturesRef.current.get(item.id) !== nextSignatures.get(item.id)) unreadIdsRef.current.add(item.id);
      }
      previousVisibleSignaturesRef.current = nextSignatures;
      setUnreadCount(unreadIdsRef.current.size);
      return;
    }
    previousVisibleSignaturesRef.current = nextSignatures;
    setIsFollowingLatest(true);
    unreadIdsRef.current.clear();
    setUnreadCount(0);
    followLatest();
    const frame = requestAnimationFrame(() => {
      followLatest();
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleItems]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) followLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Empty transcripts have no unread rows; keep the persisted follow preference intact.
  useEffect(() => {
    if (items.length === 0) {
      unreadIdsRef.current.clear();
      previousVisibleSignaturesRef.current.clear();
      setIsFollowingLatest(autoScrollRef.current);
      setUnreadCount(0);
    }
  }, [items.length]);

  function jumpToLatest() {
    autoScrollRef.current = true;
    saveAutoScrollPreference(true);
    smoothJumpRef.current = true;
    unreadIdsRef.current.clear();
    previousVisibleSignaturesRef.current.clear();
    setIsFollowingLatest(true);
    setUnreadCount(0);
    smoothFollowLatest();
  }

  useEffect(() => {
    return () => {
      cancelSmoothJump();
    };
  }, []);

  function handleJumpPointerDown() {
    smoothJumpRef.current = true;
  }

  if (connectionStatus === "connecting") {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Connecting…
      </div>
    );
  }

  if (connectionStatus === "disconnected" && items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Not connected.
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div data-testid="transcript" className="transcript min-h-0 flex-1" aria-label="Empty transcript" />
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} data-testid="transcript" className="transcript h-full overflow-y-auto py-4">
        <div ref={contentRef} className="max-w-[860px] mx-auto w-full">
          {renderEntries.map((entry) => entry.kind === "toolGroup" ? (
            <ExperimentalToolGroup key={entry.id} items={entry.items} />
          ) : (
            <TranscriptRow
              key={entry.item.id}
              item={entry.item}
              showThinking={showThinking}
              sessionId={sessionId}
              sessionCwd={sessionCwd}
              apiBase={apiBase}
              token={token}
              extensionCatalog={extensionCatalog}
              sessionTreeNodes={sessionTreeNodes}
              onFork={onFork}
              onAcceptPlan={onAcceptPlan}
              toolUiPreference={toolUiPreference}
            />
          ))}
          <div ref={bottomRef} className="h-px" aria-hidden="true" />
        </div>
        <div className="h-1" />
      </div>
      {!isFollowingLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <Button
            id="jumpToLatest"
            type="button"
            size="icon-sm"
            variant="outline"
            onPointerDown={handleJumpPointerDown}
            onClick={jumpToLatest}
            aria-label={`Jump to latest${unreadCount > 0 ? `, ${unreadCount} unread update${unreadCount === 1 ? "" : "s"}` : ""}`}
            title={`Jump to latest${unreadCount > 0 ? ` · ${unreadCount} update${unreadCount === 1 ? "" : "s"}` : ""}`}
            data-testid="jump-to-latest"
            className="pointer-events-auto rounded-full bg-background/85 shadow-lg backdrop-blur"
          >
            <ArrowDownIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
