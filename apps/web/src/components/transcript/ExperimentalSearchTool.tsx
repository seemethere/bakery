import { useState, type ReactNode } from "react";
import { ChevronDownIcon, CircleStopIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactToolSummary, formatToolDuration, isRecord, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function outputText(item: TranscriptItem): string {
  const segmentText = item.segments
    ?.map((segment) => "text" in segment ? segment.text : segment.label)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (segmentText) return segmentText;
  const summary = compactToolSummary(item);
  if (summary) return summary;
  return item.body.trim() && item.body !== "Starting…" ? item.body : "";
}

function itemDurationMs(item: TranscriptItem): number | undefined {
  if (typeof item.durationMs === "number") return item.durationMs;
  const raw = isRecord(item.raw) ? item.raw : {};
  const startedAt = item.startedAt ?? (typeof raw.startedAt === "string" ? raw.startedAt : undefined);
  const endedAt = item.endedAt ?? (typeof raw.endedAt === "string" ? raw.endedAt : undefined);
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function resultCount(output: string): string {
  if (!output.trim()) return "";
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const noMatches = lines.some((line) => /^no matches\b/i.test(line));
  if (noMatches || lines.length === 0) return "No matches";
  return `${lines.length} ${lines.length === 1 ? "result" : "results"}`;
}

export function ExperimentalSearchTool({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const { action, target } = toolHeaderDisplay(item);
  const isFind = action === "find";
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const output = outputText(item);
  const duration = !isRunning ? formatToolDuration(itemDurationMs(item)) : "";
  const count = !isRunning ? resultCount(output) : "";
  const expandableOutput = !isRunning && Boolean(output);
  const verb = isRunning ? "Searching" : isError ? "Search failed" : isFind ? "Found" : "Searched";
  const label = target || (isFind ? "files" : "workspace");

  return (
    <div
      role="article"
      aria-label={`${verb} ${label}`}
      className={cn(
        "message tool experimental-search-tool group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border text-sm",
        "border-border bg-muted/45 text-foreground shadow-none",
        item.status === "running" && "running",
        item.status === "done" && "done",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="experimental-search-tool"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action={isFind ? "find" : "grep"}
    >
      <div className="flex h-7 min-w-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <SearchIcon className="size-3 shrink-0" aria-hidden="true" />
          {isRunning ? (
            <span className="an-bash-shimmer inline-flex h-full min-w-0 max-w-full items-center truncate leading-none">
              Searching {label}
            </span>
          ) : (
            <span className={cn("block min-w-0 truncate", isError && "text-red-400")}>
              {verb} {label}
            </span>
          )}
          {count && <span className="shrink-0 text-muted-foreground/70">· {count}</span>}
          {duration && <span className="shrink-0 text-muted-foreground/70">· {duration}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {isRunning ? <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" /> : isError ? <CircleStopIcon className="size-3 text-red-400" aria-hidden="true" /> : null}
          {actions && <div className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</div>}
          {expandableOutput && (
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={() => setShowFullOutput((value) => !value)}
              aria-label={showFullOutput ? "Hide search output" : "Show full search output"}
              aria-expanded={showFullOutput}
              data-row-action="toggle-search-output"
            >
              <ChevronDownIcon className={cn("size-3 transition-transform", showFullOutput && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {output && !isRunning && showFullOutput && (
        <div className="min-w-0 bg-background px-2.5 py-1.5 font-mono text-[12px] leading-4">
          <pre
            className="whitespace-pre-line break-words text-muted-foreground"
            tabIndex={0}
            role="region"
            aria-label="Search output"
            data-output-expanded="true"
          >{output}</pre>
        </div>
      )}

    </div>
  );
}
