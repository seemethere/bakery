import type { SessionMetadataSuggestion, WebSession } from "@pi-web-agent/protocol";
import { escapeHtml, pathBasename, pathParent } from "./utils";

export type MetadataAcceptKind = "both" | "title" | "summary";

export type MetadataSuggestionDraft = {
  title: string;
  summary: string;
};

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
    || pathBasename(session.sourceCwd ?? session.cwd)
    || "Untitled session";
}

export function sessionTitlePlaceholder(session: WebSession): string {
  return session.title ? "Session title" : sessionDisplayTitle(session);
}

export function sessionMetadataLabel(session: WebSession): string {
  if (session.isolationKind === "git_worktree") {
    const repo = pathBasename(session.sourceCwd ?? session.cwd);
    return `${repo} · isolated${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`;
  }
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

export function metadataPatchForSuggestion(kind: MetadataAcceptKind, draft: MetadataSuggestionDraft): Record<string, string> {
  const body: Record<string, string> = {};
  const title = cleanTitleInput(draft.title);
  const summary = draft.summary.replace(/\s+/g, " ").trim().slice(0, 600);
  if ((kind === "both" || kind === "title") && title) body.title = title;
  if ((kind === "both" || kind === "summary") && summary) body.summary = summary;
  return body;
}

export function renderMetadataSuggestion(options: {
  suggestion: SessionMetadataSuggestion | null;
  draft: MetadataSuggestionDraft;
  error: string;
  metadataGenerating: boolean;
  status: string;
  variant?: "inline" | "sheet";
}): string {
  const { suggestion, draft, error, metadataGenerating, status, variant = "inline" } = options;
  if (!suggestion && !error && !metadataGenerating) return "";
  const titleValue = draft.title || suggestion?.title || "";
  const summaryValue = draft.summary || suggestion?.summary || "";
  const disabled = metadataGenerating || status === "running";
  const card = suggestion || metadataGenerating ? `
      <div class="metadata-suggestion ${variant === "sheet" ? "metadata-suggestion-sheet-card" : ""}">
        <div class="metadata-suggestion-header">
          <strong>${metadataGenerating ? "Generating title & summary…" : "Suggested title & summary"}</strong>
          ${suggestion?.reason ? `<span>${escapeHtml(suggestion.reason)}</span>` : ""}
        </div>
        ${metadataGenerating ? `<p class="metadata-suggestion-muted">Asking the configured metadata model. This stays outside the transcript.</p>` : ""}
        ${suggestion?.title ? `
          <label class="metadata-field">Title
            <span class="metadata-field-row">
              <input id="metadataSuggestionTitle" value="${escapeHtml(titleValue)}" maxlength="120" />
              <button data-accept-metadata="title" class="metadata-field-action accept" title="Apply title" aria-label="Apply suggested title" ${disabled || !titleValue.trim() ? "disabled" : ""}>✓</button>
              <button data-dismiss-metadata="title" class="metadata-field-action dismiss" title="Discard title suggestion" aria-label="Discard title suggestion">×</button>
            </span>
          </label>` : ""}
        ${suggestion?.summary ? `
          <label class="metadata-field">Summary
            <span class="metadata-field-row">
              <textarea id="metadataSuggestionSummary" rows="3" maxlength="600">${escapeHtml(summaryValue)}</textarea>
              <span class="metadata-field-actions">
                <button data-accept-metadata="summary" class="metadata-field-action accept" title="Apply summary" aria-label="Apply suggested summary" ${disabled || !summaryValue.trim() ? "disabled" : ""}>✓</button>
                <button data-dismiss-metadata="summary" class="metadata-field-action dismiss" title="Discard summary suggestion" aria-label="Discard summary suggestion">×</button>
              </span>
            </span>
          </label>` : ""}
        <div class="metadata-suggestion-actions">
          ${suggestion?.title && suggestion?.summary ? `<button data-accept-metadata="both" ${disabled || (!titleValue.trim() && !summaryValue.trim()) ? "disabled" : ""}>Apply both</button>` : ""}
          <button id="regenerateMetadata" type="button" ${disabled ? "disabled" : ""}>Regenerate</button>
          <button id="dismissMetadataSuggestion" type="button">Dismiss</button>
        </div>
      </div>` : "";
  const errorBlock = error ? `<p class="metadata-suggestion metadata-error">${escapeHtml(error)}</p>` : "";
  return `${card}${errorBlock}`;
}

export function renderSessionSummary(options: {
  session: WebSession;
  expanded?: boolean;
  suggestion: SessionMetadataSuggestion | null;
  draft: MetadataSuggestionDraft;
  error: string;
  metadataGenerating: boolean;
  status: string;
  showSuggestion: boolean;
}): string {
  const { session, suggestion, draft, error, metadataGenerating, status, showSuggestion } = options;
  const summary = session.summary?.trim();
  const sourceHint = `Title: ${session.titleSource}; summary: ${session.summarySource}`;
  const summaryBlock = summary ? `
      <section class="session-summary-display" title="${escapeHtml(sourceHint)}">
        <span class="session-summary-kicker">Summary</span>
        <p class="session-summary-body">${escapeHtml(summary)}</p>
      </section>
    ` : `<span class="session-summary-empty" title="${escapeHtml(sourceHint)}"><span>Summary</span><strong>No summary yet</strong><em>Generate one from this session when enough context exists.</em></span>`;
  const suggestionBlock = showSuggestion ? renderMetadataSuggestion({ suggestion, draft, error, metadataGenerating, status }) : "";
  return `<div class="session-summary">${summaryBlock}${suggestionBlock}</div>`;
}
