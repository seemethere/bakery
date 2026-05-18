import { useState, type ReactNode } from "react";
import { ChevronDownIcon, LoaderCircleIcon, SquareTerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatToolDuration, isRecord, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function outputText(item: TranscriptItem): string {
  const raw = isRecord(item.raw) ? item.raw : {};
  const result = isRecord(raw.result) ? raw.result : isRecord(raw.partialResult) ? raw.partialResult : null;
  const details = isRecord(result?.details) ? result.details : null;
  const stdout = typeof details?.stdout === "string" ? details.stdout : "";
  const stderr = typeof details?.stderr === "string" ? details.stderr : "";
  const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
  if (combined.trim()) return combined;

  const segmentText = item.segments
    ?.map((segment) => "text" in segment ? segment.text : segment.label)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (segmentText) return segmentText;

  return item.body.trim() && item.body !== "Starting…" ? item.body : "";
}

function exitCode(item: TranscriptItem): number | null {
  const raw = isRecord(item.raw) ? item.raw : {};
  const result = isRecord(raw.result) ? raw.result : null;
  const details = isRecord(result?.details) ? result.details : null;
  return typeof details?.exitCode === "number" ? details.exitCode : null;
}

function commandSummary(command: string): string {
  return command
    .split("|")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .slice(0, 4)
    .join(", ") || "bash";
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

export function ExperimentalBashTool({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const { target } = toolHeaderDisplay(item);
  const command = target || item.title.replace(/^\$\s*/, "") || "bash";
  const output = outputText(item);
  const code = exitCode(item);
  const isRunning = item.status === "running";
  const isError = item.status === "error" || (typeof code === "number" && code !== 0);
  const duration = !isRunning ? formatToolDuration(itemDurationMs(item)) : "";
  const summary = commandSummary(command);
  const header = isRunning ? `Running command: ${summary}` : `Ran command: ${summary}`;
  const expandableOutput = !isRunning && Boolean(output);

  return (
    <div
      role="article"
      aria-label={`Bash command ${isRunning ? "running" : isError ? "failed" : "completed"}: ${command}`}
      className={cn(
        "message tool experimental-bash-tool group/row relative mx-4 my-1 min-w-0 overflow-hidden rounded-[10px] border text-sm",
        "border-border bg-muted/45 text-foreground shadow-none",
        item.status === "running" && "running",
        item.status === "done" && "done",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="experimental-bash-tool"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action="bash"
    >
      <div className="flex h-7 min-w-0 items-center justify-between gap-2 border-b border-border px-2.5">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
          <SquareTerminalIcon className="size-3 shrink-0" aria-hidden="true" />
          {isRunning ? (
            <span className="an-bash-shimmer inline-flex h-full min-w-0 max-w-full items-center truncate leading-none">
              {header}
            </span>
          ) : (
            <span className="block min-w-0 truncate">
              {header}
            </span>
          )}
          {duration && <span className="shrink-0 text-muted-foreground/70">· {duration}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {isRunning && <LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />}
          {actions && <div className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</div>}
          {expandableOutput && (
            <button
              type="button"
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={() => setShowFullOutput((value) => !value)}
              aria-label={showFullOutput ? "Hide command output" : "Show full command output"}
              aria-expanded={showFullOutput}
              data-row-action="toggle-bash-output"
            >
              <ChevronDownIcon className={cn("size-3 transition-transform", showFullOutput && "rotate-180")} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="min-w-0 overflow-hidden bg-background px-2.5 py-1.5 font-mono text-[12px] leading-4" aria-live={isRunning ? "polite" : undefined}>
        <div className="break-all">
          <span className="select-none text-amber-600 dark:text-amber-400">$ </span>
          <span className="text-foreground">{command}</span>
        </div>
        {output && !isRunning && showFullOutput && (
          <pre
            className="mt-1 whitespace-pre-line break-words text-muted-foreground"
            tabIndex={0}
            role="region"
            aria-label="Command output"
            data-output-expanded="true"
          >{output}</pre>
        )}
        {!output && isRunning && <span className="sr-only" role="status">Waiting for command output…</span>}
      </div>

    </div>
  );
}
