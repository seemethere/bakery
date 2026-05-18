import { useState, type ReactNode } from "react";
import { ChevronDownIcon, CircleStopIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactToolSummary, formatToolDuration, isRecord, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function fileExt(path: string): string {
  const name = basename(path);
  const ext = /\.([^.]+)$/.exec(name)?.[1];
  return (ext || "file").slice(0, 3).toUpperCase();
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

export function EditToolCard({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const { action, target } = toolHeaderDisplay(item);
  const path = target || item.title.replace(/^(?:edit|write)\s+/i, "") || "file";
  const name = basename(path);
  const isWrite = action === "write";
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const duration = !isRunning ? formatToolDuration(itemDurationMs(item)) : "";
  const output = outputText(item);
  const expandableOutput = !isRunning && Boolean(output);
  const verb = isRunning
    ? isWrite ? "Creating" : "Editing"
    : isError
      ? isWrite ? "Failed creating" : "Failed editing"
      : isWrite ? "Created" : "Edited";

  return (
    <div
      role="article"
      aria-label={`${verb} ${path}`}
      className={cn(
        "message tool tool-card-edit group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border text-sm",
        "border-border bg-muted/45 text-foreground shadow-none",
        item.status === "running" && "running",
        item.status === "done" && "done",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="tool-card-edit"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action={isWrite ? "write" : "edit"}
    >
      <div className="flex h-7 min-w-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <span className="grid size-3 shrink-0 place-items-center text-[8px] font-semibold leading-none text-blue-500 dark:text-blue-300" aria-hidden="true">
            {fileExt(name)}
          </span>
          {isRunning ? (
            <span className="an-bash-shimmer inline-flex h-full min-w-0 max-w-full items-center truncate leading-none">
              {verb} {name}
            </span>
          ) : (
            <span className={cn("block min-w-0 truncate", isError && "text-red-400")}>
              {verb} {name}
            </span>
          )}
          {duration && <span className="shrink-0 text-muted-foreground/70">· {duration}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {actions && <div className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</div>}
          {isRunning ? <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" /> : isError ? <CircleStopIcon className="size-3 text-red-400" aria-hidden="true" /> : null}
          {expandableOutput && (
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={() => setShowFullOutput((value) => !value)}
              aria-label={showFullOutput ? "Hide edit output" : "Show full edit output"}
              aria-expanded={showFullOutput}
              data-row-action="toggle-edit-output"
            >
              <ChevronDownIcon className={cn("size-3 transition-transform", showFullOutput && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {output && !isRunning && showFullOutput && (
        <div className="min-w-0 bg-background px-2.5 py-1.5 font-mono text-[12px] leading-4">
          <pre className="whitespace-pre-line break-words text-muted-foreground" tabIndex={0} role="region" aria-label="Edit output" data-output-expanded="true">{output}</pre>
        </div>
      )}
    </div>
  );
}
