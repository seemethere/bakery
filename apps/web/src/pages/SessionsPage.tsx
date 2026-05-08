import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { WebSession } from "@pi-web-agent/protocol";
import { SessionGroup } from "@/components/sidebar/SessionGroup";
import {
  groupedSessions,
  persistCollapsedSessionGroups,
  sessionGroupExpanded,
  storedCollapsedSessionGroups,
  type ConnectionStatus,
  type SessionRecencyGroupId,
} from "@/lib/session-utils";
import { sessionRoutePath } from "@/lib/router";

type Props = {
  sessions: WebSession[];
  selectedSessionId: string | undefined;
  connectionStatus: ConnectionStatus;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
};

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
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function filteredSessions(sessions: WebSession[], query: string): WebSession[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  const terms = normalized.split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    const text = searchableText(session);
    return terms.every((term) => text.includes(term));
  });
}

export function SessionsPage({ sessions, selectedSessionId, connectionStatus, onDeleteSession, onRenameSession, onTogglePinSession }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<SessionRecencyGroupId>>(
    () => storedCollapsedSessionGroups(),
  );

  const filtered = filteredSessions(sessions, query);
  const groups = groupedSessions(filtered);
  const resultCopy = query.trim()
    ? `${filtered.length} matching session${filtered.length === 1 ? "" : "s"}`
    : `${filtered.length} recent session${filtered.length === 1 ? "" : "s"}`;

  function toggleGroup(id: SessionRecencyGroupId) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistCollapsedSessionGroups(next);
      return next;
    });
  }

  function handleSelectSession(id: string) {
    navigate(sessionRoutePath(id));
  }

  return (
    <section className="h-full overflow-y-auto p-5 grid content-start gap-4 max-w-5xl" aria-labelledby="sessionsPageTitle">
      <div className="grid gap-2">
        <p className="text-xs font-extrabold uppercase tracking-widest text-muted-foreground">Sessions</p>
        <h1 id="sessionsPageTitle" className="text-3xl font-semibold tracking-tight text-foreground m-0">
          Find and resume work
        </h1>
        <p className="text-sm text-muted-foreground m-0">
          Search existing sessions by title, prompt snippet, workspace, branch, or status.
        </p>
        <label className="grid gap-1.5 mt-2 max-w-xl">
          <span className="sr-only">Search sessions</span>
          <input
            id="sessionsSearch"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, prompt, workspace, branch…"
            autoComplete="off"
            className="w-full text-sm px-3 py-2.5 rounded-xl border border-border/70 bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
        </label>
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{resultCopy}</span>
      </div>

      <div className="grid gap-3 max-w-4xl">
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3 rounded-2xl border border-border/40 bg-muted/20">
            No sessions match this search.
          </p>
        ) : (
          groups.map((group) => (
            <SessionGroup
              key={group.id}
              group={group}
              selectedSessionId={selectedSessionId}
              connectionStatus={connectionStatus}
              expanded={sessionGroupExpanded(group, selectedSessionId, collapsedGroups)}
              onToggle={() => toggleGroup(group.id)}
              onSelectSession={handleSelectSession}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onTogglePinSession={onTogglePinSession}
            />
          ))
        )}
      </div>
    </section>
  );
}
