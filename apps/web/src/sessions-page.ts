import type { SessionSnapshot, WebSession } from "@pi-web-agent/protocol";
import { groupedSessions, renderSessionGroups, type SessionRecencyGroupId } from "./session-sidebar";
import { escapeHtml } from "./utils";

function searchableText(session: WebSession): string {
  return [
    session.title,
    session.summary,
    session.lastUserPrompt,
    session.cwd,
    session.sourceCwd,
    session.worktreeBranch,
    session.status,
    session.isolationKind,
  ].filter(Boolean).join("\n").toLowerCase();
}

export function filteredSessions(sessions: WebSession[], query: string): WebSession[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  const terms = normalized.split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const text = searchableText(session);
    return terms.every((term) => text.includes(term));
  });
}

export function renderSessionsPage(options: {
  sessions: WebSession[];
  selectedSessionId: string | undefined;
  collapsedGroups: Set<SessionRecencyGroupId>;
  status: SessionSnapshot["status"] | "disconnected" | "connecting";
  searchQuery: string;
}): string {
  const filtered = filteredSessions(options.sessions, options.searchQuery);
  const groups = groupedSessions(filtered);
  const resultCopy = options.searchQuery.trim()
    ? `${filtered.length} matching session${filtered.length === 1 ? "" : "s"}`
    : `${filtered.length} recent session${filtered.length === 1 ? "" : "s"}`;
  return `<section class="sessions-page" aria-labelledby="sessionsPageTitle">
    <div class="sessions-page-hero">
      <p class="sessions-page-kicker">Sessions</p>
      <h1 id="sessionsPageTitle">Find and resume work</h1>
      <p>Search existing Bakery sessions by title, prompt snippet, workspace, branch, or status.</p>
      <label class="sessions-search">Search sessions
        <input id="sessionsSearch" type="search" value="${escapeHtml(options.searchQuery)}" placeholder="Search title, prompt, workspace, branch…" autocomplete="off" />
      </label>
      <span class="sessions-result-count">${escapeHtml(resultCopy)}</span>
    </div>
    <div class="sessions-page-list">
      ${groups.length ? renderSessionGroups({ groups, selectedSessionId: options.selectedSessionId, collapsedGroups: options.collapsedGroups, status: options.status }) : `<p class="empty-sidebar">No sessions match this search.</p>`}
    </div>
  </section>`;
}
