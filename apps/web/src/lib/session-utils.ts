import type { SessionSnapshot, WebSession, Workspace } from "@pi-web-agent/protocol";

export type SessionRecencyGroupId = "today" | "yesterday" | "this-week" | "older";

export type SessionRecencyGroup = {
  id: SessionRecencyGroupId;
  label: string;
  sessions: WebSession[];
  defaultExpanded: boolean;
};

export type ConnectionStatus = SessionSnapshot["status"] | "disconnected" | "connecting";

export const collapsedSessionGroupsStorageKey = "piWebCollapsedSessionGroups";

export function isSessionRecencyGroupId(value: string): value is SessionRecencyGroupId {
  return value === "today" || value === "yesterday" || value === "this-week" || value === "older";
}

export function storedCollapsedSessionGroups(): Set<SessionRecencyGroupId> {
  try {
    const parsed = JSON.parse(localStorage.getItem(collapsedSessionGroupsStorageKey) ?? "null");
    if (!Array.isArray(parsed)) return new Set<SessionRecencyGroupId>(["this-week", "older"]);
    return new Set(parsed.filter((v): v is SessionRecencyGroupId => typeof v === "string" && isSessionRecencyGroupId(v)));
  } catch {
    return new Set<SessionRecencyGroupId>(["this-week", "older"]);
  }
}

export function persistCollapsedSessionGroups(groups: Set<SessionRecencyGroupId>): void {
  localStorage.setItem(collapsedSessionGroupsStorageKey, JSON.stringify([...groups]));
}

function pathBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function pathParent(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : path;
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sessionActivityTime(session: WebSession): number {
  return Math.max(timestamp(session.lastActivityAt), timestamp(session.lastOpenedAt));
}

export function sessionActivityValue(session: WebSession): string | undefined {
  return timestamp(session.lastActivityAt) >= timestamp(session.lastOpenedAt)
    ? session.lastActivityAt
    : session.lastOpenedAt;
}

function startOfLocalDay(time = Date.now()): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function relativeTime(value: string | undefined): string {
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

function isGenericSessionPrompt(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:ok(?:ay)?|sure|sounds good|let'?s do it|go on|continue|next|next up|next thing)(?: please)?$/.test(normalized)) return true;
  if (/^(?:give me (?:a )?sense of )?(?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  if (/^(?:nice|okay|alright|ok) (?:what'?s|what is|what) next\??$/.test(normalized)) return true;
  return false;
}

function compactWorkflowLaunchSummary(text: string): string | null {
  const workflowMatch = /^Run the bundled `([^`]+)` workflow skill for this coding session\./m.exec(text);
  if (!workflowMatch) return null;
  const command = workflowMatch[1] ?? "workflow";
  const focusMatch = /^Operator-provided focus:\s*(.+)$/m.exec(text);
  const focus = focusMatch?.[1]?.replace(/\s+/g, " ").trim();
  return [`Launched /${command} workflow`, focus ? `Focus: ${focus}` : ""].filter(Boolean).join(" · ");
}

export function sessionDisplayTitle(session: WebSession): string {
  return (
    session.title?.trim() ||
    (session.lastUserPrompt && isGenericSessionPrompt(session.lastUserPrompt)
      ? "New session"
      : session.lastUserPrompt?.trim().slice(0, 60)) ||
    pathBasename(session.sourceCwd ?? session.cwd ?? "") ||
    "Untitled session"
  );
}

export function sessionSnippet(session: WebSession): string {
  return (
    session.summary?.trim() ||
    (session.lastUserPrompt
      ? compactWorkflowLaunchSummary(session.lastUserPrompt) ?? session.lastUserPrompt.trim()
      : "") ||
    "No prompt yet"
  );
}

export function sessionWorkspaceLabel(session: WebSession): string {
  const workspacePath = sessionWorkspacePath(session);
  if (!workspacePath && session.kind === "chat_only") return "Chat";
  if (!workspacePath && session.kind === "draft") return "Draft";
  return session.isolationKind === "git_worktree"
    ? pathBasename(workspacePath ?? "")
    : pathBasename(session.cwd ?? workspacePath ?? "");
}

export function sessionMetadataLabel(session: WebSession): string {
  const workspacePath = sessionWorkspacePath(session);
  if (!workspacePath && session.kind === "chat_only") return "Chat-only";
  if (!workspacePath && session.kind === "draft") return "Draft";
  if (session.isolationKind === "git_worktree") {
    const repo = pathBasename(workspacePath ?? "");
    return `${repo}${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`;
  }
  const cwd = session.cwd ?? workspacePath ?? "";
  const repo = pathBasename(cwd);
  const parent = pathParent(cwd);
  return `${repo}${parent && parent !== repo ? ` · ${parent}` : ""}`;
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
    const group = (
      activity >= todayStart ? groups[0]
      : activity >= yesterdayStart ? groups[1]
      : activity >= weekStart ? groups[2]
      : groups[3]
    )!;
    group.sessions.push(session);
  }
  return groups.filter((g) => g.sessions.length > 0);
}

export type SessionWorkspaceGroup = {
  workspace: Workspace | null;
  id: string;
  label: string;
  path: string;
  sessions: WebSession[];
};

export const collapsedWorkspaceGroupsStorageKey = "piWebCollapsedWorkspaceGroups";

export function storedCollapsedWorkspaceGroups(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(collapsedWorkspaceGroupsStorageKey) ?? "null");
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set<string>();
  }
}

export function persistCollapsedWorkspaceGroups(groups: Set<string>): void {
  localStorage.setItem(collapsedWorkspaceGroupsStorageKey, JSON.stringify([...groups]));
}

function sessionWorkspacePath(session: WebSession): string | null {
  return session.sourceCwd ?? session.cwd;
}

export function groupedByWorkspace(sessions: WebSession[], workspaces: Workspace[]): SessionWorkspaceGroup[] {
  const byPath = new Map<string, SessionWorkspaceGroup>();
  for (const workspace of workspaces) {
    byPath.set(workspace.path, {
      workspace,
      id: workspace.path,
      label: workspace.label,
      path: workspace.path,
      sessions: [],
    });
  }
  for (const session of [...sessions].sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a))) {
    if (session.pinned) continue;
    const path = sessionWorkspacePath(session);
    if (path === null) continue;
    const existing = byPath.get(path);
    if (existing) {
      existing.sessions.push(session);
    } else {
      byPath.set(path, {
        workspace: null,
        id: path,
        label: pathBasename(path),
        path,
        sessions: [session],
      });
    }
  }
  return [...byPath.values()];
}

export function pinnedSessions(sessions: WebSession[]): WebSession[] {
  return [...sessions].filter((s) => s.pinned).sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a));
}

export function workspaceGroupExpanded(
  group: SessionWorkspaceGroup,
  _selectedSessionId: string | undefined,
  collapsedGroups: Set<string>,
  _activeWorkspacePath: string | undefined,
): boolean {
  return !collapsedGroups.has(group.id);
}

export function sessionGroupExpanded(
  group: SessionRecencyGroup,
  selectedSessionId: string | undefined,
  collapsedGroups: Set<SessionRecencyGroupId>,
): boolean {
  if (group.sessions.some((s) => s.id === selectedSessionId)) return true;
  return !collapsedGroups.has(group.id);
}

export function sessionConnectionStatus(
  session: WebSession,
  selectedSessionId: string | undefined,
  connectionStatus: ConnectionStatus,
): string | undefined {
  return session.status ?? (
    session.id === selectedSessionId
      ? connectionStatus === "connecting" || connectionStatus === "disconnected"
        ? undefined
        : connectionStatus
      : "idle"
  );
}
