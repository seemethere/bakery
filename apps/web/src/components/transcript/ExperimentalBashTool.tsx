import type { ReactNode } from "react";
import { CheckCircle2Icon, CircleStopIcon, LoaderCircleIcon, TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { compactToolSummary, formatToolDuration, isRecord, type TranscriptItem, toolHeaderDisplay } from "@/lib/transcript";

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

export function ExperimentalBashTool({ item, actions }: { item: TranscriptItem; actions?: ReactNode }) {
  const { target } = toolHeaderDisplay(item);
  const command = target || item.title || "bash";
  const output = outputText(item);
  const duration = formatToolDuration(item.durationMs);
  const code = exitCode(item);
  const isRunning = item.status === "running";
  const isError = item.status === "error" || (typeof code === "number" && code !== 0);
  const summary = !output && !isRunning ? compactToolSummary(item) : "";

  return (
    <div
      role="article"
      aria-label={`Bash command ${isRunning ? "running" : isError ? "failed" : "completed"}: ${command}`}
      className={cn(
        "message tool experimental-bash-tool group/row relative mx-4 my-2 min-w-0 overflow-hidden rounded-xl border bg-card/70 text-sm shadow-sm",
        item.status === "running" && "running border-amber-400/30",
        item.status === "done" && "done border-border/50",
        isError && "error border-red-500/35 bg-red-500/5",
      )}
      data-testid="experimental-bash-tool"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-tool-action="bash"
    >
      {actions && <div className="absolute right-2 top-2 z-[1] opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</div>}
      <div className="grid min-w-0 gap-2 border-b border-border/40 bg-muted/20 px-3 py-2.5 pr-10 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md border",
            isError ? "border-red-500/30 bg-red-500/10 text-red-400" : isRunning ? "border-amber-400/30 bg-amber-400/10 text-amber-300" : "border-border/60 bg-background/70 text-muted-foreground",
          )}>
            {isRunning ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : isError ? <CircleStopIcon className="size-3.5" /> : <TerminalIcon className="size-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <strong className="shrink-0 text-xs font-semibold uppercase tracking-wide text-amber-300">Bash</strong>
              {isRunning && <span className="text-xs text-amber-300/70">running…</span>}
              {!isRunning && <span className={cn("inline-flex items-center gap-1 text-xs", isError ? "text-red-400" : "text-muted-foreground/70")}>
                {!isError && <CheckCircle2Icon className="size-3" />}
                {isError ? "failed" : "completed"}
              </span>}
            </div>
          </div>
        </div>
        <code className="min-w-0 truncate rounded-md bg-background/70 px-2 py-1 font-mono text-xs text-foreground/90" title={command}>{command}</code>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground/70">
          {typeof code === "number" && <span>exit {code}</span>}
          {duration && !isRunning && <span>{duration}</span>}
        </div>
      </div>
      {(output || summary || isRunning) && (
        <div className="min-w-0 bg-[#0d0f12] px-3 py-3 text-[12px] leading-relaxed text-slate-100 dark:bg-black/40" aria-live={isRunning ? "polite" : undefined}>
          {output ? (
            <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-mono" tabIndex={0} role="region" aria-label="Command output">{output}</pre>
          ) : isRunning ? (
            <div className="font-mono text-slate-400" role="status">Waiting for command output…</div>
          ) : (
            <div className="truncate font-mono text-slate-400">{summary}</div>
          )}
        </div>
      )}
    </div>
  );
}
