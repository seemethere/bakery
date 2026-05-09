import { LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isRecord } from "@/lib/transcript";
import type { TranscriptItem } from "@/lib/transcript";

// ---- Helpers (ported from transcript-subagent-card.ts) ----------------------

function pathBasename(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function compactNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" ? String(part.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
}

function firstUsefulLine(text: string, fallback = "No text output"): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? fallback;
  return line.length > 180 ? `${line.slice(0, 177).trimEnd()}…` : line;
}

function stripLeadingDirectives(text: string): string {
  let next = text;
  while (/^\s*\[(?:Write to|Read from):\s*[^\]]+?\]\s*/i.test(next))
    next = next.replace(/^\s*\[(?:Write to|Read from):\s*[^\]]+?\]\s*/i, "");
  return next.trim();
}

function taskActivity(text: string): string {
  const match = /^\s*\[(Write to|Read from):\s*([^\]]+?)\]\s*/i.exec(text);
  if (match) {
    const verb = /^write/i.test(match[1] ?? "") ? "Writing" : "Reading";
    const label = pathBasename((match[2] ?? "").trim()) || (match[2] ?? "").trim();
    return label ? `${verb} ${label}` : "";
  }
  return firstUsefulLine(stripLeadingDirectives(text), "");
}

function subagentRawEventFrom(raw: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(raw) || depth > 3) return null;
  const toolName = String(raw.toolName ?? raw.name ?? "");
  if (toolName === "subagent") return raw;
  return subagentRawEventFrom(raw.toolResult, depth + 1)
    ?? subagentRawEventFrom(raw.duplicateResult, depth + 1)
    ?? subagentRawEventFrom(raw.previous, depth + 1);
}

function subagentRawEvent(item: TranscriptItem): Record<string, unknown> | null {
  if (item.kind !== "tool") return null;
  return subagentRawEventFrom(item.raw);
}

function subagentRawResult(item: TranscriptItem): Record<string, unknown> | null {
  const raw = subagentRawEvent(item);
  if (!raw) return null;
  return isRecord(raw.result) ? raw.result : isRecord(raw.partialResult) ? raw.partialResult : raw;
}

function subagentDetails(item: TranscriptItem): Record<string, unknown> | null {
  const result = subagentRawResult(item);
  const raw = subagentRawEvent(item) ?? {};
  const details = isRecord(result?.details) ? result.details : isRecord(raw.details) ? raw.details : null;
  if (!details) return null;
  if (typeof details.mode === "string" || Array.isArray(details.progress) || Array.isArray(details.results)) return details;
  return null;
}

function progressRows(details: Record<string, unknown> | null): Record<string, unknown>[] {
  return Array.isArray(details?.progress) ? details.progress.filter(isRecord) : [];
}

function resultRows(details: Record<string, unknown> | null): Record<string, unknown>[] {
  return Array.isArray(details?.results) ? details.results.filter(isRecord) : [];
}

function isManagementCall(item: TranscriptItem, details: Record<string, unknown> | null): boolean {
  if (typeof details?.mode === "string" && details.mode.trim().toLowerCase() === "management") return true;
  const raw = subagentRawEvent(item);
  if (!raw) return false;
  const args = isRecord(raw.args) ? raw.args : raw;
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "doctor"].includes(action);
}

function visibleText(item: TranscriptItem, result: Record<string, unknown> | null = subagentRawResult(item)): string {
  return (item.body || textFromContent(result?.content)).trim();
}

function isFailureText(text: string): boolean {
  return /^(?:failed|error|cancelled|canceled)(?:\.|:|$)/i.test(text.trim());
}

export function isNonInformativeSubagentManagementReceipt(item: TranscriptItem): boolean {
  if (item.status === "running" || item.status === "error") return false;
  const result = subagentRawResult(item);
  if (!result) return false;
  const details = subagentDetails(item);
  if (!isManagementCall(item, details)) return false;
  if (progressRows(details).length > 0 || resultRows(details).length > 0) return false;
  const text = visibleText(item, result).trim().replace(/\s+/g, " ").toLowerCase();
  return text === "" || text === "executable agents:" || text === "executable agents" || text.startsWith("executable agents: - ");
}

export function hasSubagentCard(item: TranscriptItem): boolean {
  const result = subagentRawResult(item);
  if (!result) return false;
  const details = subagentDetails(item);
  if (progressRows(details).length > 0 || resultRows(details).length > 0) return true;
  if (isManagementCall(item, details)) return false;
  if (item.status === "running" || item.status === "error") return true;
  return isFailureText(visibleText(item, result));
}

function resolveStatus(details: Record<string, unknown> | null, item: TranscriptItem): "running" | "completed" | "failed" | "paused" | "detached" {
  if (item.status === "running") return "running";
  const result = subagentRawResult(item);
  const results = resultRows(details);
  if (results.some((r) => r.interrupted === true)) return "paused";
  if (results.some((r) => r.detached === true)) return "detached";
  if (item.status === "error" || results.some((r) => typeof r.exitCode === "number" && r.exitCode !== 0) || isFailureText(visibleText(item, result))) return "failed";
  return "completed";
}

