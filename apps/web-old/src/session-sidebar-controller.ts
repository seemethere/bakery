import type { WebSession, Workspace } from "@pi-web-agent/protocol";
import type { AppRoute } from "./router";
import { sessionsRoutePath, settingsRoutePath } from "./router";
import { escapeHtml } from "./utils";

export type SessionSidebarRenderOptions = {
  collapsed: boolean;
  pinned: boolean;
  mobileLayout: boolean;
  selectedSession: WebSession | null;
  workspaces: Workspace[];
  route: AppRoute;
};

export function sessionSidebarOverlayOpen(options: Pick<SessionSidebarRenderOptions, "collapsed" | "pinned">): boolean {
  return !options.pinned && !options.collapsed;
}

export function renderSessionSidebarBackdrop(options: Pick<SessionSidebarRenderOptions, "collapsed" | "pinned">): string {
  return sessionSidebarOverlayOpen(options) ? `<button id="sessionSidebarBackdrop" class="session-sidebar-backdrop" type="button" aria-label="Hide sessions"></button>` : "";
}

export function renderSessionSidebar(options: SessionSidebarRenderOptions): string {
  const sidebarOverlayOpen = sessionSidebarOverlayOpen(options);
  return `<aside class="session-sidebar ${options.collapsed ? "collapsed" : ""} ${sidebarOverlayOpen ? "overlay" : ""}">
        <div class="sidebar-titlebar">
          <h1>Pi Web Agent</h1>
          <div class="sidebar-titlebar-actions">
            ${sidebarOverlayOpen && !options.mobileLayout ? `<button id="pinSessionSidebar" class="pin-sidebar" type="button" title="Pin sessions as a left column">Pin</button>` : ""}
            <button id="toggleSessionSidebar" class="collapse-sidebar" title="${options.collapsed ? "Show navigation" : options.pinned ? "Hide navigation and unpin auto-collapse" : "Hide navigation"}" aria-label="${options.collapsed ? "Show navigation" : "Hide navigation"}">${options.collapsed ? "▶" : "◀"}</button>
          </div>
        </div>
        ${options.collapsed ? `
          <span class="collapsed-sidebar-label">Nav</span>
          ${options.selectedSession ? `<span class="collapsed-sidebar-session" title="${escapeHtml(options.selectedSession.title ?? options.selectedSession.cwd)}">●</span>` : ""}
        ` : `
          <nav class="sidebar-section sidebar-nav" aria-label="Primary">
            <button type="button" class="sidebar-nav-item ${options.route.kind === "sessions" ? "active" : ""}" data-route-path="${sessionsRoutePath()}">
              <strong>Sessions</strong>
              <span>Find and resume work</span>
            </button>
          </nav>
          <div class="sidebar-section sidebar-session-section">
            <label>Workspace
              <select id="workspace">
                ${options.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
              </select>
            </label>
            <div class="new-session-actions">
              <button id="newSession">New session</button>
              <button id="newIsolatedSession" title="Create a Git worktree session on its own branch">New isolated session</button>
            </div>
            <details class="workspace-manager">
              <summary>Add workspace</summary>
              <label>Existing path
                <input id="addWorkspacePath" type="text" placeholder="/path/to/repo" />
              </label>
              <button id="addWorkspace" type="button">Add path</button>
              <hr />
              <label>Clone Git repository
                <input id="cloneWorkspaceUrl" type="url" placeholder="https://github.com/owner/repo.git" />
              </label>
              <label>Directory name <span class="label-hint">optional</span>
                <input id="cloneWorkspaceTarget" type="text" placeholder="repo" />
              </label>
              <label>Clone under
                <select id="cloneWorkspaceBase">
                  ${options.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
                </select>
              </label>
              <button id="cloneWorkspace" type="button">Clone</button>
              <hr />
              <label>New GitHub repository
                <input id="githubRepoName" type="text" placeholder="repo-name" />
              </label>
              <label>Owner/org <span class="label-hint">optional</span>
                <input id="githubRepoOwner" type="text" placeholder="default authenticated user" />
              </label>
              <label>Description <span class="label-hint">optional</span>
                <input id="githubRepoDescription" type="text" />
              </label>
              <label>Clone under
                <select id="githubRepoBase">
                  ${options.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
                </select>
              </label>
              <label class="checkbox-row"><input id="githubRepoPrivate" type="checkbox" checked /> Private repository</label>
              <button id="createGithubWorkspace" type="button">Create on GitHub</button>
              <p class="workspace-manager-note">GitHub creation uses backend <code>GH_TOKEN</code>/<code>GITHUB_TOKEN</code> or <code>gh</code> auth when available.</p>
            </details>
          </div>
          <div class="sidebar-section sidebar-settings-nav-section">
            <hr />
            <button type="button" class="sidebar-nav-item ${options.route.kind === "settings" ? "active" : ""}" data-route-path="${settingsRoutePath()}">
              <strong>Settings</strong>
              <span>API, theme, metadata</span>
            </button>
          </div>
        `}
      </aside>`;
}

export function mobileSessionSidebarToggleLabel(collapsed: boolean): string {
  return collapsed ? "Show sessions" : "Hide sessions";
}
