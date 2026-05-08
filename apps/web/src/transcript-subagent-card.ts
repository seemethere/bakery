import type { TranscriptItem } from "./transcript";
import { escapeHtml, isRecord, pathBasename } from "./utils";

function formatSubagentDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 10_000) return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
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
  const result = isRecord(raw.result) ? raw.result : isRecord(raw.partialResult) ? raw.partialResult : raw;
  return result;
}

function subagentDetails(item: TranscriptItem): Record<string, unknown> | null {
  const result = subagentRawResult(item);
  const raw = subagentRawEvent(item) ?? {};
  const details = isRecord(result?.details) ? result.details : isRecord(raw.details) ? raw.details : null;
  if (!details) return null;
  if (typeof details.mode === "string" || Array.isArray(details.progress) || Array.isArray(details.results)) return details;
  return null;
}

function subagentProgressRows(details: Record<string, unknown> | null): Record<string, unknown>[] {
  return Array.isArray(details?.progress) ? details.progress.filter(isRecord) : [];
}

function subagentResultRows(details: Record<string, unknown> | null): Record<string, unknown>[] {
  return Array.isArray(details?.results) ? details.results.filter(isRecord) : [];
}

function isKnownSubagentManagementMode(details: Record<string, unknown> | null): boolean {
  return typeof details?.mode === "string" && details.mode.trim().toLowerCase() === "management";
}

function isSubagentManagementCall(item: TranscriptItem, details: Record<string, unknown> | null): boolean {
  if (isKnownSubagentManagementMode(details)) return true;
  const raw = subagentRawEvent(item);
  if (!raw) return false;
  const args = isRecord(raw.args) ? raw.args : raw;
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  return ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "doctor"].includes(action);
}

function visibleSubagentText(item: TranscriptItem, result: Record<string, unknown> | null = subagentRawResult(item)): string {
  return (item.body || textFromSubagentContent(result?.content)).trim();
}

function isLowInformationSubagentManagementText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "" || normalized === "executable agents:" || normalized === "executable agents" || normalized.startsWith("executable agents: - ");
}

export function isNonInformativeSubagentManagementReceipt(item: TranscriptItem): boolean {
  if (item.status === "running" || item.status === "error") return false;
  const result = subagentRawResult(item);
  if (!result) return false;
  const details = subagentDetails(item);
  if (!isSubagentManagementCall(item, details)) return false;
  if (subagentProgressRows(details).length > 0 || subagentResultRows(details).length > 0) return false;
  return isLowInformationSubagentManagementText(visibleSubagentText(item, result));
}

function isSubagentFailureText(text: string): boolean {
  return /^(?:failed|error|cancelled|canceled)(?:\.|:|$)/i.test(text.trim());
}

export function hasSubagentCard(item: TranscriptItem): boolean {
  const result = subagentRawResult(item);
  if (!result) return false;
  const details = subagentDetails(item);
  if (subagentProgressRows(details).length > 0 || subagentResultRows(details).length > 0) return true;
  if (isSubagentManagementCall(item, details)) return false;
  if (item.status === "running" || item.status === "error") return true;
  return isSubagentFailureText(visibleSubagentText(item, result));
}

function subagentStatus(details: Record<string, unknown> | null, item: TranscriptItem): "running" | "completed" | "failed" | "paused" | "detached" {
  if (item.status === "running") return "running";
  const result = subagentRawResult(item);
  const results = subagentResultRows(details);
  if (results.some((result) => result.interrupted === true)) return "paused";
  if (results.some((result) => result.detached === true)) return "detached";
  if (item.status === "error" || results.some((result) => typeof result.exitCode === "number" && result.exitCode !== 0) || isSubagentFailureText(visibleSubagentText(item, result))) return "failed";
  return "completed";
}

function statusGlyph(status: string): string {
  if (status === "running") return "⠋";
  if (status === "completed" || status === "complete") return "✓";
  if (status === "failed") return "✗";
  if (status === "paused" || status === "detached") return "■";
  return "◦";
}

function compactNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function textFromSubagentContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" ? String(part.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
}

function firstUsefulLine(text: string, fallback = "No text output"): string {
  const line = text.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) ?? fallback;
  return line.length > 180 ? `${line.slice(0, 177).trimEnd()}…` : line;
}

type SubagentDirective = { verb: "write" | "read"; path: string };

function subagentLeadingDirective(text: string): SubagentDirective | null {
  const match = /^\s*\[(Write to|Read from):\s*([^\]]+?)\]\s*/i.exec(text);
  if (!match) return null;
  return { verb: /^write/i.test(match[1] ?? "") ? "write" : "read", path: (match[2] ?? "").trim() };
}

function stripSubagentLeadingDirectives(text: string): string {
  let next = text;
  while (/^\s*\[(?:Write to|Read from):\s*[^\]]+?\]\s*/i.test(next)) {
    next = next.replace(/^\s*\[(?:Write to|Read from):\s*[^\]]+?\]\s*/i, "");
  }
  return next.trim();
}

function subagentPathLabel(path: string): string {
  return pathBasename(path) || path;
}

function subagentDirectiveActivity(directive: SubagentDirective | null): string {
  if (!directive) return "";
  const label = subagentPathLabel(directive.path);
  if (!label) return "";
  return `${directive.verb === "write" ? "Writing" : "Reading"} ${label}`;
}

function subagentTaskActivity(text: string): string {
  const directive = subagentLeadingDirective(text);
  const directiveActivity = subagentDirectiveActivity(directive);
  if (directiveActivity) return directiveActivity;
  return firstUsefulLine(stripSubagentLeadingDirectives(text), "");
}

function compactSubagentPath(kind: string, path: string): string {
  const label = subagentPathLabel(path);
  return label ? `${kind}: ${label}` : kind;
}

function subagentRunningFallback(entry: Record<string, unknown>): string {
  const agent = String(entry.agent ?? "").trim().toLowerCase();
  if (agent === "scout" || agent === "context-builder") return "Scanning codebase…";
  if (agent === "planner" || agent === "planning") return "Drafting implementation plan…";
  if (agent === "oracle" || agent === "reviewer") return "Reviewing…";
  if (agent === "worker" || agent === "delegate") return "Applying changes…";
  return "Working…";
}

function subagentStats(details: Record<string, unknown> | null, item: TranscriptItem): string[] {
  const stats: string[] = [];
  const progress = subagentProgressRows(details);
  const results = subagentResultRows(details);
  const running = progress.filter((entry) => entry.status === "running").length;
  const done = progress.filter((entry) => entry.status === "completed").length || results.filter((entry) => typeof entry.exitCode !== "number" || entry.exitCode === 0).length;
  const total = typeof details?.totalSteps === "number" ? details.totalSteps : Math.max(progress.length, results.length);
  if (item.status === "running" && running > 0) stats.push(`${running} running`);
  if (total > 0) stats.push(`${done}/${total} done`);
  const summary = isRecord(details?.progressSummary) ? details.progressSummary : null;
  const toolCount = summary?.toolCount ?? progress.reduce((sum, entry) => sum + (typeof entry.toolCount === "number" ? entry.toolCount : 0), 0);
  const tokens = summary?.tokens ?? progress.reduce((sum, entry) => sum + (typeof entry.tokens === "number" ? entry.tokens : 0), 0);
  const duration = typeof summary?.durationMs === "number" ? summary.durationMs : item.durationMs;
  if (toolCount) stats.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
  const tokenText = compactNumber(tokens);
  if (tokenText) stats.push(`${tokenText} tokens`);
  const durationText = formatSubagentDuration(duration);
  if (durationText) stats.push(durationText);
  return stats;
}

