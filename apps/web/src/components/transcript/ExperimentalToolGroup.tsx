import { useMemo, useState } from "react";
import { ChevronDownIcon, EyeIcon, FilePenLineIcon, FilePlus2Icon, SearchIcon, SquareTerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatToolDuration, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

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

function rowLabel(item: TranscriptItem): { label: string; detail: string; icon: typeof SquareTerminalIcon } {
  const { action, target } = toolHeaderDisplay(item);
  if (action === "bash") return { label: "Ran command", detail: target.split(/\s+/)[0] || "bash", icon: SquareTerminalIcon };
  if (action === "read") return { label: "Read", detail: basename(target || "file"), icon: EyeIcon };
  if (action === "edit") return { label: "Edited", detail: basename(target || "file"), icon: FilePenLineIcon };
  if (action === "write") return { label: "Created", detail: basename(target || "file"), icon: FilePlus2Icon };
  if (action === "find") return { label: "Found", detail: target || "files", icon: SearchIcon };
  return { label: "Searched", detail: target || "workspace", icon: SearchIcon };
}

export function ExperimentalToolGroup({ items }: { items: TranscriptItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatToolDuration(groupDurationMs(items));
  const summary = useMemo(() => summaryText(items), [items]);

  return (
    <div
      className="message tool experimental-tool-group group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border border-border bg-muted/45 text-sm text-foreground shadow-none"
      data-testid="experimental-tool-group"
      data-tool-count={items.length}
    >
      <button
        type="button"
        className="flex h-7 w-full min-w-0 items-center justify-between gap-2 px-2.5 text-left text-xs text-muted-foreground hover:bg-muted/45 hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        data-row-action="toggle-tool-group"
      >
        <span className="min-w-0 truncate">Task completed · {summary}{duration ? ` · ${duration}` : ""}</span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="space-y-1 border-t border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="experimental-tool-group-items">
          {items.map((item) => {
            const row = rowLabel(item);
            const Icon = row.icon;
            return (
              <div key={item.id} className="flex min-w-0 items-center gap-1.5">
                <Icon className="size-3 shrink-0" aria-hidden="true" />
                <span className="shrink-0">{row.label}</span>
                <span className="min-w-0 truncate text-muted-foreground/70">{row.detail}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