function statusGlyph(status: string): string {
  if (status === "running") return "⠋";
  if (status === "completed" || status === "complete") return "✓";
  if (status === "failed") return "✗";
  if (status === "paused" || status === "detached") return "■";
  return "◦";
}

function runningFallback(entry: Record<string, unknown>): string {
  const agent = String(entry.agent ?? "").trim().toLowerCase();
  if (agent === "scout" || agent === "context-builder") return "Scanning codebase…";
  if (agent === "planner" || agent === "planning") return "Drafting implementation plan…";
  if (agent === "oracle" || agent === "reviewer") return "Reviewing…";
  if (agent === "worker" || agent === "delegate") return "Applying changes…";
  return "Working…";
}

function agentActivity(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof entry.currentTool === "string" && entry.currentTool) parts.push(entry.currentTool);
  if (typeof entry.currentPath === "string" && entry.currentPath) parts.push(pathBasename(entry.currentPath));
  if (typeof entry.activityState === "string" && entry.activityState) parts.push(entry.activityState.replaceAll("_", " "));
  if (parts.length > 0) return parts.join(" · ");
  if (entry.status === "running") return runningFallback(entry);
  return "";
}

function fallbackAgent(raw: Record<string, unknown>, details: Record<string, unknown> | null, index = 0): string {
  const args = isRecord(raw.args) ? raw.args : {};
  if (typeof args.agent === "string" && args.agent.trim()) return args.agent;
  if (typeof details?.mode === "string" && details.mode.trim().toLowerCase() === "management") return "subagents";
  return index === 0 ? "subagent" : `agent ${index + 1}`;
}

function fallbackTask(raw: Record<string, unknown>): string {
  const args = isRecord(raw.args) ? raw.args : {};
  if (typeof args.task === "string" && args.task.trim()) return taskActivity(args.task);
  if (typeof args.action === "string" && args.action.trim()) return `${args.action} subagents`;
  if (Array.isArray(args.chain)) return `Running ${args.chain.length} chain step${args.chain.length === 1 ? "" : "s"}`;
  if (Array.isArray(args.tasks)) return `Running ${args.tasks.length} parallel task${args.tasks.length === 1 ? "" : "s"}`;
  return "Starting subagent…";
}

function buildStats(details: Record<string, unknown> | null, item: TranscriptItem): string[] {
  const stats: string[] = [];
  const progress = progressRows(details);
  const results = resultRows(details);
  const running = progress.filter((e) => e.status === "running").length;
  const done = progress.filter((e) => e.status === "completed").length || results.filter((r) => typeof r.exitCode !== "number" || r.exitCode === 0).length;
  const total = typeof details?.totalSteps === "number" ? details.totalSteps : Math.max(progress.length, results.length);
  if (item.status === "running" && running > 0) stats.push(`${running} running`);
  if (total > 0) stats.push(`${done}/${total} done`);
  const summary = isRecord(details?.progressSummary) ? details.progressSummary : null;
  const toolCount = summary?.toolCount ?? progress.reduce((s, e) => s + (typeof e.toolCount === "number" ? e.toolCount : 0), 0);
  const tokens = summary?.tokens ?? progress.reduce((s, e) => s + (typeof e.tokens === "number" ? e.tokens : 0), 0);
  const duration = typeof summary?.durationMs === "number" ? summary.durationMs : item.durationMs;
  if (toolCount) stats.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  const tokenText = compactNumber(tokens);
  if (tokenText) stats.push(`${tokenText} tokens`);
  const durationText = formatDuration(duration);
  if (durationText) stats.push(durationText);
  return stats;
}

// ---- Sub-components ---------------------------------------------------------

function StatusGlyph({ status }: { status: string }) {
  return (
    <span className={cn(
      "shrink-0 w-4 text-center font-mono text-xs leading-none mt-0.5",
      status === "running" && "text-blue-400",
      status === "completed" || status === "complete" ? "text-emerald-400" : "",
      status === "failed" && "text-red-400",
      (status === "paused" || status === "detached") && "text-yellow-400",
    )}>
      {statusGlyph(status)}
    </span>
  );
}

function ProgressRow({ entry, index }: { entry: Record<string, unknown>; index: number }) {
  const status = String(entry.status ?? "pending");
  const agent = String(entry.agent ?? `agent ${index + 1}`);
  const activity = agentActivity(entry);
  const task = typeof entry.task === "string" ? taskActivity(entry.task) : "";
  const statParts = [
    typeof entry.toolCount === "number" && entry.toolCount > 0 ? `${entry.toolCount} tools` : "",
    compactNumber(entry.tokens) ? `${compactNumber(entry.tokens)} tokens` : "",
    formatDuration(typeof entry.durationMs === "number" ? entry.durationMs : undefined),
  ].filter(Boolean);

  return (
    <div className="flex items-start gap-2 py-1.5 px-2">
      <StatusGlyph status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
          <strong className="font-medium text-foreground/90">{agent}</strong>
          <span className="text-muted-foreground/60">{status.replaceAll("_", " ")}</span>
          {statParts.length > 0 && <em className="not-italic text-muted-foreground/50">{statParts.join(" · ")}</em>}
        </div>
        {(activity || task) && (
          <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{activity || task}</p>
        )}
      </div>
    </div>
  );
}

