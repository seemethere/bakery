import type { ReactNode } from "react";
import { CircleStopIcon, FilePenLineIcon, FilePlus2Icon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactToolSummary, isRecord, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function fileExt(path: string): string {
  const name = basename(path);
  const ext = /\.([^.]+)$/.exec(name)?.[1];
  return (ext || "file").slice(0, 3).toUpperCase();
}

function outputText(item: TranscriptItem): string {
  const raw = isRecord(item.raw) ? item.raw : {};
  const result = isRecord(raw.result) ? raw.result : isRecord(raw.partialResult) ? raw.partialResult : null;
  const details = isRecord(result?.details) ? result.details : null;
  const diff = typeof details?.diff === "string" ? details.diff : "";
  if (diff.trim()) return diff.trim();
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

export function ExperimentalEditTool({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const { action, target } = toolHeaderDisplay(item);
  const path = target || item.title.replace(/^(?:edit|write)\s+/i, "") || "file";
  const name = basename(path);
  const isWrite = action === "write";
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const output = outputText(item);
  const verb = isRunning
    ? isWrite ? "Creating" : "Editing"
    : isError
      ? isWrite ? "Failed creating" : "Failed editing"
      : isWrite ? "Created" : "Edited";
  const Icon = isWrite ? FilePlus2Icon : FilePenLineIcon;

  return (
    <div
      role="article"
      aria-label={`${verb} ${path}`}
      className={cn(
        "message tool experimental-edit-tool group/row relative mx-4 my-1 w-auto max-w-[420px] overflow-hidden rounded-[10px] border text-sm",
        "border-border bg-muted/45 text-foreground shadow-none",
        item.status === "running" && "running",
        item.status === "done" && "done",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="experimental-edit-tool"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action={isWrite ? "write" : "edit"}
    >
      {actions && <div className="absolute right-1.5 top-1 z-[1] opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</div>}
      <div className="flex h-7 min-w-0 items-center justify-between gap-2 border-b border-border px-2.5 pr-8">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span className="grid size-3 shrink-0 place-items-center text-[8px] font-semibold leading-none text-blue-500 dark:text-blue-300" aria-hidden="true">
            {fileExt(name)}
          </span>
          {isRunning ? (
            <span className="an-bash-shimmer inline-flex h-full max-w-full items-center truncate text-xs leading-none text-muted-foreground">
              {verb} {name}
            </span>
          ) : (
            <span className={cn("block truncate text-xs", isError ? "text-red-400" : "text-muted-foreground")}>
              {verb} {name}
            </span>
          )}
        </div>
        {isRunning ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : isError ? <CircleStopIcon className="size-3 shrink-0 text-red-400" aria-hidden="true" /> : <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
      </div>
      {output && !isRunning && (
        <div className="min-w-0 bg-background px-2.5 py-1.5 font-mono text-[12px] leading-4">
          <pre className="max-h-20 overflow-hidden whitespace-pre-line break-words text-muted-foreground" tabIndex={0} role="region" aria-label="Edit output">{output}</pre>
        </div>
      )}
    </div>
  );
}