function subagentActivity(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof entry.currentTool === "string" && entry.currentTool) parts.push(entry.currentTool);
  if (typeof entry.currentPath === "string" && entry.currentPath) parts.push(pathBasename(entry.currentPath));
  if (typeof entry.activityState === "string" && entry.activityState) parts.push(entry.activityState.replaceAll("_", " "));
  if (parts.length > 0) return parts.join(" · ");
  if (entry.status === "running") return subagentRunningFallback(entry);
  return "";
}

function subagentStatusClass(status: string): string {
  if (status === "running" || status === "completed" || status === "complete" || status === "failed" || status === "paused" || status === "detached" || status === "pending") return status;
  return "pending";
}

function renderSubagentProgressRows(progress: Record<string, unknown>[]): string {
  if (progress.length === 0) return "";
  return `<div class="subagent-card-rows">${progress.map((entry, index) => {
    const status = String(entry.status ?? "pending");
    const agent = String(entry.agent ?? `agent ${index + 1}`);
    const activity = subagentActivity(entry);
    const task = typeof entry.task === "string" ? subagentTaskActivity(entry.task) : "";
    const stats = [typeof entry.toolCount === "number" && entry.toolCount > 0 ? `${entry.toolCount} tools` : "", compactNumber(entry.tokens) ? `${compactNumber(entry.tokens)} tokens` : "", formatSubagentDuration(typeof entry.durationMs === "number" ? entry.durationMs : undefined)].filter(Boolean).join(" · ");
    return `<div class="subagent-result-row ${subagentStatusClass(status)}">
      <span class="subagent-status-glyph" aria-hidden="true">${escapeHtml(statusGlyph(status))}</span>
      <div class="subagent-result-main">
        <div class="subagent-result-title"><strong>${escapeHtml(agent)}</strong><span>${escapeHtml(status.replaceAll("_", " "))}</span>${stats ? `<em>${escapeHtml(stats)}</em>` : ""}</div>
        ${activity ? `<div class="subagent-activity">${escapeHtml(activity)}</div>` : task ? `<div class="subagent-activity">${escapeHtml(task)}</div>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function renderSubagentResultRows(results: Record<string, unknown>[]): string {
  if (results.length === 0) return "";
  return `<div class="subagent-card-rows">${results.map((result, index) => {
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
    const status = typeof result.status === "string" ? result.status : result.interrupted === true ? "paused" : result.detached === true ? "detached" : exitCode === 0 ? "completed" : "failed";
    const agent = String(result.agent ?? `agent ${index + 1}`);
    const output = typeof result.finalOutput === "string" ? result.finalOutput : textFromSubagentContent(result.content);
    const usage = isRecord(result.usage) ? result.usage : null;
    const stats = [typeof result.model === "string" ? result.model : "", usage && typeof usage.turns === "number" ? `${usage.turns} turns` : "", usage && typeof usage.input === "number" && typeof usage.output === "number" ? `${compactNumber(usage.input + usage.output)} tokens` : ""].filter(Boolean).join(" · ");
    const paths = [typeof result.savedOutputPath === "string" ? compactSubagentPath("output", result.savedOutputPath) : "", typeof result.sessionFile === "string" ? compactSubagentPath("session", result.sessionFile) : ""].filter(Boolean);
    return `<div class="subagent-result-row ${subagentStatusClass(status)}">
      <span class="subagent-status-glyph" aria-hidden="true">${escapeHtml(statusGlyph(status))}</span>
      <div class="subagent-result-main">
        <div class="subagent-result-title"><strong>${escapeHtml(agent)}</strong><span>${escapeHtml(status.replaceAll("_", " "))}</span>${stats ? `<em>${escapeHtml(stats)}</em>` : ""}</div>
        <div class="subagent-output-preview">${escapeHtml(firstUsefulLine(output, exitCode === 0 ? "Done" : String(result.error ?? "Failed")))}</div>
        ${paths.length ? `<div class="subagent-paths">${paths.map((entry) => `<code>${escapeHtml(entry)}</code>`).join("")}</div>` : ""}
      </div>
    </div>`;
  }).join("")}</div>`;
}

function subagentFallbackAgent(raw: Record<string, unknown>, details: Record<string, unknown> | null, index = 0): string {
  const args = isRecord(raw.args) ? raw.args : {};
  if (typeof args.agent === "string" && args.agent.trim()) return args.agent;
  if (typeof details?.mode === "string" && details.mode.trim().toLowerCase() === "management") return "subagents";
  return index === 0 ? "subagent" : `agent ${index + 1}`;
}

function subagentFallbackTask(raw: Record<string, unknown>): string {
  const args = isRecord(raw.args) ? raw.args : {};
  if (typeof args.task === "string" && args.task.trim()) return subagentTaskActivity(args.task);
  if (typeof args.action === "string" && args.action.trim()) return `${args.action} subagents`;
  if (Array.isArray(args.chain)) return `Running ${args.chain.length} chain step${args.chain.length === 1 ? "" : "s"}`;
  if (Array.isArray(args.tasks)) return `Running ${args.tasks.length} parallel task${args.tasks.length === 1 ? "" : "s"}`;
  return "Starting subagent…";
}

function fallbackSubagentProgressRows(item: TranscriptItem, details: Record<string, unknown> | null): Record<string, unknown>[] {
  const raw = subagentRawEvent(item);
  if (item.status !== "running" || !raw) return [];
  const task = subagentFallbackTask(raw);
  return [{ agent: subagentFallbackAgent(raw, details), status: "running", task, currentTool: task }];
}

function fallbackSubagentResultRows(item: TranscriptItem, details: Record<string, unknown> | null, result: Record<string, unknown> | null): Record<string, unknown>[] {
  const raw = subagentRawEvent(item);
  if (item.status === "running" || !raw) return [];
  const output = visibleSubagentText(item, result) || (item.status === "error" ? "Failed" : "Done");
  const failed = item.status === "error" || isSubagentFailureText(output);
  return [{ agent: subagentFallbackAgent(raw, details), status: failed ? "failed" : "completed", exitCode: failed ? 1 : 0, finalOutput: output }];
}

export function renderSubagentCard(item: TranscriptItem): string {
  const details = subagentDetails(item);
  const result = subagentRawResult(item);
  const mode = typeof details?.mode === "string" ? details.mode : "run";
  const status = subagentStatus(details, item);
  const progress = subagentProgressRows(details);
  const results = subagentResultRows(details);
  const displayProgress = progress.length > 0 ? progress : fallbackSubagentProgressRows(item, details);
  const displayResults = results.length > 0 ? results : fallbackSubagentResultRows(item, details, result);
  const stats = subagentStats(details, item);
  const renderedRows = item.status === "running" ? displayProgress : displayResults;
  const fallback = firstUsefulLine(item.body || textFromSubagentContent(result?.content), item.status === "running" ? "Subagent is running…" : "Subagent completed.");
  return `<article class="subagent-card ${subagentStatusClass(status)}" aria-label="Subagent ${escapeHtml(status)}">
    <div class="subagent-card-header">
      <div>
        <span class="subagent-card-kicker">Subagent</span>
        <strong>${escapeHtml(mode)}</strong>
      </div>
      <span class="subagent-status-chip">${status === "running" ? `<span class="subagent-card-spinner" aria-hidden="true"></span>` : ""}${escapeHtml(status)}</span>
    </div>
    ${stats.length ? `<div class="subagent-card-stats">${stats.map((stat) => `<span>${escapeHtml(stat)}</span>`).join("")}</div>` : ""}
    ${item.status === "running" ? renderSubagentProgressRows(displayProgress) : renderSubagentResultRows(displayResults)}
    ${renderedRows.length === 0 ? `<div class="subagent-output-preview">${escapeHtml(fallback)}</div>` : ""}
  </article>`;
}

