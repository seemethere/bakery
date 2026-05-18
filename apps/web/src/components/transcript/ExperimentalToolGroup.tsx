import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatToolDuration, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function itemDurationMs(item: TranscriptItem): number | undefined {
  if (typeof item.durationMs === "number") return item.durationMs;
  if (!item.startedAt || !item.endedAt) return undefined;
  const start = Date.parse(item.startedAt);
  const end = Date.parse(item.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function groupDurationMs(items: TranscriptItem[]): number | undefined {
  const starts = items.map((item) => item.startedAt ? Date.parse(item.startedAt) : NaN).filter(Number.isFinite);
  const ends = items.map((item) => item.endedAt ? Date.parse(item.endedAt) : NaN).filter(Number.isFinite);
  if (starts.length > 0 && ends.length > 0) return Math.max(0, Math.max(...ends) - Math.min(...starts));
  const sum = items.reduce((total, item) => total + (itemDurationMs(item) ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

function formatCount(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function summaryText(items: TranscriptItem[]): string {
  let files = 0;
  let searches = 0;
  let commands = 0;
  for (const item of items) {
    const { action } = toolHeaderDisplay(item);
    if (action === "bash") commands += 1;
    else if (action === "grep" || action === "find") searches += 1;
    else files += 1;
  }
  const parts = [
    files > 0 ? formatCount(files, "file") : "",
    searches > 0 ? formatCount(searches, "search") : "",
    commands > 0 ? formatCount(commands, "command") : "",
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? `${items.length} tools`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export function ExperimentalToolGroup({ items, children }: { items: TranscriptItem[]; children: ReactNode }) {
  const isRunning = items.some((item) => item.status === "running");
  // Running groups default open so the operator can see live tool cards. A manual
  // close stays local to this mounted component and is intentionally not persisted;
  // a browser refresh remounts the group and opens running activity again.
  const [expanded, setExpanded] = useState(isRunning);
  const duration = formatToolDuration(groupDurationMs(items));
  const summary = summaryText(items);
  const label = isRunning ? "Tools running" : "Task completed";

  return (
    <div
      className={cn(
        "message tool experimental-tool-group group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border border-border bg-muted/45 text-sm text-foreground shadow-none",
        isRunning && "running",
      )}
      data-testid="experimental-tool-group"
      data-tool-count={items.length}
      data-tool-state={isRunning ? "running" : "done"}
    >
      <button
        type="button"
        className="flex h-7 w-full min-w-0 items-center justify-between gap-2 px-2.5 text-left text-xs text-muted-foreground hover:bg-muted/45 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-row-action="toggle-tool-group"
      >
        <span className="min-w-0 truncate">{label} · {summary}{duration ? ` · ${duration}` : ""}</span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="border-t border-border bg-background py-1" data-testid="experimental-tool-group-items">
          {children}
        </div>
      )}
    </div>
  );
}
