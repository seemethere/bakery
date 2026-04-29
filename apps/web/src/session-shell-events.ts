import { type SessionIsolationKind, type WebSession } from "@pi-web-agent/protocol";
import { isSessionRecencyGroupId, persistCollapsedSessionGroups, type SessionRecencyGroupId } from "./session-sidebar";

export interface SessionShellEventContext {
  sessions: readonly WebSession[];
  collapsedSessionGroups: Set<SessionRecencyGroupId>;
  setThemePreference(value: string): void;
  saveSettings(apiBase: string | undefined, token: string): void;
  navigateToPath(path: string): void;
  setSessionsSearch(query: string): void;
  createSession(workspaceId?: string, isolationKind?: SessionIsolationKind): Promise<unknown>;
  updateMetadataModel(model: string): void;
  toggleSessionSidebar(buttonId: string): void;
  hideSessionSidebarFromBackdrop(): void;
  openSession(session: WebSession): void;
  render(): void;
}

export function bindSessionShellEvents(root: ParentNode, context: SessionShellEventContext): void {
  root.querySelector<HTMLSelectElement>("#themePreference")?.addEventListener("change", (event) => {
    context.setThemePreference((event.currentTarget as HTMLSelectElement).value);
  });

  root.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", () => {
    const apiBase = root.querySelector<HTMLInputElement>("#apiBase")?.value.trim();
    const token = root.querySelector<HTMLInputElement>("#token")?.value.trim() ?? "";
    context.saveSettings(apiBase, token);
  });

  root.querySelectorAll<HTMLButtonElement>("[data-route-path]").forEach((button) => {
    button.addEventListener("click", () => context.navigateToPath(button.dataset.routePath || "/"));
  });

  root.querySelector<HTMLInputElement>("#sessionsSearch")?.addEventListener("input", (event) => {
    context.setSessionsSearch((event.currentTarget as HTMLInputElement).value);
  });

  root.querySelector<HTMLButtonElement>("#newSession")?.addEventListener("click", () => void context.createSession());
  root.querySelector<HTMLButtonElement>("#newIsolatedSession")?.addEventListener("click", () => void context.createSession(undefined, "git_worktree"));

  root.querySelector<HTMLSelectElement>("#metadataModelSetting")?.addEventListener("change", (event) => {
    context.updateMetadataModel((event.currentTarget as HTMLSelectElement).value);
  });

  root.querySelector<HTMLButtonElement>("#toggleSessionSidebar")?.addEventListener("click", () => context.toggleSessionSidebar("toggleSessionSidebar"));
  root.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.addEventListener("click", () => context.hideSessionSidebarFromBackdrop());

  root.querySelectorAll<HTMLButtonElement>("[data-session-group-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = button.dataset.sessionGroupToggle;
      if (!group || !isSessionRecencyGroupId(group)) return;
      if (context.collapsedSessionGroups.has(group)) context.collapsedSessionGroups.delete(group);
      else context.collapsedSessionGroups.add(group);
      persistCollapsedSessionGroups(context.collapsedSessionGroups);
      context.render();
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const session = context.sessions.find((candidate) => candidate.id === button.dataset.sessionId);
      if (session) context.openSession(session);
    });
  });
}
