import type { SessionMetadataSuggestion, WebSession } from "@pi-web-agent/protocol";
import { escapeHtml, pathBasename, pathParent } from "./utils";

export type MetadataAcceptKind = "both" | "title" | "summary";

export function cleanTitleInput(value: string): string {
  return value.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function isGenericSessionPrompt(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:ok(?:ay)?|sure|sounds good|let'?s do it|go on|continue|next|next up|next thing)(?: please)?$/.test(normalized)) return true;
  if (/^(?:give me (?:a )?sense of )?(?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  if (/^(?:nice|okay|alright|ok) (?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  return false;
}

export function provisionalTitleFromPrompt(value: string): string | null {
  const cleaned = cleanTitleInput(value);
  return cleaned && !isGenericSessionPrompt(cleaned) && cleaned.length >= 8 ? cleaned : null;
}

export function formatMetadataError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^(\d+):\s*([\s\S]*)$/.exec(raw);
  if (!match) return `Could not generate metadata. ${raw}`;
  let detail = match[2]?.trim() || raw;
  try {
    const parsed = JSON.parse(detail) as { error?: unknown; message?: unknown };
    detail = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : detail;
  } catch {
    // Keep provider text as-is when it is not JSON.
  }
  return `Could not generate metadata (${match[1]}). ${detail}`;
}

export function sessionDisplayTitle(session: WebSession): string {
  return session.title?.trim()
    || (session.lastUserPrompt && isGenericSessionPrompt(session.lastUserPrompt) ? "New session" : session.lastUserPrompt?.trim().slice(0, 60))
    || pathBasename(session.cwd)
    || "Untitled session";
}

export function sessionTitlePlaceholder(session: WebSession): string {
  return session.title ? "Session title" : sessionDisplayTitle(session);
}

export function sessionMetadataLabel(session: WebSession): string {
  const repo = pathBasename(session.cwd);
  const parent = pathParent(session.cwd);
  return `${repo}${parent && parent !== repo ? ` · ${parent}` : ""}`;
}

export function compactWorkflowLaunchSummary(text: string): string | null {
  const workflowMatch = /^Run the bundled `([^`]+)` workflow skill for this coding session\./m.exec(text);
  if (!workflowMatch) return null;
  const command = workflowMatch[1] ?? "workflow";
  const focusMatch = /^Operator-provided focus:\s*(.+)$/m.exec(text);
  const focus = focusMatch?.[1]?.replace(/\s+/g, " ").trim();
  return [`Launched /${command} workflow`, focus ? `Focus: ${focus}` : ""].filter(Boolean).join(" · ");
}

export function sessionSnippet(session: WebSession): string {
  return session.summary?.trim() || (session.lastUserPrompt ? compactWorkflowLaunchSummary(session.lastUserPrompt) ?? session.lastUserPrompt.trim() : "") || "No prompt yet";
}

export function metadataPatchForSuggestion(kind: MetadataAcceptKind, suggestion: SessionMetadataSuggestion): Record<string, string> {
  const body: Record<string, string> = {};
  if ((kind === "both" || kind === "title") && suggestion.title) body.title = suggestion.title;
  if ((kind === "both" || kind === "summary") && suggestion.summary) body.summary = suggestion.summary;
  return body;
}

export function renderSessionSummary(options: {
  session: WebSession;
  expanded: boolean;
  suggestion: SessionMetadataSuggestion | null;
  error: string;
  metadataGenerating: boolean;
  status: string;
}): string {
  const { session, expanded, suggestion, error, metadataGenerating, status } = options;
  const summary = session.summary?.trim();
  const sourceHint = `Title: ${session.titleSource}; summary: ${session.summarySource}`;
  const summaryBlock = summary ? `
      <button id="toggleSessionSummary" class="session-summary-toggle" type="button" title="${escapeHtml(sourceHint)}">${expanded ? "▾" : "▸"} Summary${expanded ? "" : ` — ${escapeHtml(summary.slice(0, 120))}${summary.length > 120 ? "…" : ""}`}</button>
      ${expanded ? `<p class="session-summary-body">${escapeHtml(summary)}</p>` : ""}
    ` : `<span class="session-summary-empty" title="${escapeHtml(sourceHint)}">No summary yet.</span>`;
  const suggestionBlock = suggestion ? `
      <div class="metadata-suggestion">
        <div class="metadata-suggestion-header">
          <strong>Suggested title${suggestion.summary ? " & summary" : ""}</strong>
          ${suggestion.reason ? `<span>${escapeHtml(suggestion.reason)}</span>` : ""}
        </div>
        ${suggestion.title ? `<p><b>Title:</b> ${escapeHtml(suggestion.title)}</p>` : ""}
        ${suggestion.summary ? `<p><b>Summary:</b> ${escapeHtml(suggestion.summary)}</p>` : ""}
        <div class="metadata-suggestion-actions">
          ${suggestion.title && suggestion.summary ? `<button data-accept-metadata="both">Apply title & summary</button>` : ""}
          ${suggestion.title ? `<button data-accept-metadata="title">Apply title</button>` : ""}
          ${suggestion.summary ? `<button data-accept-metadata="summary">Apply summary</button>` : ""}
          <button id="regenerateMetadata" type="button" ${metadataGenerating || status === "running" ? "disabled" : ""}>Regenerate</button>
          <button id="dismissMetadataSuggestion" type="button">Dismiss</button>
        </div>
      </div>` : "";
  const errorBlock = error ? `<p class="metadata-suggestion metadata-error">${escapeHtml(error)}</p>` : "";
  return `<div class="session-summary">${summaryBlock}${suggestionBlock}${errorBlock}</div>`;
}
