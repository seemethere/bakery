import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon } from "lucide-react";
import type { ExtensionCatalog, SessionTreeNode } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "@/lib/transcript";
import { isAskQuestionToolItem } from "@/lib/transcript";
import { isNonInformativeSubagentManagementReceipt } from "./SubagentCard";
import { TranscriptRow } from "./TranscriptRow";
import { Button } from "@/components/ui/button";

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
  const autoScrollRef = useRef(true);
  const lastSignatureRef = useRef("");
  const smoothJumpRef = useRef(false);
  const smoothJumpFrameRef = useRef<number | null>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  function markBottomState(atBottom: boolean) {
    if (smoothJumpRef.current && !atBottom) return;
    autoScrollRef.current = atBottom;
    setIsFollowingLatest(atBottom);
    if (atBottom) {
      smoothJumpRef.current = false;
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

  // Follow streaming updates while the reader is already at the latest item.
  useLayoutEffect(() => {
    const last = items.at(-1);
    const signature = last ? `${last.id}:${last.status ?? ""}:${last.body.length}:${items.length}` : `empty:${items.length}`;
    const changed = signature !== lastSignatureRef.current;
    lastSignatureRef.current = signature;
    if (!autoScrollRef.current) {
      if (changed && items.length > 0) setUnreadCount((count) => count + 1);
      return;
    }
    setIsFollowingLatest(true);
    setUnreadCount(0);
    followLatest();
    const frame = requestAnimationFrame(() => {
      followLatest();
    });
    return () => cancelAnimationFrame(frame);
  }, [items]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) followLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Always scroll to bottom when a new session is opened (items goes from >0 to 0)
  useEffect(() => {
    if (items.length === 0) {
      autoScrollRef.current = true;
      setIsFollowingLatest(true);
      setUnreadCount(0);
    }
  }, [items.length]);

  function jumpToLatest() {
    autoScrollRef.current = true;
    smoothJumpRef.current = true;
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
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No messages yet. Send a prompt to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} data-testid="transcript" className="h-full overflow-y-auto py-4">
        <div ref={contentRef} className="max-w-[860px] mx-auto w-full">
          {items.filter((item) => !isAskQuestionToolItem(item) && !isNonInformativeSubagentManagementReceipt(item)).map((item) => (
            <TranscriptRow
              key={item.id}
              item={item}
              showThinking={showThinking}
              sessionId={sessionId}
              sessionCwd={sessionCwd}
              apiBase={apiBase}
              token={token}
              extensionCatalog={extensionCatalog}
              sessionTreeNodes={sessionTreeNodes}
              onFork={onFork}
              onAcceptPlan={onAcceptPlan}
            />
          ))}
          <div ref={bottomRef} className="h-px" aria-hidden="true" />
        </div>
        <div className="h-1" />
      </div>
      {!isFollowingLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
          <Button
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
