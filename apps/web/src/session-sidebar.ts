import type { SessionSnapshot, WebSession } from "@pi-web-agent/protocol";
import { sessionDisplayTitle, sessionSnippet } from "./session-metadata";
import { escapeHtml, pathBasename } from "./utils";

export type SessionRecencyGroupId = "today" | "yesterday" | "this-week" | "older";

export type SessionRecencyGroup = {
  id: SessionRecencyGroupId;
  label: string;
  sessions: WebSession[];
  defaultExpanded: boolean;
};

export const collapsedSessionGroupsStorageKey = "piWebCollapsedSessionGroups";

export function isSessionRecencyGroupId(value: string): value is SessionRecencyGroupId {
  return value === "today" || value === "yesterday" || value === "this-week" || value === "older";
}

export function storedCollapsedSessionGroups(): Set<SessionRecencyGroupId> {
  try {
    const parsed = JSON.parse(localStorage.getItem(collapsedSessionGroupsStorageKey) ?? "null");
    if (!Array.isArray(parsed)) return new Set<SessionRecencyGroupId>(["this-week", "older"]);
    return new Set(parsed.filter((value): value is SessionRecencyGroupId => typeof value === "string" && isSessionRecencyGroupId(value)));
  } catch {
    return new Set<SessionRecencyGroupId>(["this-week", "older"]);
  }
}

export function persistCollapsedSessionGroups(groups: Set<SessionRecencyGroupId>): void {
  localStorage.setItem(collapsedSessionGroupsStorageKey, JSON.stringify([...groups]));
}

function sessionActivityTime(session: WebSession): number {
  const time = new Date(session.lastActivityAt ?? session.lastOpenedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function startOfLocalDay(time = Date.now()): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function relativeTime(value: string | undefined): string {
  if (!value) return "never";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export function groupedSessions(sessions: WebSession[]): SessionRecencyGroup[] {
  const todayStart = startOfLocalDay();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const groups: SessionRecencyGroup[] = [
    { id: "today", label: "Today", sessions: [], defaultExpanded: true },
    { id: "yesterday", label: "Yesterday", sessions: [], defaultExpanded: true },
    { id: "this-week", label: "Earlier this week", sessions: [], defaultExpanded: false },
    { id: "older", label: "Older", sessions: [], defaultExpanded: false },
  ];
  for (const session of [...sessions].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a))) {
    const activity = sessionActivityTime(session);
    const group = (activity >= todayStart ? groups[0]
      : activity >= yesterdayStart ? groups[1]
      : activity >= weekStart ? groups[2]
      : groups[3])!;
    group.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}

function sessionGroupExpanded(group: SessionRecencyGroup, selectedSessionId: string | undefined, collapsedGroups: Set<SessionRecencyGroupId>): boolean {
  if (group.sessions.some((session) => session.id === selectedSessionId)) return true;
  return group.defaultExpanded ? !collapsedGroups.has(group.id) : !collapsedGroups.has(group.id);
}

function renderSessionCard(options: {
  session: WebSession;
  selectedSessionId: string | undefined;
  status: SessionSnapshot["status"] | "disconnected" | "connecting";
}): string {
  const { session, selectedSessionId, status: currentStatus } = options;
  const title = sessionDisplayTitle(session);
  const activity = session.lastActivityAt ?? session.lastOpenedAt;
  const snippet = sessionSnippet(session);
  const status = session.status ?? (session.id === selectedSessionId ? currentStatus === "connecting" || currentStatus === "disconnected" ? undefined : currentStatus : "idle");
  return `
      <button data-session-id="${escapeHtml(session.id)}" class="session-card ${session.id === selectedSessionId ? "active" : ""}">
        <span class="session-card-top">
          <strong>${escapeHtml(title)}</strong>
          ${status ? `<em class="session-indicator ${escapeHtml(status)}">${escapeHtml(status)}</em>` : ""}
        </span>
        <span class="session-snippet">${escapeHtml(snippet)}</span>
        <small>${escapeHtml(relativeTime(activity))} · ${escapeHtml(pathBasename(session.cwd))}</small>
      </button>`;
}

export function renderSessionGroups(options: {
  groups: SessionRecencyGroup[];
  selectedSessionId: string | undefined;
  collapsedGroups: Set<SessionRecencyGroupId>;
  status: SessionSnapshot["status"] | "disconnected" | "connecting";
}): string {
  const { groups, selectedSessionId, collapsedGroups, status } = options;
  if (!groups.length) return `<p class="empty-sidebar">No recent sessions. Create one from the selected workspace.</p>`;
  return groups.map((group) => {
    const expanded = sessionGroupExpanded(group, selectedSessionId, collapsedGroups);
    return `<section class="session-group ${expanded ? "expanded" : "collapsed"}" data-session-group="${group.id}">
        <button type="button" class="session-group-heading" data-session-group-toggle="${group.id}" aria-expanded="${expanded}">
          <span>${expanded ? "▾" : "▸"} ${escapeHtml(group.label)}</span>
          <small>${group.sessions.length}</small>
        </button>
        ${expanded ? `<div class="sessions">${group.sessions.map((session) => renderSessionCard({ session, selectedSessionId, status })).join("")}</div>` : ""}
      </section>`;
  }).join("");
}
