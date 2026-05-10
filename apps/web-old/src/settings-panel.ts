import type { AppSettings, PreviewStackStatus, SessionMetadataSuggestion, SessionRuntimeSettings, WebSession } from "@pi-web-agent/protocol";
import { renderSessionSummary, type MetadataSuggestionDraft } from "./session-metadata";
import { sessionRoutePath } from "./router";
import { escapeHtml } from "./utils";

export type AppSettingsRenderOptions = {
  settings: SessionRuntimeSettings | null;
  appSettings: AppSettings | null;
};

export function renderAppSettings(options: AppSettingsRenderOptions): string {
  const models = options.settings?.availableModels ?? [];
  const selected = options.appSettings?.sessionMetadataModel?.model ?? "";
  return `<div class="app-settings">
      <label>Metadata model
        <select id="metadataModelSetting">
          <option value="" ${selected ? "" : "selected"}>Default / active model</option>
          ${models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? "selected" : ""}>${escapeHtml(model.name ?? model.id)} [${escapeHtml(model.provider)}]</option>`).join("")}
        </select>
      </label>
      <small>Titles and summaries are generated only when you click ✨.</small>
    </div>`;
}

export type SessionSummaryRenderOptions = {
  selectedSession: WebSession | null;
  metadataSuggestion: SessionMetadataSuggestion | null;
  metadataSuggestionDraft: MetadataSuggestionDraft;
  metadataSuggestionError: string;
  metadataGenerating: boolean;
  status: string;
  showSuggestion: boolean;
};

export function renderSelectedSessionSummary(options: SessionSummaryRenderOptions): string {
  if (!options.selectedSession) return "";
  return renderSessionSummary({
    session: options.selectedSession,
    suggestion: options.metadataSuggestion,
    draft: options.metadataSuggestionDraft,
    error: options.metadataSuggestionError,
    metadataGenerating: options.metadataGenerating,
    status: options.status,
    showSuggestion: options.showSuggestion,
  });
}

export type SessionDetailsRenderOptions = Omit<SessionSummaryRenderOptions, "showSuggestion"> & {
  sessionDetailsOpen: boolean;
  mobileLayout: boolean;
  previewStackStatus: PreviewStackStatus | null;
  previewStackBusy: boolean;
};

function renderPreviewStackDetails(session: WebSession, status: PreviewStackStatus | null, busy: boolean): string {
  if (session.isolationKind !== "git_worktree") return "";
  const state = status?.state ?? "stopped";
  const running = state === "running" || state === "starting";
  const stoppable = running || (state === "error" && Boolean(status?.backendPort || status?.webPort));
  const url = status?.url ?? "";
  const message = status?.message ?? "Start a fake-agent preview stack to dogfood this isolated branch in its own browser URL.";
  return `<section class="preview-stack-card" aria-label="Preview stack">
        <div class="preview-stack-heading">
          <span>Preview Stack</span>
          <strong>${escapeHtml(state.replace(/_/g, " "))}</strong>
        </div>
        <p>${escapeHtml(message)}</p>
        ${url ? `<div class="preview-stack-url"><code title="${escapeHtml(url)}">${escapeHtml(url)}</code><button id="copyPreviewStackUrl" type="button">Copy URL</button><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open</a></div>` : ""}
        <div class="preview-stack-meta">
          <span>Mode: fake-agent</span>
          ${status?.backendPort ? `<span>Backend: ${status.backendPort}</span>` : ""}
          ${status?.webPort ? `<span>Web: ${status.webPort}</span>` : ""}
        </div>
        ${status?.logPath ? `<div class="preview-stack-command"><span>Logs</span><code title="${escapeHtml(status.logPath)}">${escapeHtml(status.logPath)}</code></div>` : ""}
        <div class="preview-stack-actions">
          <button id="startPreviewStack" type="button" ${busy || running ? "disabled" : ""}>${busy && !running ? "Starting…" : "Start preview stack"}</button>
          <button id="stopPreviewStack" type="button" ${busy || !stoppable ? "disabled" : ""}>Stop</button>
          <button id="refreshPreviewStack" type="button" ${busy ? "disabled" : ""}>Refresh</button>
        </div>
      </section>`;
}

export function renderSessionDetails(options: SessionDetailsRenderOptions): string {
  const session = options.selectedSession;
  if (!session || !options.sessionDetailsOpen) return "";
  return `<div class="session-details-popover" role="dialog" aria-label="Session details">
      <div class="session-details-header">
        <strong>Session details</strong>
        <button id="closeSessionDetails" type="button" aria-label="Close session details">×</button>
      </div>
      <div class="session-details-path">
        <span>${session.isolationKind === "git_worktree" ? "Worktree" : "Workspace"}</span>
        <code title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</code>
        <button id="copyWorkspacePath" type="button">Copy path</button>
      </div>
      ${session.isolationKind === "git_worktree" ? `
        <div class="session-details-path">
          <span>Source</span>
          <code title="${escapeHtml(session.sourceCwd ?? "")}">${escapeHtml(session.sourceCwd ?? "")}</code>
        </div>
        <div class="session-details-path">
          <span>Branch</span>
          <code title="${escapeHtml(session.worktreeBranch ?? "")}">${escapeHtml(session.worktreeBranch ?? "")}</code>
        </div>
        ${session.worktreeSourceDirty ? `<p class="notice">Created from HEAD; source had uncommitted changes that were not copied.</p>` : ""}
      ` : ""}
      ${renderPreviewStackDetails(session, options.previewStackStatus, options.previewStackBusy)}
      ${renderSelectedSessionSummary({ ...options, showSuggestion: !options.mobileLayout })}
      <button id="generateMetadata" class="session-details-generate" type="button" ${options.metadataGenerating || options.status === "running" ? "disabled" : ""}>${options.metadataGenerating ? "Generating…" : "Suggest title and summary"}</button>
    </div>`;
}

export type SettingsMainRenderOptions = AppSettingsRenderOptions & {
  selectedSession: WebSession | null;
  sessionSidebarCollapsed: boolean;
  notice: string;
  composerNotice: boolean;
  apiBase: string;
  token: string;
  themePreference: "system" | "workbench-dark" | "workbench-light";
};

export function renderSettingsMain(options: SettingsMainRenderOptions): string {
  const chatPath = options.selectedSession ? sessionRoutePath(options.selectedSession.id) : "/";
  return `<main class="settings-main">
      <header>
        <button id="toggleSessionSidebarMobile" class="mobile-menu-button" type="button" title="${options.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}" aria-label="${options.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}">☰</button>
        <div class="session-identity">
          <strong>Settings</strong>
          <span>Configure this browser's Bakery connection and app preferences.</span>
        </div>
        <div class="header-status">
          <button type="button" data-route-path="${escapeHtml(chatPath)}">${options.selectedSession ? "Current chat" : "Chat"}</button>
        </div>
      </header>
      ${options.notice && !options.composerNotice ? `<p class="notice app-notice">${escapeHtml(options.notice)}</p>` : ""}
      <section class="settings-page" aria-label="Settings">
        <div class="settings-page-hero">
          <p class="settings-page-kicker">App settings</p>
          <h1>Settings</h1>
          <p>Low-frequency controls live here so the session drawer can stay focused on navigation and starting work.</p>
        </div>
        <div class="settings-grid">
          <section class="settings-card" aria-labelledby="connectionSettingsHeading">
            <div class="settings-card-heading">
              <h2 id="connectionSettingsHeading">Connection</h2>
              <p>Stored locally in this browser. Changing these values reloads server data from the selected API.</p>
            </div>
            <label>API base
              <input id="apiBase" value="${escapeHtml(options.apiBase)}" spellcheck="false" />
            </label>
            <label>Token
              <input id="token" type="password" value="${escapeHtml(options.token)}" autocomplete="off" />
            </label>
            <button id="saveSettings" class="primary-action" type="button">Save / Refresh</button>
          </section>
          <section class="settings-card" aria-labelledby="appearanceSettingsHeading">
            <div class="settings-card-heading">
              <h2 id="appearanceSettingsHeading">Appearance</h2>
              <p>Theme preference applies immediately and follows system appearance when set to System.</p>
            </div>
            <label>Theme
              <select id="themePreference">
                <option value="system" ${options.themePreference === "system" ? "selected" : ""}>System</option>
                <option value="workbench-dark" ${options.themePreference === "workbench-dark" ? "selected" : ""}>Workbench Dark</option>
                <option value="workbench-light" ${options.themePreference === "workbench-light" ? "selected" : ""}>Workbench Light</option>
              </select>
            </label>
          </section>
          <section class="settings-card" aria-labelledby="metadataSettingsHeading">
            <div class="settings-card-heading">
              <h2 id="metadataSettingsHeading">Session metadata</h2>
              <p>Titles and summaries are generated only when you click ✨ in session details.</p>
            </div>
            ${renderAppSettings(options)}
          </section>
        </div>
      </section>
    </main>`;
}
