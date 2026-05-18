import { useState, type ReactNode } from "react";
import { ChevronDownIcon, CircleStopIcon, EyeIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactToolSummary, formatToolDuration, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
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

function itemDurationMs(item: TranscriptItem): number | undefined {
  if (typeof item.durationMs === "number") return item.durationMs;
  const raw = item.raw && typeof item.raw === "object" && !Array.isArray(item.raw) ? item.raw as Record<string, unknown> : {};
  const startedAt = item.startedAt ?? (typeof raw.startedAt === "string" ? raw.startedAt : undefined);
  const endedAt = item.endedAt ?? (typeof raw.endedAt === "string" ? raw.endedAt : undefined);
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function outputSummary(output: string): string {
  const lineCount = output.split(/\r?\n/).filter((line) => line.trim()).length;
  if (lineCount > 1) return `${lineCount} lines`;
  return output.length > 0 ? `${output.length} chars` : "";
}

export function ReadToolCard({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const { target } = toolHeaderDisplay(item);
  const path = target || item.title.replace(/^read\s+/i, "") || "file";
  const name = basename(path);
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const duration = !isRunning ? formatToolDuration(itemDurationMs(item)) : "";
  const output = outputText(item);
  const expandableOutput = !isRunning && Boolean(output);
  const verb = isRunning ? "Reading" : isError ? "Failed reading" : "Read";
  const summary = !isRunning && output ? outputSummary(output) : "";

  return (
    <div
      role="article"
      aria-label={`${verb} ${path}`}
      className={cn(
        "message tool tool-card-read group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border text-sm",
        "border-border bg-muted/45 text-foreground shadow-none",
        item.status === "running" && "running",
        item.status === "done" && "done",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="tool-card-read"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action="read"
    >
      <div className="flex h-7 min-w-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <EyeIcon className="size-3 shrink-0" aria-hidden="true" />
          {isRunning ? (
            <span className="an-bash-shimmer inline-flex h-full min-w-0 max-w-full items-center truncate leading-none">
              Reading {name}
            </span>
          ) : (
            <span className={cn("block min-w-0 truncate", isError && "text-red-400")}>
              {verb} {name}
            </span>
          )}
          {summary && <span className="shrink-0 text-muted-foreground/70">· {summary}</span>}
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
              aria-label={showFullOutput ? "Hide read output" : "Show full read output"}
              aria-expanded={showFullOutput}
              data-row-action="toggle-read-output"
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
            aria-label="Read output"
            data-output-expanded="true"
          >{output}</pre>
        </div>
      )}

    </div>
  );
}
