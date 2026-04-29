import { type ControllerInfo, type SessionSnapshot, type WebSession } from "@pi-web-agent/protocol";
import { escapeHtml } from "./utils";

export type AgentStatus = SessionSnapshot["status"] | "disconnected" | "connecting";
export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "retry_failed";

export interface ConnectionBannerState {
  selectedSession: WebSession | null;
  connectionState: ConnectionState;
  connectionMessage: string;
  promptDraft: string;
  promptImageCount: number;
}

export function renderAttentionNeeded(state: { controller: ControllerInfo | null; connectionState: ConnectionState }): string {
  const isController = state.controller?.isController ?? true;
  if (state.connectionState === "retry_failed") {
    return `<div class="attention-needed urgent" role="alert">
      <strong>Reconnect failed</strong>
      <span>Check whether the backend is running, then refresh or reopen the session. Your prompt draft stays local.</span>
      <div class="attention-actions"><button type="button" id="attentionRefresh">Save / Refresh</button></div>
    </div>`;
  }
  if (state.connectionState === "disconnected") {
    return `<div class="attention-needed warning" role="status">
      <strong>Disconnected</strong>
      <span>Sending is paused while the browser reconnects. Your prompt draft is saved locally.</span>
    </div>`;
  }
  if (!isController) {
    return `<div class="attention-needed viewer" role="status">
      <strong>Viewer mode</strong>
      <span>Take control to send prompts or steer the active run.</span>
      <div class="attention-actions"><button type="button" data-control-action="take">Take control</button></div>
    </div>`;
  }
  return "";
}

export function renderStatusPill(selectedSession: WebSession | null, status: AgentStatus): string {
  if (!selectedSession || status === "idle") return "";
  const labels: Record<AgentStatus, string> = {
    aborting: "Stopping",
    connecting: "Connecting",
    disconnected: "Offline",
    error: "Error",
    idle: "Idle",
    running: "Running",
  };
  const label = labels[status] ?? status;
  return `<span class="status ${escapeHtml(status)}" aria-label="Agent status: ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

export function patchHeaderStatus(root: ParentNode, statusHtml: string): void {
  const headerStatus = root.querySelector<HTMLElement>(".header-status");
  const status = headerStatus?.querySelector<HTMLElement>(".status");
  if (!headerStatus) return;
  if (!statusHtml) {
    status?.remove();
    return;
  }
  if (status) {
    status.outerHTML = statusHtml;
    return;
  }
  headerStatus.insertAdjacentHTML("beforeend", statusHtml);
}

export function shouldRenderConnectionBanner(state: ConnectionBannerState): boolean {
  if (!state.selectedSession) return false;
  return state.connectionState !== "connected" || Boolean(state.promptDraft) || state.promptImageCount > 0;
}

export function renderConnectionBanner(state: ConnectionBannerState): string {
  if (!shouldRenderConnectionBanner(state)) return "";
  return `<div class="connection-banner ${escapeHtml(state.connectionState)}" role="status">${renderConnectionBannerContent(state)}</div>`;
}

export function renderConnectionBannerContent(state: ConnectionBannerState): string {
  const stateLabel = state.connectionState.replace("_", " ");
  const message = state.connectionMessage.trim();
  const showMessage = message.length > 0 && message.toLowerCase() !== `${stateLabel}.`;
  return `
    <strong>${escapeHtml(stateLabel)}</strong>
    ${showMessage ? `<span>${escapeHtml(message)}</span>` : ""}
    ${state.promptDraft ? `<small>Draft saved locally for this session.</small>` : ""}
    ${state.promptImageCount > 0 ? `<small>Attached images will be lost on refresh.</small>` : ""}`;
}

export function patchConnectionBanner(root: ParentNode, state: ConnectionBannerState): void {
  const banner = root.querySelector<HTMLElement>(".connection-banner");
  if (!shouldRenderConnectionBanner(state)) {
    banner?.remove();
    return;
  }
  const html = renderConnectionBanner(state);
  if (banner) {
    banner.outerHTML = html;
    return;
  }
  root.querySelector("main > header")?.insertAdjacentHTML("afterend", html);
}

export function renderViewerCount(selectedSession: WebSession | null, controller: ControllerInfo | null): string {
  const viewers = Math.max(0, (controller?.connectedClients ?? 1) - 1);
  if (!selectedSession || viewers < 1) return "";
  const label = `${viewers} viewer${viewers === 1 ? "" : "s"}`;
  return `<span class="viewer-count" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
    <span>${viewers}</span>
  </span>`;
}