function ResultRow({ result, index }: { result: Record<string, unknown>; index: number }) {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  const status = typeof result.status === "string" ? result.status : result.interrupted === true ? "paused" : result.detached === true ? "detached" : exitCode === 0 ? "completed" : "failed";
  const agent = String(result.agent ?? `agent ${index + 1}`);
  const output = typeof result.finalOutput === "string" ? result.finalOutput : textFromContent(result.content);
  const usage = isRecord(result.usage) ? result.usage : null;
  const statParts = [
    typeof result.model === "string" ? result.model : "",
    usage && typeof usage.turns === "number" ? `${usage.turns} turns` : "",
    usage && typeof usage.input === "number" && typeof usage.output === "number"
      ? `${compactNumber(usage.input + usage.output)} tokens` : "",
  ].filter(Boolean);
  const paths = [
    typeof result.savedOutputPath === "string" ? `output: ${pathBasename(result.savedOutputPath) || result.savedOutputPath}` : "",
    typeof result.sessionFile === "string" ? `session: ${pathBasename(result.sessionFile) || result.sessionFile}` : "",
  ].filter(Boolean);
  const preview = firstUsefulLine(output, exitCode === 0 ? "Done" : String(result.error ?? "Failed"));

  return (
    <div className="flex items-start gap-2 py-1.5 px-2">
      <StatusGlyph status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
          <strong className="font-medium text-foreground/90">{agent}</strong>
          <span className="text-muted-foreground/60">{status.replaceAll("_", " ")}</span>
          {statParts.length > 0 && <em className="not-italic text-muted-foreground/50">{statParts.join(" · ")}</em>}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{preview}</p>
        {paths.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {paths.map((p) => <code key={p} className="text-[10px] text-muted-foreground/60 bg-muted/30 px-1 py-0.5 rounded">{p}</code>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Main export ------------------------------------------------------------

export function SubagentCard({ item }: { item: TranscriptItem }) {
  const details = subagentDetails(item);
  const result = subagentRawResult(item);
  const raw = subagentRawEvent(item) ?? {};
  const mode = typeof details?.mode === "string" ? details.mode : "run";
  const status = resolveStatus(details, item);
  const progress = progressRows(details);
  const results = resultRows(details);

  const displayProgress = progress.length > 0 ? progress : (item.status === "running" ? [{ agent: fallbackAgent(raw, details), status: "running", task: fallbackTask(raw), currentTool: fallbackTask(raw) }] : []);
  const displayResults = results.length > 0 ? results : (item.status !== "running" ? [{ agent: fallbackAgent(raw, details), status: status === "failed" ? "failed" : "completed", exitCode: status === "failed" ? 1 : 0, finalOutput: visibleText(item, result) || (item.status === "error" ? "Failed" : "Done") }] : []);
  const rows = item.status === "running" ? displayProgress : displayResults;
  const stats = buildStats(details, item);
  const fallbackText = firstUsefulLine(item.body || textFromContent(result?.content), item.status === "running" ? "Subagent is running…" : "Subagent completed.");

  return (
    <div
      className={cn(
        "mx-4 my-1 rounded-lg border text-sm overflow-hidden",
        status === "running" && "border-blue-500/25 bg-blue-500/5",
        status === "completed" && "border-emerald-500/20 bg-emerald-500/5",
        status === "failed" && "border-red-500/25 bg-red-500/5",
        (status === "paused" || status === "detached") && "border-yellow-500/25 bg-yellow-500/5",
      )}
      data-testid="subagent-card"
      data-subagent-status={status}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/20">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Subagent</span>
          <strong className="text-xs font-medium text-foreground/80">{mode}</strong>
        </div>
        <div className={cn(
          "flex items-center gap-1.5 text-[11px] font-medium",
          status === "running" && "text-blue-400",
          status === "completed" && "text-emerald-400",
          status === "failed" && "text-red-400",
          (status === "paused" || status === "detached") && "text-yellow-400",
        )}>
          {status === "running" && <LoaderCircleIcon className="size-3 animate-spin" />}
          {status}
        </div>
      </div>

      {/* Stats */}
      {stats.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-1.5 border-b border-border/15 text-[11px] text-muted-foreground/60">
          {stats.map((s) => <span key={s}>{s}</span>)}
        </div>
      )}

      {/* Rows */}
      {rows.length > 0 ? (
        <div className="divide-y divide-border/10">
          {item.status === "running"
            ? displayProgress.map((entry, i) => <ProgressRow key={i} entry={entry} index={i} />)
            : displayResults.map((result, i) => <ResultRow key={i} result={result} index={i} />)
          }
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">{fallbackText}</p>
      )}
    </div>
  );
}
