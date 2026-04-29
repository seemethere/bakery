import { PROTOCOL_VERSION, type AppConfig, type AppSettings, type CommandResponse, type ContextUsage, type ControllerInfo, type FileCompleteResponse, type FileSearchResponse, type HelloMessage, type PendingQuestion, type ServerEnvelope, type SessionIsolationKind, type SessionMetadataSuggestion, type SessionRuntimeSettings, type SessionSnapshot, type SessionTreeNode, type SessionTreeResponse, type WebSession, type Workspace } from "@pi-web-agent/protocol";
import { closedCommandAutocompleteState, closedFileAutocompleteState, commandAutocompleteToken, fileAutocompleteToken, renderCommandAutocomplete, renderFileAutocomplete, type AutocompleteToken, type CommandAutocompleteState, type FileAutocompleteState } from "./autocomplete";
import { flattenSessionTree, forkEntryIdForTranscriptItem as findForkEntryIdForTranscriptItem } from "./session-tree";
import { compactSnapshotTranscript, compactWorkflowLaunchSummary, messageToTranscriptItem, renderTranscriptSegments, toolResultToText, type TranscriptItem } from "./transcript";
import { formatMetadataError, metadataPatchForSuggestion, provisionalTitleFromPrompt, renderMetadataSuggestion as renderMetadataSuggestionHtml, renderSessionSummary as renderSessionSummaryHtml, sessionMetadataLabel, sessionTitlePlaceholder, type MetadataAcceptKind, type MetadataSuggestionDraft } from "./session-metadata";
import { storedCollapsedSessionGroups, type SessionRecencyGroupId } from "./session-sidebar";
import { mobileSessionSidebarToggleLabel, renderSessionSidebar as renderSessionSidebarHtml, renderSessionSidebarBackdrop as renderSessionSidebarBackdropHtml, sessionSidebarOverlayOpen } from "./session-sidebar-controller";
import { bindSessionShellEvents } from "./session-shell-events";
import { patchConnectionBanner as patchConnectionBannerWithState, patchHeaderStatus as patchHeaderStatusWithHtml, renderAttentionNeeded as renderAttentionNeededHtml, renderConnectionBanner as renderConnectionBannerHtml, renderConnectionBannerContent as renderConnectionBannerContentHtml, renderStatusPill as renderStatusPillHtml, renderViewerCount as renderViewerCountHtml, shouldRenderConnectionBanner as shouldRenderConnectionBannerForState, type AgentStatus, type ConnectionState } from "./session-status-controller";
import { mergeSessionMetadataUpdate } from "./session-events";
import { buildComposerSendPayload, composerQueueItem, consumePromptAttachmentWarning, loadPromptDraftForSession, parseBashPrompt, persistPromptAttachmentWarning, promptTextFromInput, savePromptDraftForSession, type ClientMessageType } from "./composer-actions";
import { bindComposerControls } from "./composer-controller";
import { composerModeLabel, hasComposerSendContent as composerHasSendContent, isBashPromptDraft as isComposerBashPromptDraft, isComposerNotice as isComposerNoticeMessage, isNoContextBashPromptDraft, patchComposerMode as patchComposerModeWithState, patchComposerSendAvailability as patchComposerSendAvailabilityWithState, renderComposerNotice as renderComposerNoticeHtml } from "./composer-mode-controller";
import { handleComposerImageFiles, removePromptImage as removePromptImageWithContext, type ComposerImageControllerContext } from "./composer-images-controller";
import { TranscriptController, toolCallIdForTranscriptItem } from "./transcript-controller";
import { applyTranscriptAgentEvent } from "./transcript-event-controller";
import { TranscriptFollowController } from "./transcript-follow";
import { hydrateTranscriptRows as hydrateTranscriptDomRows, patchDirtyTranscriptRows, type TranscriptBindingOptions, type TranscriptBindingState, type TranscriptRowStateOptions } from "./transcript-dom";
import { latestGroupableToolGroupId } from "./transcript-renderer";
import { patchRunningToolGroupElapsed as patchRunningToolGroupElapsedReceipt, patchTranscriptStructure as patchTranscriptStructureHtml, recordTranscriptPatchSample, replaceHtmlPreservingTranscript as replaceHtmlPreservingTranscriptRows, syncOpenActionMenus as syncTranscriptOpenActionMenus } from "./transcript-live-controller";
import { activePlanActionItem as findActivePlanActionItem, renderPlanComposerTakeover as renderPlanComposerTakeoverHtml, renderTranscriptShell } from "./transcript-shell";
import { renderPromptImages, type PromptImage } from "./prompt-images";
import { addRunningQueueItem, emptyRunningQueue, hasRunningQueueItems, removeRunningQueueItem, renderRunningQueue, type RunningQueueName, type RunningQueueState } from "./running-queue";
import { renderModelThinkingPicker, renderModelThinkingPopover } from "./model-thinking-picker";
import { bindQuestionPanel, focusQuestionPanel as focusQuestionPanelWithContext, handleQuestionPanelKeydown, renderQuestionPanel as renderQuestionPanelHtml, type QuestionAnswerPayload, type QuestionPanelContext } from "./question-panel-controller";
import { connectSessionWebSocket, type SessionConnectionContext } from "./session-connection-controller";
import { handleTranscriptRowAction as handleTranscriptRowActionWithContext, type TranscriptRowAction, type TranscriptRowMenuAction } from "./transcript-row-actions";
import { parseAppRoute, sessionRoutePath } from "./router";
import { escapeHtml, isRecord, recordPerfEvent, recordPerfSample } from "./utils";
import { renderSessionsPage } from "./sessions-page";
import "./styles.css";

declare global {
  interface Window {
    __piWebImageFailed?: (src: string) => void;
    __piWebFailedImageCount?: number;
  }
}

type PlanAction = "accept" | "chat";
type ThemePreference = "system" | "workbench-dark" | "workbench-light";
const themeStorageKey = "piWebThemePreference";
const themeMediaQuery = "(prefers-color-scheme: light)";
const mobileLayoutMediaQuery = "(max-width: 760px)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "workbench-dark" || value === "workbench-light";
}

function storedThemePreference(): ThemePreference {
  const value = localStorage.getItem(themeStorageKey);
  return isThemePreference(value) ? value : "system";
}

function resolveThemePreference(preference: ThemePreference): "workbench-dark" | "workbench-light" {
  if (preference === "system") return window.matchMedia(themeMediaQuery).matches ? "workbench-light" : "workbench-dark";
  return preference;
}

function applyThemePreference(preference: ThemePreference): void {
  const resolved = resolveThemePreference(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved === "workbench-light" ? "light" : "dark";
}

applyThemePreference(storedThemePreference());

function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function contextUsagePercentLabel(usage: ContextUsage): string {
  return usage.percent === null ? "unknown" : `${usage.percent.toFixed(usage.percent >= 10 ? 0 : 1)}%`;
}

function contextUsageLabel(usage: ContextUsage): string {
  const percent = contextUsagePercentLabel(usage);
  return `${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} (${percent})`;
}

function defaultApiBase(): string {
  const { protocol, hostname } = window.location;
  const apiProtocol = protocol === "https:" ? "https:" : "http:";
  return `${apiProtocol}//${hostname || "127.0.0.1"}:3141`;
}

function browserId(prefix = "id"): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const random = crypto.getRandomValues?.(new Uint32Array(2));
  const suffix = random ? `${(random[0] ?? 0).toString(36)}${(random[1] ?? 0).toString(36)}` : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

class PiWebAgentApp extends HTMLElement {
  private token = localStorage.getItem("piWebAuthToken") ?? "";
  private apiBase = localStorage.getItem("piWebApiBase") ?? defaultApiBase();
  private sessions: WebSession[] = [];
  private workspaces: Workspace[] = [];
  private selectedSession: WebSession | null = null;
  private ws: WebSocket | null = null;
  private readonly transcriptController = new TranscriptController(localStorage, localStorage.getItem("piWebSelectedTranscriptId") ?? "");
  private status: AgentStatus = "disconnected";
  private connectionState: ConnectionState = "disconnected";
  private connectionMessage = "No session connected.";
  private notice = "";
  private controller: ControllerInfo | null = null;
  private settings: SessionRuntimeSettings | null = null;
  private config: AppConfig | null = null;
  private modelThinkingPickerOpen = false;
  private modelThinkingAnchor: { left: number; bottom: number; arrowLeft: number } | null = null;
  private sessionDetailsOpen = false;
  private pendingQuestion: PendingQuestion | null = null;
  private appSettings: AppSettings | null = null;
  private metadataSuggestion: SessionMetadataSuggestion | null = null;
  private metadataSuggestionDraft: MetadataSuggestionDraft = { title: "", summary: "" };
  private metadataSuggestionError = "";
  private metadataGenerating = false;
  private editingTitleDraft: string | null = null;
  private sessionTree: SessionTreeResponse | null = null;
  private lastSelectedSessionId = localStorage.getItem("piWebLastSessionId") ?? "";
  private readonly transcriptFollow = new TranscriptFollowController();
  private showThinking = localStorage.getItem("piWebShowThinking") === "true";
  private themePreference: ThemePreference = storedThemePreference();
  private mobileLayout = window.matchMedia(mobileLayoutMediaQuery).matches;
  private sessionSidebarCollapsed = this.mobileLayout ? true : localStorage.getItem("piWebSessionSidebarCollapsed") === "true";
  private sessionSidebarPinned = this.mobileLayout ? false : localStorage.getItem("piWebSessionSidebarPinned") === "true";
  private collapsedSessionGroups = storedCollapsedSessionGroups();
  private sessionsSearch = "";
  private openActionMenuId = "";
  private expandedToolActivityIds = new Set<string>();
  private readonly transcriptBindingState: TranscriptBindingState = { pointerDown: null };
  private dismissedPlanActionTranscriptId = "";
  private promptDraft = "";
  private promptImages: PromptImage[] = [];
  private runningQueue: RunningQueueState = emptyRunningQueue();
  private runningQueueExpanded = false;
  private runningQueueSectionExpanded = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socketGeneration = 0;
  private fileAutocomplete: FileAutocompleteState = closedFileAutocompleteState();
  private fileAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private fileAutocompleteRequest = 0;
  private commandAutocomplete: CommandAutocompleteState = closedCommandAutocompleteState();
  private commandAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private commandAutocompleteRequest = 0;
  private promptDraftSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private imagePickerActive = false;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private runningElapsedTimer: ReturnType<typeof setInterval> | undefined;
  private renderScheduled = false;
  private forceFullRender = false;
  private shellPatchDirty = false;
  private focusPromptOnNextReadyRender = false;
  private focusPendingQuestionOnNextRender = false;
  private renderedSegmentCache = new Map<string, string>();
  private failedImageUrls = new Map<string, number>();
  private readonly themeMedia = window.matchMedia(themeMediaQuery);
  private readonly mobileLayoutMedia = window.matchMedia(mobileLayoutMediaQuery);
  private readonly themeMediaHandler = () => {
    if (this.themePreference === "system") applyThemePreference(this.themePreference);
  };
  private readonly mobileLayoutHandler = () => {
    const wasMobileLayout = this.mobileLayout;
    this.mobileLayout = this.mobileLayoutMedia.matches;
    if (this.mobileLayout) {
      this.sessionSidebarCollapsed = true;
      this.sessionSidebarPinned = false;
    } else if (wasMobileLayout) {
      this.sessionSidebarCollapsed = localStorage.getItem("piWebSessionSidebarCollapsed") === "true";
      this.sessionSidebarPinned = localStorage.getItem("piWebSessionSidebarPinned") === "true";
    }
    this.render();
  };
  private readonly viewportResizeHandler = () => {
    if (this.autoScroll) this.scheduleTranscriptFollow();
  };
  private get autoScroll(): boolean {
    return this.transcriptFollow.autoScroll;
  }

  private set autoScroll(value: boolean) {
    this.transcriptFollow.autoScroll = value;
  }

  private get transcript(): TranscriptItem[] {
    return this.transcriptController.items;
  }

  private get selectedTranscriptId(): string {
    return this.transcriptController.selectedId;
  }

  private get transcriptExpansion(): Map<string, boolean> {
    return this.transcriptController.expansion;
  }

  private get dirtyTranscriptIds(): Set<string> {
    return this.transcriptController.dirtyIds;
  }

  private get transcriptStructureDirty(): boolean {
    return this.transcriptController.structureDirty;
  }

  private set transcriptStructureDirty(value: boolean) {
    this.transcriptController.structureDirty = value;
  }

  private readonly beforeUnloadHandler = () => {
    if (this.promptDraftSaveTimer) {
      clearTimeout(this.promptDraftSaveTimer);
      this.promptDraftSaveTimer = undefined;
    }
    this.savePromptDraft();
    this.persistAttachmentWarningIfNeeded();
  };
  private readonly imageFailedHandler = (src: string): void => {
    if (!src) return;
    window.__piWebFailedImageCount = (window.__piWebFailedImageCount ?? 0) + 1;
    this.failedImageUrls.set(src, Date.now());
    this.renderedSegmentCache.clear();
    if (this.failedImageUrls.size > 200) this.failedImageUrls.clear();
  };
  private readonly windowFocusHandler = (): void => {
    if (!this.imagePickerActive) return;
    window.setTimeout(() => { this.imagePickerActive = false; }, 500);
  };
  private readonly popstateHandler = (): void => {
    void this.openRouteFromLocation();
  };
  private readonly questionKeyHandler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !this.pendingQuestion || !this.querySelector(".question-panel")) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".question-panel")) return;
    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End", "Enter", " ", "Escape"].includes(event.key) || /^[1-9]$/.test(event.key) || event.key.toLowerCase() === "c") {
      this.handleQuestionPanelKeydown(event);
    }
  };
  private readonly sidebarKeyHandler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape") return;
    if (this.sessionDetailsOpen) {
      this.sessionDetailsOpen = false;
      this.render();
      return;
    }
    if (this.sessionSidebarCollapsed || this.sessionSidebarPinned) return;
    this.sessionSidebarCollapsed = true;
    if (!this.mobileLayout) localStorage.setItem("piWebSessionSidebarCollapsed", "true");
    this.render();
  };

  connectedCallback(): void {
    applyThemePreference(this.themePreference);
    window.__piWebImageFailed = this.imageFailedHandler;
    window.addEventListener("beforeunload", this.beforeUnloadHandler);
    window.addEventListener("focus", this.windowFocusHandler);
    window.addEventListener("keydown", this.questionKeyHandler);
    window.addEventListener("keydown", this.sidebarKeyHandler);
    window.addEventListener("resize", this.viewportResizeHandler);
    window.addEventListener("popstate", this.popstateHandler);
    window.visualViewport?.addEventListener("resize", this.viewportResizeHandler);
    this.themeMedia.addEventListener("change", this.themeMediaHandler);
    this.mobileLayoutMedia.addEventListener("change", this.mobileLayoutHandler);
    this.render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    if (window.__piWebImageFailed === this.imageFailedHandler) delete window.__piWebImageFailed;
    window.removeEventListener("beforeunload", this.beforeUnloadHandler);
    window.removeEventListener("focus", this.windowFocusHandler);
    window.removeEventListener("keydown", this.questionKeyHandler);
    window.removeEventListener("keydown", this.sidebarKeyHandler);
    window.removeEventListener("resize", this.viewportResizeHandler);
    window.removeEventListener("popstate", this.popstateHandler);
    window.visualViewport?.removeEventListener("resize", this.viewportResizeHandler);
    this.themeMedia.removeEventListener("change", this.themeMediaHandler);
    this.mobileLayoutMedia.removeEventListener("change", this.mobileLayoutHandler);
    this.persistAttachmentWarningIfNeeded();
    if (this.runningElapsedTimer) clearInterval(this.runningElapsedTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.promptDraftSaveTimer) clearTimeout(this.promptDraftSaveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socketGeneration++;
    this.ws?.close();
  }

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }

  private localImageUrl(path: string): string | null {
    if (!this.selectedSession) return null;
    const imagePath = this.normalizeImageArtifactPath(path);
    if (!imagePath) return null;
    const url = new URL(`${this.apiBase}/api/sessions/${this.selectedSession.id}/${imagePath.workspacePath ? "files" : "artifacts"}/raw`);
    url.searchParams.set("path", imagePath.workspacePath ?? imagePath.originalPath);
    if (this.token) url.searchParams.set("token", this.token);
    const href = url.toString();
    const failedAt = this.failedImageUrls.get(href);
    if (failedAt && Date.now() - failedAt < 30_000) return null;
    if (failedAt) this.failedImageUrls.delete(href);
    return href;
  }

  private normalizeImageArtifactPath(path: string): { originalPath: string; workspacePath?: string } | null {
    const raw = path.trim();
    let decoded: string;
    try {
      decoded = /^file:\/\//i.test(raw) ? decodeURIComponent(raw.replace(/^file:\/\/+/i, "/")) : raw;
    } catch {
      return null;
    }
    const normalizedCwd = this.selectedSession?.cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    let normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!/\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalized) || normalized.includes("\0")) return null;
    if (normalized.startsWith(".bakery/artifacts/")) return { originalPath: normalized };
    if (normalized.startsWith("/") && normalizedCwd) {
      if (normalized === normalizedCwd) return null;
      if (!normalized.startsWith(`${normalizedCwd}/`)) return { originalPath: normalized };
      normalized = normalized.slice(normalizedCwd.length + 1);
    }
    normalized = normalized.replace(/^\.\//, "");
    if (!normalized.startsWith("/") && /^(?:[^/]+\/)+[^/]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalized)) return { originalPath: decoded, workspacePath: normalized };
    return { originalPath: normalized };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private upsertTranscript(item: TranscriptItem): void {
    this.transcriptController.upsert(item, { markUnread: (id) => this.transcriptFollow.markUnread(id) });
  }

  private savePromptDraft(): void {
    savePromptDraftForSession(localStorage, this.selectedSession?.id, this.promptDraft);
  }

  private schedulePromptDraftSave(): void {
    if (this.promptDraftSaveTimer) clearTimeout(this.promptDraftSaveTimer);
    this.promptDraftSaveTimer = setTimeout(() => {
      this.promptDraftSaveTimer = undefined;
      this.savePromptDraft();
    }, 250);
  }

  private loadPromptDraft(sessionId: string): string {
    return loadPromptDraftForSession(localStorage, sessionId);
  }

  private persistAttachmentWarningIfNeeded(): void {
    persistPromptAttachmentWarning(localStorage, this.selectedSession?.id, this.promptImages.length > 0);
  }

  private async refresh(): Promise<void> {
    try {
      const [workspaces, sessions, appSettings, config] = await Promise.all([
        this.api<Workspace[]>("/api/workspaces"),
        this.api<WebSession[]>("/api/sessions"),
        this.api<AppSettings>("/api/settings"),
        this.api<AppConfig>("/api/config"),
      ]);
      this.workspaces = workspaces;
      this.sessions = sessions;
      this.appSettings = appSettings;
      this.config = config;
      if (this.selectedSession) {
        const updated = sessions.find((candidate) => candidate.id === this.selectedSession?.id);
        if (updated) this.selectedSession = updated;
      }
      this.notice = "";
      if (!this.selectedSession) {
        const route = parseAppRoute(window.location.pathname);
        const routeSessionId = route.kind === "session" ? route.sessionId : "";
        const targetSessionId = route.kind === "home" ? this.lastSelectedSessionId : routeSessionId;
        if (targetSessionId) {
          const session = sessions.find((candidate) => candidate.id === targetSessionId);
          if (session) {
            this.openSession(session, true, !routeSessionId);
            return;
          }
          if (routeSessionId) this.notice = `Session ${routeSessionId} was not found.`;
        }
      }
      this.render();
    } catch (error) {
      this.notice = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async createSession(cwdOverride?: string, isolation: SessionIsolationKind = "none"): Promise<WebSession | null> {
    const select = this.querySelector<HTMLSelectElement>("#workspace");
    const cwd = cwdOverride || select?.value || this.workspaces[0]?.path;
    if (!cwd) return null;
    try {
      const session = await this.api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd, isolation }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session);
      if (session.isolationKind === "git_worktree" && session.worktreeSourceDirty) {
        this.notice = "Isolated session created from HEAD. Uncommitted source workspace changes were not copied.";
        this.render();
      }
      return session;
    } catch (error) {
      this.notice = `Create session failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
      return null;
    }
  }

  private openSession(session: WebSession, collapseSidebar = true, updateRoute = true): void {
    this.persistAttachmentWarningIfNeeded();
    this.selectedSession = session;
    if (collapseSidebar && !this.sessionSidebarPinned) this.sessionSidebarCollapsed = true;
    this.lastSelectedSessionId = session.id;
    localStorage.setItem("piWebLastSessionId", session.id);
    this.transcriptController.reset();
    this.setAgentStatus("connecting");
    const hadLostAttachments = consumePromptAttachmentWarning(localStorage, session.id);
    this.notice = hadLostAttachments ? "Image attachments are not restored after a refresh. Please attach them again before sending." : "";
    this.promptDraft = this.loadPromptDraft(session.id);
    this.promptImages = [];
    this.runningQueue = emptyRunningQueue();
    this.autoScroll = true;
    this.controller = null;
    this.settings = null;
    this.modelThinkingPickerOpen = false;
    this.sessionDetailsOpen = false;
    this.pendingQuestion = null;
    this.dismissedPlanActionTranscriptId = "";
    this.sessionTree = null;
    this.transcriptFollow.resetToLatest();
    this.transcriptController.select("");
    this.socketGeneration++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    if (updateRoute) this.pushSessionRoute(session.id);
    this.connectWebSocket(session, "connecting");
    this.render();
  }

  private navigateToPath(path: string): void {
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    if (!this.sessionSidebarPinned) this.sessionSidebarCollapsed = true;
    void this.openRouteFromLocation();
  }

  private pushSessionRoute(sessionId: string): void {
    const nextPath = sessionRoutePath(sessionId);
    if (window.location.pathname === nextPath) return;
    window.history.pushState({ sessionId }, "", nextPath);
  }

  private closeSelectedSessionForHomeRoute(): void {
    if (!this.selectedSession) return;
    this.persistAttachmentWarningIfNeeded();
    this.selectedSession = null;
    this.transcriptController.reset();
    this.setAgentStatus("disconnected");
    this.connectionState = "disconnected";
    this.connectionMessage = "No session connected.";
    this.notice = "";
    this.controller = null;
    this.settings = null;
    this.sessionDetailsOpen = false;
    this.pendingQuestion = null;
    this.sessionTree = null;
    this.transcriptController.select("");
    this.socketGeneration++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.render();
  }

  private async openRouteFromLocation(): Promise<void> {
    const route = parseAppRoute(window.location.pathname);
    if (route.kind === "home") {
      this.closeSelectedSessionForHomeRoute();
      return;
    }
    if (route.kind === "sessions" || route.kind === "settings") {
      this.render();
      return;
    }
    if (route.kind !== "session") return;
    const session = this.sessions.find((candidate) => candidate.id === route.sessionId);
    if (session) {
      if (this.selectedSession?.id !== session.id) this.openSession(session, true, false);
      else this.render();
      return;
    }
    await this.refresh();
    const refreshedSession = this.sessions.find((candidate) => candidate.id === route.sessionId);
    if (refreshedSession) {
      if (this.selectedSession?.id !== refreshedSession.id) this.openSession(refreshedSession, true, false);
      else this.render();
    }
  }

  private sessionConnectionContext(): SessionConnectionContext {
    return {
      apiBase: () => this.apiBase,
      token: () => this.token,
      status: () => this.status,
      selectedSessionId: () => this.selectedSession?.id,
      nextSocketGeneration: () => ++this.socketGeneration,
      isCurrentSocketGeneration: (generation) => generation === this.socketGeneration,
      setSocket: (socket) => { this.ws = socket; },
      clearReconnectTimer: () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      },
      setReconnectTimer: (timer) => { this.reconnectTimer = timer; },
      incrementReconnectAttempt: () => ++this.reconnectAttempt,
      resetReconnectAttempt: () => { this.reconnectAttempt = 0; },
      setConnectionState: (state) => { this.connectionState = state; },
      setConnectionMessage: (message) => { this.connectionMessage = message; },
      setAgentStatus: (status) => this.setAgentStatus(status),
      handleSocketMessage: (raw) => this.handleSocketMessage(raw),
      requestRender: (delayMs = this.status === "running" ? 150 : 0) => this.requestRender(delayMs),
    };
  }

  private connectWebSocket(session: WebSession, state: ConnectionState): void {
    connectSessionWebSocket(this.sessionConnectionContext(), session, state);
  }

  private setAgentStatus(status: AgentStatus): void {
    const previous = this.status;
    this.status = status;
    if (previous !== status) {
      if (previous === "running" && status !== "running") this.expandedToolActivityIds.clear();
      this.shellPatchDirty = true;
      this.patchComposerMode();
    }
  }

  private applySnapshot(snapshot: SessionSnapshot): void {
    this.setAgentStatus(snapshot.status);
    const previous = this.selectedSession?.id === snapshot.session.id ? this.selectedSession : null;
    const session = previous && previous.titleSource === "manual" && snapshot.session.titleSource !== "manual"
      ? { ...snapshot.session, title: previous.title, titleSource: previous.titleSource }
      : snapshot.session;
    this.selectedSession = session;
    this.sessions = this.sessions.map((candidate) => candidate.id === session.id ? session : candidate);
    this.controller = snapshot.controller ?? this.controller;
    this.settings = snapshot.settings ?? this.settings;
    const previousQuestionId = this.pendingQuestion?.id ?? null;
    this.pendingQuestion = snapshot.pendingQuestion ?? null;
    if (this.pendingQuestion && this.pendingQuestion.id !== previousQuestionId) this.focusPendingQuestionOnNextRender = true;
    this.transcriptController.loadToolTimings(session.id);
    this.transcriptController.replaceItems(this.transcriptController.applyCachedToolTimings(compactSnapshotTranscript(snapshot.messages.map((message, index) => messageToTranscriptItem(message, `snapshot:${index}`)))));
    this.runningQueue = emptyRunningQueue();
    this.transcriptFollow.clearUnread();
    this.forceFullRender = true;
    this.dirtyTranscriptIds.clear();
    if (!this.transcript.some((item) => item.id === this.selectedTranscriptId)) this.selectTranscriptItem(this.transcript[this.transcript.length - 1]?.id ?? "", false);
    void this.refreshTree();
  }

  private handleSocketMessage(raw: string): void {
    const data = JSON.parse(raw) as ServerEnvelope | HelloMessage;
    if (!("payload" in data)) {
      if (data.type === "hello") {
        localStorage.setItem(`piWebClientId:${data.sessionId}`, data.clientId);
        this.controller = { clientId: null, connectedClients: 1, currentClientId: data.clientId, isController: false };
        this.ws?.send(JSON.stringify({ type: "hello_ack", protocolVersion: PROTOCOL_VERSION, clientId: data.clientId }));
        this.render();
      }
      return;
    }

    const { payload } = data;
    if (payload.type === "session_snapshot") {
      this.connectionState = "connected";
      this.connectionMessage = "Connected.";
      this.reconnectAttempt = 0;
      this.applySnapshot(payload.snapshot);
    } else if (payload.type === "agent_event") {
      const eventData = isRecord(payload.event.data) ? { ...payload.event.data, eventTime: payload.event.time } : payload.event;
      this.applyAgentEvent(eventData);
    } else if (payload.type === "controller_update") {
      this.controller = payload.controller;
      this.forceFullRender = true;
      this.requestRender(0);
      return;
    } else if (payload.type === "settings_update") {
      this.settings = payload.settings;
    } else if (payload.type === "question_update") {
      const previousQuestionId = this.pendingQuestion?.id ?? null;
      this.pendingQuestion = payload.question;
      if (this.pendingQuestion && this.pendingQuestion.id !== previousQuestionId) this.focusPendingQuestionOnNextRender = true;
      this.forceFullRender = true;
    } else if (payload.type === "session_metadata_update") {
      const titleInput = this.querySelector<HTMLInputElement>("#sessionTitle");
      if (document.activeElement !== titleInput) this.editingTitleDraft = null;
      this.selectedSession = mergeSessionMetadataUpdate(this.selectedSession?.id === payload.session.id ? this.selectedSession : undefined, payload.session);
      this.sessions = this.sessions.map((session) => session.id === payload.session.id ? mergeSessionMetadataUpdate(session, payload.session) : session);
    } else if (payload.type === "error") {
      this.upsertTranscript({ id: `error:${Date.now()}`, kind: "error", title: payload.code, body: payload.message });
    }
    this.requestRender();
  }

  private applyAgentEvent(event: unknown): void {
    applyTranscriptAgentEvent({
      event,
      transcriptController: this.transcriptController,
      selectedSessionId: this.selectedSession?.id,
      runningQueue: this.runningQueue,
      transcriptElement: this.querySelector<HTMLElement>(".transcript"),
      disableFollowIfDetached: (transcript) => this.transcriptFollow.disableFollowIfDetached(transcript),
      setAgentStatus: (status) => this.setAgentStatus(status),
      setRunningQueue: (queue) => { this.runningQueue = queue; },
      refreshTree: () => { void this.refreshTree(); },
      requestImmediateRender: () => this.requestRender(0),
      markUnread: (id) => this.transcriptFollow.markUnread(id),
    });
  }

  private selectTranscriptItem(id: string, shouldRender = true): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    this.transcriptFollow.captureScrollTop(transcript);
    this.transcriptController.select(id);
    if (shouldRender) {
      this.transcriptFollow.preserveNextSync();
      this.render();
    }
  }

  private treeNodes(nodes = this.sessionTree?.tree ?? []): SessionTreeNode[] {
    return flattenSessionTree(nodes);
  }

  private forkEntryIdForTranscriptItem(item: TranscriptItem): string | null {
    return findForkEntryIdForTranscriptItem(item, this.treeNodes());
  }

  private async refreshTree(): Promise<void> {
    if (!this.selectedSession) return;
    try {
      this.sessionTree = await this.api<SessionTreeResponse>(`/api/sessions/${this.selectedSession.id}/tree`);
      this.requestRender(0);
    } catch (error) {
      this.notice = `Tree refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender(0);
    }
  }

  private async forkFromEntry(entryId: string): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const session = await this.api<WebSession>(`/api/sessions/${this.selectedSession.id}/fork`, {
        method: "POST",
        body: JSON.stringify({ entryId }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session);
    } catch (error) {
      this.notice = `Fork failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notice = "";
    } catch (error) {
      this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private fillPromptDraft(text: string): void {
    this.promptDraft = text;
    this.savePromptDraft();
    this.closeCommandAutocomplete();
    this.closeFileAutocomplete();
    this.focusPromptOnNextReadyRender = true;
    this.notice = "";
    this.render();
  }

  private handlePlanAction(action: PlanAction, transcriptId = this.activePlanActionItem()?.id ?? ""): void {
    if (transcriptId) this.dismissedPlanActionTranscriptId = transcriptId;
    if (action === "chat") {
      this.fillPromptDraft("");
      return;
    }
    this.submitPlanActionText("Proceed with the recommended plan.");
  }

  private submitPlanActionText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.fillPromptDraft(text);
      this.notice = "Not connected. Your plan response is saved in the composer.";
      return;
    }
    const type: ClientMessageType = this.status === "running" ? "follow_up" : "prompt";
    this.ws.send(JSON.stringify(buildComposerSendPayload(type, trimmed, [])));
    if (type === "follow_up") this.runningQueue = addRunningQueueItem(this.runningQueue, "followUp", composerQueueItem(trimmed, 0));
    this.promptDraft = "";
    this.promptImages = [];
    this.savePromptDraft();
    this.closeCommandAutocomplete();
    this.closeFileAutocomplete();
    this.notice = "";
    this.render();
  }

  private async handleTranscriptRowAction(action: TranscriptRowMenuAction, transcriptId: string): Promise<void> {
    await handleTranscriptRowActionWithContext({
      items: this.transcript,
      expansion: this.transcriptExpansion,
      dirtyIds: this.dirtyTranscriptIds,
      openActionMenuId: this.openActionMenuId,
      setOpenActionMenuId: (id) => { this.openActionMenuId = id; },
      selectItem: (id, shouldRender) => this.selectTranscriptItem(id, shouldRender),
      preserveNextScrollSync: () => this.transcriptFollow.preserveNextSync(),
      render: () => this.render(),
      copyText: (value) => this.copyText(value),
      forkEntryIdForItem: (item) => this.forkEntryIdForTranscriptItem(item),
      forkFromEntry: (entryId) => this.forkFromEntry(entryId),
      refreshTree: () => this.refreshTree(),
      setNotice: (message) => { this.notice = message; },
    }, action, transcriptId);
  }

  private async updateSessionTitle(title: string): Promise<void> {
    if (!this.selectedSession) return;
    const nextTitle = title.trim();
    const previous = this.selectedSession;
    if ((previous.title ?? "") === nextTitle) {
      this.editingTitleDraft = null;
      this.render();
      return;
    }
    this.selectedSession = { ...previous, title: nextTitle || null, titleSource: nextTitle ? "manual" : "unset" };
    this.sessions = this.sessions.map((session) => session.id === previous.id ? this.selectedSession! : session);
    this.editingTitleDraft = null;
    this.render();
    try {
      const updated = await this.api<WebSession>(`/api/sessions/${previous.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle || null }),
      });
      this.selectedSession = updated;
      this.sessions = this.sessions.map((session) => session.id === updated.id ? updated : session);
      this.notice = "";
    } catch (error) {
      this.selectedSession = previous;
      this.sessions = this.sessions.map((session) => session.id === previous.id ? previous : session);
      this.notice = `Title update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private async generateMetadataSuggestion(): Promise<void> {
    if (!this.selectedSession || this.metadataGenerating) return;
    this.metadataGenerating = true;
    this.metadataSuggestion = null;
    this.metadataSuggestionDraft = { title: "", summary: "" };
    this.metadataSuggestionError = "";
    this.render();
    try {
      const suggestion = await this.api<SessionMetadataSuggestion>(`/api/sessions/${this.selectedSession.id}/metadata/generate`, {
        method: "POST",
        body: JSON.stringify({ mode: "suggest" }),
      });
      if (suggestion.deferred) this.metadataSuggestionError = suggestion.reason ?? "Not enough session context yet.";
      else {
        this.metadataSuggestion = suggestion;
        this.metadataSuggestionDraft = { title: suggestion.title ?? "", summary: suggestion.summary ?? "" };
      }
    } catch (error) {
      this.metadataSuggestionError = formatMetadataError(error);
    }
    this.metadataGenerating = false;
    this.render();
  }

  private async acceptMetadataSuggestion(kind: MetadataAcceptKind): Promise<void> {
    if (!this.selectedSession || !this.metadataSuggestion) return;
    const body = metadataPatchForSuggestion(kind, this.metadataSuggestionDraft);
    if (Object.keys(body).length === 0) return;
    try {
      const updated = await this.api<WebSession>(`/api/sessions/${this.selectedSession.id}`, { method: "PATCH", body: JSON.stringify(body) });
      this.selectedSession = updated;
      this.sessions = this.sessions.map((session) => session.id === updated.id ? updated : session);
      this.dismissMetadataSuggestionField(kind);
      this.metadataSuggestionError = "";
    } catch (error) {
      this.metadataSuggestionError = `Could not apply suggestion: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private updateMetadataSuggestionDraft(field: "title" | "summary", value: string): void {
    this.metadataSuggestionDraft = { ...this.metadataSuggestionDraft, [field]: value };
  }

  private dismissMetadataSuggestionField(kind: MetadataAcceptKind): void {
    if (kind === "both") {
      this.metadataSuggestion = null;
      this.metadataSuggestionDraft = { title: "", summary: "" };
      return;
    }
    this.metadataSuggestionDraft = { ...this.metadataSuggestionDraft, [kind]: "" };
    if (!this.metadataSuggestion) return;
    const next: SessionMetadataSuggestion = {
      ...(kind === "title" ? {} : this.metadataSuggestion.title ? { title: this.metadataSuggestion.title } : {}),
      ...(kind === "summary" ? {} : this.metadataSuggestion.summary ? { summary: this.metadataSuggestion.summary } : {}),
      confidence: this.metadataSuggestion.confidence,
      ...(this.metadataSuggestion.reason ? { reason: this.metadataSuggestion.reason } : {}),
      ...(this.metadataSuggestion.deferred !== undefined ? { deferred: this.metadataSuggestion.deferred } : {}),
    };
    if (!next.title && !next.summary) this.metadataSuggestion = null;
    else this.metadataSuggestion = next;
  }

  private hasComposerSendContent(value = this.promptDraft): boolean {
    return composerHasSendContent(value, this.promptImages.length);
  }

  private patchComposerSendAvailability(input = this.querySelector<HTMLTextAreaElement>("#prompt")): void {
    patchComposerSendAvailabilityWithState(this, input, this.promptImages.length);
  }

  private sendClientMessage(type: ClientMessageType): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = promptTextFromInput(input?.value, this.promptImages.length);
    if (!input || !text) return;
    const bash = type === "prompt" ? parseBashPrompt(text) : null;
    if (bash && this.promptImages.length > 0) {
      this.notice = "Remove image attachments before running a bash command.";
      this.render();
      return;
    }
    if (bash && this.status === "running") {
      this.notice = "Bash commands are available when the session is idle.";
      this.render();
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.notice = "Not connected. Your draft is saved locally; sending will be available after reconnect.";
      this.render();
      return;
    }
    const images = this.promptImages.map((image) => image.dataUrl);
    this.ws.send(JSON.stringify(buildComposerSendPayload(type, text, images)));
    const shouldOptimisticallyShowRunning = type === "prompt" && !bash && !text.trimStart().startsWith("/");
    if (shouldOptimisticallyShowRunning) {
      this.setAgentStatus("running");
      if (this.selectedSession) {
        const optimistic = { ...this.selectedSession, status: "running" as const, lastActivityAt: new Date().toISOString() };
        this.selectedSession = optimistic;
        this.sessions = this.sessions.map((session) => session.id === optimistic.id ? optimistic : session);
      }
    }
    const queuedItem = composerQueueItem(text, images.length);
    if (type === "steer") this.runningQueue = addRunningQueueItem(this.runningQueue, "steering", queuedItem);
    if (type === "follow_up") this.runningQueue = addRunningQueueItem(this.runningQueue, "followUp", queuedItem);
    if (bash) {
      this.setAgentStatus("running");
      this.upsertTranscript({
        id: `bash:pending:${Date.now()}`,
        kind: "tool",
        title: `$ ${bash.command}${bash.excludeFromContext ? " (no context)" : ""}`,
        body: "Starting…",
        status: "running",
        raw: { type: "bash_pending", command: bash.command, excludeFromContext: bash.excludeFromContext },
      });
    }
    if (!bash && type === "prompt" && this.selectedSession && !this.selectedSession.title) {
      const provisionalTitle = provisionalTitleFromPrompt(text);
      const optimisticPrompt = compactWorkflowLaunchSummary(text) ?? text.slice(0, 160);
      const optimistic = { ...this.selectedSession, title: provisionalTitle, titleSource: provisionalTitle ? "first_prompt" as const : "unset" as const, lastUserPrompt: optimisticPrompt, lastActivityAt: new Date().toISOString(), status: "running" as const };
      this.selectedSession = optimistic;
      this.sessions = this.sessions.map((session) => session.id === optimistic.id ? optimistic : session);
      window.setTimeout(() => void this.refresh(), 500);
    }
    this.promptDraft = "";
    this.savePromptDraft();
    this.promptImages = [];
    this.closeFileAutocomplete();
    this.closeCommandAutocomplete();
    input.value = "";
    this.render();
  }

  private removeQueuedMessage(queue: RunningQueueName, index: number, text: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.notice = "Not connected. Queued messages can be changed after reconnect.";
      this.render();
      return false;
    }
    const current = this.runningQueue[queue];
    if (current[index]?.text !== text) {
      this.notice = "Queued message changed before it could be updated.";
      this.render();
      return false;
    }
    this.runningQueue = removeRunningQueueItem(this.runningQueue, queue, index);
    this.ws.send(JSON.stringify({ type: "cancel_queued_message", queue, index, text }));
    return true;
  }

  private cancelQueuedMessage(queue: RunningQueueName, index: number, text: string): void {
    if (this.removeQueuedMessage(queue, index, text)) this.render();
  }

  private editQueuedMessage(queue: RunningQueueName, index: number, text: string): void {
    if (!this.removeQueuedMessage(queue, index, text)) return;
    this.promptDraft = text;
    this.savePromptDraft();
    this.notice = "";
    this.render();
    window.requestAnimationFrame(() => {
      const input = this.querySelector<HTMLTextAreaElement>("#prompt");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  private sendFromInput(followUp = false): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim() ?? "";
    if (input && /^\/new(?:\s|$)/i.test(text)) {
      void this.handleNewSlashCommand(input, text);
      return;
    }
    if (parseBashPrompt(text)) {
      this.sendClientMessage("prompt");
      return;
    }
    if (this.status === "running") this.sendClientMessage(followUp ? "follow_up" : "steer");
    else this.sendClientMessage("prompt");
  }

  private async handleNewSlashCommand(input: HTMLTextAreaElement, text: string): Promise<void> {
    if (text !== "/new") {
      this.notice = "Usage: /new";
      this.render();
      return;
    }
    if (this.promptImages.length > 0) {
      this.notice = "Remove image attachments before using /new.";
      this.render();
      return;
    }

    const cwd = this.selectedSession?.cwd;
    this.focusPromptOnNextReadyRender = true;
    const session = await this.createSession(cwd);
    if (!session) {
      this.focusPromptOnNextReadyRender = false;
      return;
    }
    this.promptDraft = "";
    this.savePromptDraft();
    this.closeFileAutocomplete();
    this.closeCommandAutocomplete();
    input.value = "";
    this.focusPromptOnNextReadyRender = true;
    this.requestRender(0);
  }

  private composerImageContext(): ComposerImageControllerContext {
    return {
      promptImages: () => this.promptImages,
      setPromptImages: (images) => { this.promptImages = images; },
      selectedSessionId: () => this.selectedSession?.id,
      promptInput: () => this.querySelector<HTMLTextAreaElement>("#prompt"),
      promptDraft: () => this.promptDraft,
      setPromptDraft: (draft) => { this.promptDraft = draft; },
      createImageId: () => browserId("image"),
      api: (path, init) => this.api(path, init),
      setNotice: (notice) => { this.notice = notice; },
      render: () => this.render(),
      updatePromptDraft: (input) => this.updatePromptDraft(input),
      schedulePromptDraftSave: () => this.schedulePromptDraftSave(),
    };
  }

  private async handleImageFiles(files: FileList | File[]): Promise<void> {
    await handleComposerImageFiles(this.composerImageContext(), files);
  }

  private removePromptImage(id: string): void {
    removePromptImageWithContext(this.composerImageContext(), id);
  }

  private abort(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "abort" }));
  }

  private takeControl(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "take_control" }));
      this.notice = "";
      this.render();
    }
  }

  private getFileToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return fileAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  private getCommandToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return commandAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  private updatePromptDraft(input: HTMLTextAreaElement): void {
    const wasBashDraft = this.isBashPromptDraft();
    this.promptDraft = input.value;
    this.schedulePromptDraftSave();
    this.patchComposerSendAvailability(input);
    if (wasBashDraft !== this.isBashPromptDraft()) this.patchComposerMode();
    const commandToken = this.getCommandToken(input);
    if (commandToken) {
      this.updateCommandAutocomplete(input, commandToken);
      if (this.fileAutocomplete.active) {
        this.closeFileAutocomplete();
        this.render();
      }
      return;
    }
    const fileToken = this.getFileToken(input);
    if (fileToken) {
      this.updateFileAutocomplete(input, fileToken);
      if (this.commandAutocomplete.active) {
        this.closeCommandAutocomplete();
        this.render();
      }
      return;
    }
    const hadAutocomplete = this.commandAutocomplete.active || this.fileAutocomplete.active;
    this.closeCommandAutocomplete();
    this.closeFileAutocomplete();
    if (hadAutocomplete) this.render();
  }

  private updateFileAutocomplete(input: HTMLTextAreaElement, knownToken?: AutocompleteToken): void {
    const token = knownToken ?? this.getFileToken(input);
    if (!token || !this.selectedSession) {
      const wasActive = this.fileAutocomplete.active;
      this.closeFileAutocomplete();
      if (wasActive) this.render();
      return;
    }

    if (this.commandAutocomplete.active) this.closeCommandAutocomplete();
    const shouldRenderOpen = !this.fileAutocomplete.active;
    this.fileAutocomplete = { ...this.fileAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    if (shouldRenderOpen) this.render();
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    const requestId = ++this.fileAutocompleteRequest;
    this.fileAutocompleteTimer = setTimeout(() => void this.fetchFileAutocomplete(token, requestId), 120);
  }

  private async fetchFileAutocomplete(token: AutocompleteToken, requestId: number): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const pathLike = token.token.includes("/") || token.token.startsWith(".");
      const response = pathLike
        ? await this.api<FileCompleteResponse>(`/api/sessions/${this.selectedSession.id}/files/complete?prefix=${encoded}&limit=20`)
        : await this.api<FileSearchResponse>(`/api/sessions/${this.selectedSession.id}/files/search?q=${encoded}&limit=20`);
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        files: response.files,
        selectedIndex: 0,
        loading: false,
      };
      this.patchFileAutocomplete();
    } catch (error) {
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = { ...this.fileAutocomplete, loading: false, files: [] };
      this.notice = `File autocomplete failed: ${error instanceof Error ? error.message : String(error)}`;
      this.patchFileAutocomplete();
    }
  }

  private closeFileAutocomplete(): void {
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    this.fileAutocompleteRequest++;
    this.fileAutocomplete = closedFileAutocompleteState();
  }

  private updateCommandAutocomplete(input: HTMLTextAreaElement, knownToken?: AutocompleteToken): void {
    const token = knownToken ?? this.getCommandToken(input);
    if (!token || !this.selectedSession) {
      const wasActive = this.commandAutocomplete.active;
      this.closeCommandAutocomplete();
      if (wasActive) this.render();
      return;
    }

    if (this.fileAutocomplete.active) this.closeFileAutocomplete();
    const shouldRenderOpen = !this.commandAutocomplete.active;
    this.commandAutocomplete = { ...this.commandAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    if (shouldRenderOpen) this.render();
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    const requestId = ++this.commandAutocompleteRequest;
    this.commandAutocompleteTimer = setTimeout(() => void this.fetchCommandAutocomplete(token, requestId), 120);
  }

  private async fetchCommandAutocomplete(token: AutocompleteToken, requestId: number): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const response = await this.api<CommandResponse>(`/api/sessions/${this.selectedSession.id}/commands?q=${encoded}&limit=20`);
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        commands: response.commands,
        selectedIndex: 0,
        loading: false,
      };
      this.patchCommandAutocomplete();
    } catch (error) {
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = { ...this.commandAutocomplete, loading: false, commands: [] };
      this.notice = `Command autocomplete failed: ${error instanceof Error ? error.message : String(error)}`;
      this.patchCommandAutocomplete();
    }
  }

  private closeCommandAutocomplete(): void {
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    this.commandAutocompleteRequest++;
    this.commandAutocomplete = closedCommandAutocompleteState();
  }

  private chooseCommandAutocomplete(index = this.commandAutocomplete.selectedIndex): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.commandAutocomplete.commands[index];
    if (!input || !choice) return;
    const inserted = `/${choice.name}`;
    const before = this.promptDraft.slice(0, this.commandAutocomplete.start);
    const after = this.promptDraft.slice(this.commandAutocomplete.end);
    this.promptDraft = `${before}${inserted} ${after}`;
    this.savePromptDraft();
    input.value = this.promptDraft;
    const cursor = before.length + inserted.length + 1;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    this.closeCommandAutocomplete();
    this.render();
  }

  private chooseFileAutocomplete(index = this.fileAutocomplete.selectedIndex): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.fileAutocomplete.files[index];
    if (!input || !choice) return;
    const suffix = choice.type === "directory" && !choice.path.endsWith("/") ? "/" : "";
    const inserted = `@${choice.path}${suffix}`;
    const spacer = choice.type === "directory" ? "" : " ";
    const before = this.promptDraft.slice(0, this.fileAutocomplete.start);
    const after = this.promptDraft.slice(this.fileAutocomplete.end);
    this.promptDraft = `${before}${inserted}${spacer}${after}`;
    this.savePromptDraft();
    input.value = this.promptDraft;
    const cursor = before.length + inserted.length + spacer.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (choice.type === "directory") this.updateFileAutocomplete(input);
    else {
      this.closeFileAutocomplete();
      this.render();
    }
  }

  private questionPanelContext(): QuestionPanelContext {
    return {
      pendingQuestion: () => this.pendingQuestion,
      isController: () => this.controller?.isController ?? true,
      isConnected: () => this.connectionState === "connected",
      root: () => this,
      answer: (payload) => this.answerPendingQuestion(payload),
      setNotice: (notice) => { this.notice = notice; },
      render: () => this.render(),
    };
  }

  private answerPendingQuestion(payload: QuestionAnswerPayload): void {
    if (!this.pendingQuestion) return;
    if (!(this.controller?.isController ?? true)) {
      this.notice = "Take control before answering this question.";
      this.render();
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connectionState !== "connected") {
      this.notice = "Not connected. You can answer after reconnect.";
      this.render();
      return;
    }
    this.focusPromptOnNextReadyRender = true;
    this.ws.send(JSON.stringify({
      type: "answer_question",
      payload: {
        questionId: this.pendingQuestion.id,
        selectedIndex: payload.selectedIndex ?? null,
        wasCustom: payload.wasCustom ?? false,
        cancelled: payload.cancelled ?? false,
        ...(payload.answer ? { answer: payload.answer } : {}),
      },
    }));
  }

  private handleQuestionPanelKeydown(event: KeyboardEvent): void {
    handleQuestionPanelKeydown(this.questionPanelContext(), event);
  }

  private setModel(model: string): void {
    if (model && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_model", model }));
    this.render();
  }

  private setThinking(level: string): void {
    if (level && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_thinking", level }));
    this.render();
  }

  private markTranscriptUserScrollIntent(): void {
    this.transcriptFollow.markUserScrollIntent();
  }

  private sidebarOverlayOpen(): boolean {
    return sessionSidebarOverlayOpen({ collapsed: this.sessionSidebarCollapsed, pinned: this.sessionSidebarPinned });
  }

  private renderSessionSidebarBackdrop(): string {
    return renderSessionSidebarBackdropHtml({ collapsed: this.sessionSidebarCollapsed, pinned: this.sessionSidebarPinned });
  }

  private renderSessionSidebar(): string {
    return renderSessionSidebarHtml({
      collapsed: this.sessionSidebarCollapsed,
      pinned: this.sessionSidebarPinned,
      mobileLayout: this.mobileLayout,
      selectedSession: this.selectedSession,
      workspaces: this.workspaces,
      route: parseAppRoute(window.location.pathname),
    });
  }

  private patchMobileSessionSidebar(): void {
    const sidebarOverlayOpen = this.sidebarOverlayOpen();
    this.classList.toggle("session-sidebar-collapsed", this.sessionSidebarCollapsed);
    this.classList.toggle("session-sidebar-overlay-open", sidebarOverlayOpen);
    this.querySelector("#sessionSidebarBackdrop")?.remove();
    const sidebar = this.querySelector<HTMLElement>(".session-sidebar");
    if (sidebarOverlayOpen) sidebar?.insertAdjacentHTML("beforebegin", this.renderSessionSidebarBackdrop());
    if (sidebar) {
      sidebar.outerHTML = this.renderSessionSidebar();
    } else {
      this.insertAdjacentHTML("afterbegin", `${this.renderSessionSidebarBackdrop()}${this.renderSessionSidebar()}`);
    }
    const mobileToggle = this.querySelector<HTMLButtonElement>("#toggleSessionSidebarMobile");
    if (mobileToggle) {
      const label = mobileSessionSidebarToggleLabel(this.sessionSidebarCollapsed);
      mobileToggle.title = label;
      mobileToggle.setAttribute("aria-label", label);
    }
    this.bindSessionSidebarEvents();
  }

  private toggleSessionSidebar(buttonId: string): void {
    this.sessionSidebarCollapsed = !this.sessionSidebarCollapsed;
    if (this.mobileLayout) {
      this.sessionSidebarPinned = false;
      this.patchMobileSessionSidebar();
      return;
    }
    if (buttonId === "toggleSessionSidebar") this.sessionSidebarPinned = !this.sessionSidebarCollapsed;
    localStorage.setItem("piWebSessionSidebarCollapsed", String(this.sessionSidebarCollapsed));
    localStorage.setItem("piWebSessionSidebarPinned", String(this.sessionSidebarPinned));
    if (this.sessionSidebarPinned) this.notice = "";
    this.render();
  }

  private hideSessionSidebarFromBackdrop(): void {
    this.sessionSidebarCollapsed = true;
    if (this.mobileLayout) this.patchMobileSessionSidebar();
    else {
      localStorage.setItem("piWebSessionSidebarCollapsed", "true");
      this.render();
    }
  }

  private bindSessionSidebarEvents(): void {
    bindSessionShellEvents(this, {
      sessions: this.sessions,
      collapsedSessionGroups: this.collapsedSessionGroups,
      setThemePreference: (value) => {
        this.themePreference = isThemePreference(value) ? value : "system";
        localStorage.setItem(themeStorageKey, this.themePreference);
        applyThemePreference(this.themePreference);
        this.render();
      },
      saveSettings: (apiBase, token) => {
        if (apiBase) {
          this.apiBase = apiBase;
          localStorage.setItem("piWebApiBase", apiBase);
        }
        this.token = token;
        localStorage.setItem("piWebAuthToken", token);
        void this.refresh();
      },
      navigateToPath: (path) => this.navigateToPath(path),
      setSessionsSearch: (query) => {
        this.sessionsSearch = query;
        this.render();
      },
      createSession: (workspaceId, isolationKind) => this.createSession(workspaceId, isolationKind),
      updateMetadataModel: (model) => {
        void this.api<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ sessionMetadataModel: model ? { model } : null }) }).then((settings) => {
          this.appSettings = settings;
          this.render();
        }).catch((error) => {
          this.notice = `Settings update failed: ${error instanceof Error ? error.message : String(error)}`;
          this.render();
        });
      },
      toggleSessionSidebar: (buttonId) => this.toggleSessionSidebar(buttonId),
      hideSessionSidebarFromBackdrop: () => this.hideSessionSidebarFromBackdrop(),
      openSession: (session) => this.openSession(session),
      render: () => this.render(),
    });
  }

  private bindComposerControls(): void {
    bindComposerControls(this, {
      commandAutocomplete: () => this.commandAutocomplete,
      fileAutocomplete: () => this.fileAutocomplete,
      imagePickerActive: () => this.imagePickerActive,
      setImagePickerActive: (active) => { this.imagePickerActive = active; },
      setNotice: (notice) => { this.notice = notice; },
      render: () => this.render(),
      sendFromInput: (followUp) => this.sendFromInput(followUp),
      handleImageFiles: (files) => this.handleImageFiles(files),
      updatePromptDraft: (input) => this.updatePromptDraft(input),
      removePromptImage: (id) => this.removePromptImage(id),
      closeFileAutocomplete: () => this.closeFileAutocomplete(),
      closeCommandAutocomplete: () => this.closeCommandAutocomplete(),
      patchAutocompleteSelection: (kind) => this.patchAutocompleteSelection(kind),
      chooseCommandAutocomplete: () => this.chooseCommandAutocomplete(),
      chooseFileAutocomplete: () => this.chooseFileAutocomplete(),
    });
  }

  private bindEvents(): void {
    this.bindSessionSidebarEvents();
    this.querySelector<HTMLButtonElement>("#toggleSessionSidebarMobile")?.addEventListener("click", () => this.toggleSessionSidebar("toggleSessionSidebarMobile"));
    this.querySelector<HTMLButtonElement>("#pinSessionSidebar")?.addEventListener("click", () => {
      this.sessionSidebarPinned = true;
      this.sessionSidebarCollapsed = false;
      localStorage.setItem("piWebSessionSidebarPinned", "true");
      localStorage.setItem("piWebSessionSidebarCollapsed", "false");
      this.notice = "";
      this.render();
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("input", (event) => {
      this.editingTitleDraft = (event.currentTarget as HTMLInputElement).value;
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void this.updateSessionTitle((event.currentTarget as HTMLInputElement).value);
        return;
      }
      if (event.key === "Escape") {
        this.editingTitleDraft = null;
        (event.currentTarget as HTMLInputElement).value = this.selectedSession?.title ?? "";
        (event.currentTarget as HTMLInputElement).blur();
      }
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("focus", (event) => {
      this.editingTitleDraft = (event.currentTarget as HTMLInputElement).value;
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("blur", (event) => {
      void this.updateSessionTitle((event.currentTarget as HTMLInputElement).value);
    });
    this.querySelector<HTMLButtonElement>("#toggleSessionDetails")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.sessionDetailsOpen = !this.sessionDetailsOpen;
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#toggleIsolationDetails")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.sessionDetailsOpen = !this.sessionDetailsOpen;
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#closeSessionDetails")?.addEventListener("click", () => {
      this.sessionDetailsOpen = false;
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#copyWorkspacePath")?.addEventListener("click", () => this.copyWorkspacePath());
    this.querySelector<HTMLButtonElement>("#generateMetadata")?.addEventListener("click", () => void this.generateMetadataSuggestion());
    this.querySelectorAll<HTMLButtonElement>("#regenerateMetadata").forEach((button) => button.addEventListener("click", () => void this.generateMetadataSuggestion()));
    this.querySelector<HTMLButtonElement>("#toggleSessionSummary")?.addEventListener("click", () => this.setSummaryExpanded(!this.summaryExpanded()));
    this.querySelector<HTMLInputElement>("#metadataSuggestionTitle")?.addEventListener("input", (event) => this.updateMetadataSuggestionDraft("title", (event.currentTarget as HTMLInputElement).value));
    this.querySelector<HTMLTextAreaElement>("#metadataSuggestionSummary")?.addEventListener("input", (event) => this.updateMetadataSuggestionDraft("summary", (event.currentTarget as HTMLTextAreaElement).value));
    this.querySelectorAll<HTMLButtonElement>("#dismissMetadataSuggestion").forEach((button) => button.addEventListener("click", () => {
      this.metadataSuggestion = null;
      this.metadataSuggestionDraft = { title: "", summary: "" };
      this.metadataSuggestionError = "";
      this.render();
    }));
    this.querySelectorAll<HTMLButtonElement>("[data-dismiss-metadata]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset.dismissMetadata === "summary" ? "summary" : "title";
        this.dismissMetadataSuggestionField(kind);
        this.render();
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-accept-metadata]").forEach((button) => {
      button.addEventListener("click", () => void this.acceptMetadataSuggestion(button.dataset.acceptMetadata as MetadataAcceptKind));
    });
    this.bindComposerControls();
    this.bindRunningQueueControls();
    bindQuestionPanel(this.questionPanelContext());
    this.querySelector<HTMLButtonElement>("#abort")?.addEventListener("click", () => this.abort());
    this.querySelector<HTMLButtonElement>("#takeControl")?.addEventListener("click", () => this.takeControl());
    this.querySelector<HTMLButtonElement>("#attentionRefresh")?.addEventListener("click", () => void this.refresh());
    this.querySelectorAll<HTMLButtonElement>("[data-control-action='take']").forEach((button) => {
      button.addEventListener("click", () => this.takeControl());
    });
    this.querySelector<HTMLInputElement>("#autoScroll")?.addEventListener("change", (event) => {
      this.autoScroll = (event.currentTarget as HTMLInputElement).checked;
      if (this.autoScroll) this.jumpToLatest();
      else this.render();
    });
    this.querySelector<HTMLButtonElement>("#jumpToLatest")?.addEventListener("click", () => this.jumpToLatest());
    this.querySelector<HTMLInputElement>("#showThinking")?.addEventListener("change", (event) => {
      this.showThinking = (event.currentTarget as HTMLInputElement).checked;
      localStorage.setItem("piWebShowThinking", String(this.showThinking));
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#modelThinkingToggle")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const popoverWidth = Math.min(360, Math.max(280, viewportWidth - 16));
      const left = Math.max(8, Math.min(rect.right - popoverWidth, viewportWidth - popoverWidth - 8));
      const arrowLeft = Math.max(22, Math.min(rect.left + rect.width / 2 - left, popoverWidth - 22));
      this.modelThinkingAnchor = { left, bottom: Math.max(96, window.innerHeight - rect.top + 10), arrowLeft };
      this.modelThinkingPickerOpen = !this.modelThinkingPickerOpen;
      if (!this.modelThinkingPickerOpen) this.modelThinkingAnchor = null;
      this.render();
    });
    this.querySelector<HTMLDivElement>(".model-thinking-mobile-popover")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        this.modelThinkingPickerOpen = false;
        this.render();
      }
    });
    this.querySelector<HTMLSelectElement>("#model")?.addEventListener("change", (event) => {
      this.modelThinkingPickerOpen = false;
      this.setModel((event.currentTarget as HTMLSelectElement).value);
    });
    this.querySelector<HTMLSelectElement>("#thinking")?.addEventListener("change", (event) => {
      this.modelThinkingPickerOpen = false;
      this.setThinking((event.currentTarget as HTMLSelectElement).value);
    });

    this.querySelector<HTMLElement>(".transcript")?.addEventListener("click", (event) => {
      const activity = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-tool-activity]");
      if (activity) {
        event.preventDefault();
        const run = activity.closest<HTMLElement>(".tool-activity-run");
        const groupId = activity.dataset.toolActivity ?? "";
        const expanded = activity.dataset.toolActivityExpanded === "true";
        if (groupId) {
          if (expanded) this.expandedToolActivityIds.delete(groupId);
          else this.expandedToolActivityIds.add(groupId);
        }
        activity.dataset.toolActivityExpanded = expanded ? "false" : "true";
        activity.setAttribute("aria-expanded", expanded ? "false" : "true");
        activity.setAttribute("aria-label", `${expanded ? "Show" : "Hide"} tool details`);
        run?.classList.toggle("expanded", !expanded);
        return;
      }
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-row-action]");
      if (!button) {
        if (this.openActionMenuId) {
          this.openActionMenuId = "";
          this.render();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.rowAction as TranscriptRowMenuAction;
      void this.handleTranscriptRowAction(action, button.dataset.transcriptId ?? "");
    });
    const transcriptElement = this.querySelector<HTMLElement>(".transcript");
    transcriptElement?.addEventListener("wheel", () => this.markTranscriptUserScrollIntent(), { passive: true });
    transcriptElement?.addEventListener("touchmove", () => this.markTranscriptUserScrollIntent(), { passive: true });
    transcriptElement?.addEventListener("scroll", (event) => {
      this.transcriptFollow.handleScroll(event, {
        requestRender: () => this.requestRender(80),
        patchJumpToLatest: () => this.patchJumpToLatest(),
        scheduleFollow: () => this.scheduleTranscriptFollow(),
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-plan-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        button.blur();
        const action = button.dataset.planAction;
        if (action === "accept" || action === "chat") this.handlePlanAction(action, button.dataset.transcriptId ?? "");
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-file-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseFileAutocomplete(Number(button.dataset.fileIndex ?? "0")));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-command-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseCommandAutocomplete(Number(button.dataset.commandIndex ?? "0")));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-empty-quick-start]").forEach((button) => {
      button.addEventListener("click", () => this.useEmptyQuickStart(button.dataset.emptyQuickStart ?? ""));
    });

    this.querySelectorAll<HTMLButtonElement>("[data-fork-entry-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.forkFromEntry(button.dataset.forkEntryId ?? "");
      });
    });
  }

  private summaryExpanded(sessionId = this.selectedSession?.id): boolean {
    return sessionId ? localStorage.getItem(`piWebSessionSummaryExpanded:${sessionId}`) === "true" : false;
  }

  private setSummaryExpanded(expanded: boolean): void {
    if (!this.selectedSession) return;
    localStorage.setItem(`piWebSessionSummaryExpanded:${this.selectedSession.id}`, String(expanded));
    this.render();
  }

  private renderAppSettings(): string {
    const models = this.settings?.availableModels ?? [];
    const selected = this.appSettings?.sessionMetadataModel?.model ?? "";
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

  private renderSessionSummary(showSuggestion = !this.mobileLayout): string {
    if (!this.selectedSession) return "";
    return renderSessionSummaryHtml({
      session: this.selectedSession,
      suggestion: this.metadataSuggestion,
      draft: this.metadataSuggestionDraft,
      error: this.metadataSuggestionError,
      metadataGenerating: this.metadataGenerating,
      status: this.status,
      showSuggestion,
    });
  }

  private renderSessionDetails(): string {
    if (!this.selectedSession || !this.sessionDetailsOpen) return "";
    return `<div class="session-details-popover" role="dialog" aria-label="Session details">
      <div class="session-details-header">
        <strong>Session details</strong>
        <button id="closeSessionDetails" type="button" aria-label="Close session details">×</button>
      </div>
      <div class="session-details-path">
        <span>${this.selectedSession.isolationKind === "git_worktree" ? "Worktree" : "Workspace"}</span>
        <code title="${escapeHtml(this.selectedSession.cwd)}">${escapeHtml(this.selectedSession.cwd)}</code>
        <button id="copyWorkspacePath" type="button">Copy path</button>
      </div>
      ${this.selectedSession.isolationKind === "git_worktree" ? `
        <div class="session-details-path">
          <span>Source</span>
          <code title="${escapeHtml(this.selectedSession.sourceCwd ?? "")}">${escapeHtml(this.selectedSession.sourceCwd ?? "")}</code>
        </div>
        <div class="session-details-path">
          <span>Branch</span>
          <code title="${escapeHtml(this.selectedSession.worktreeBranch ?? "")}">${escapeHtml(this.selectedSession.worktreeBranch ?? "")}</code>
        </div>
        ${this.selectedSession.worktreeSourceDirty ? `<p class="notice">Created from HEAD; source had uncommitted changes that were not copied.</p>` : ""}
      ` : ""}
      ${this.renderSessionSummary(!this.mobileLayout)}
      <button id="generateMetadata" class="session-details-generate" type="button" ${this.metadataGenerating || this.status === "running" ? "disabled" : ""}>${this.metadataGenerating ? "Generating…" : "Suggest title and summary"}</button>
    </div>`;
  }

  private copyWorkspacePath(): void {
    if (!this.selectedSession) return;
    if (!navigator.clipboard?.writeText) {
      this.notice = "Clipboard access is not available in this browser.";
      this.render();
      return;
    }
    void navigator.clipboard.writeText(this.selectedSession.cwd).then(() => {
      this.notice = "Workspace path copied.";
      this.sessionDetailsOpen = false;
      this.render();
    }).catch((error) => {
      this.notice = `Could not copy workspace path: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    });
  }

  private renderMobileModelThinkingPopover(isController: boolean): string {
    if (!this.mobileLayout || !this.modelThinkingPickerOpen || !this.settings) return "";
    const anchor = this.modelThinkingAnchor;
    const style = anchor ? ` style="--model-menu-left: ${anchor.left}px; --model-menu-bottom: ${anchor.bottom}px; --model-menu-arrow-left: ${anchor.arrowLeft}px;"` : "";
    return `<div class="model-thinking-mobile-popover"${style}>
      ${renderModelThinkingPopover({ settings: this.settings, isController, open: true, defaultThinkingLevel: this.config?.modelPolicy.defaultThinkingLevel, showThinking: this.showThinking, includeShowThinking: true })}
    </div>`;
  }

  private renderMobileMetadataSuggestion(): string {
    if (!this.mobileLayout || !this.selectedSession || (!this.metadataSuggestion && !this.metadataSuggestionError && !this.metadataGenerating)) return "";
    return `<div class="metadata-mobile-popover" role="dialog" aria-label="Session title and summary suggestion">
      ${renderMetadataSuggestionHtml({
        suggestion: this.metadataSuggestion,
        draft: this.metadataSuggestionDraft,
        error: this.metadataSuggestionError,
        metadataGenerating: this.metadataGenerating,
        status: this.status,
        variant: "sheet",
      })}
    </div>`;
  }

  private bindRunningQueueControls(): void {
    this.querySelectorAll<HTMLButtonElement>("#toggleRunningQueueSection").forEach((button) => {
      button.addEventListener("click", () => {
        this.runningQueueSectionExpanded = !this.runningQueueSectionExpanded;
        this.render();
      });
    });
    this.querySelector<HTMLButtonElement>("#toggleRunningQueue")?.addEventListener("click", () => {
      this.runningQueueExpanded = !this.runningQueueExpanded;
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-edit-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.editQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.editQueuedMessage(queue, index, text);
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-cancel-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.cancelQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.cancelQueuedMessage(queue, index, text);
      });
    });
  }

  private patchAutocompleteSelection(kind: "command" | "file"): void {
    const selector = kind === "command" ? ".command-autocomplete" : ".file-autocomplete";
    const indexAttr = kind === "command" ? "commandIndex" : "fileIndex";
    const selectedIndex = kind === "command" ? this.commandAutocomplete.selectedIndex : this.fileAutocomplete.selectedIndex;
    const container = this.querySelector<HTMLElement>(selector);
    if (!container) return;
    container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.classList.toggle("selected", Number(button.dataset[indexAttr]) === selectedIndex);
    });
    this.syncAutocompleteScroll();
  }

  private patchCommandAutocomplete(): void {
    const existing = this.querySelector<HTMLElement>(".command-autocomplete");
    if (!existing) {
      this.render();
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = renderCommandAutocomplete(this.commandAutocomplete);
    const next = template.content.firstElementChild;
    if (!next) {
      existing.remove();
      return;
    }
    existing.replaceWith(next);
    next.querySelectorAll<HTMLButtonElement>("[data-command-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseCommandAutocomplete(Number(button.dataset.commandIndex ?? "0")));
    });
    this.syncAutocompleteScroll();
  }

  private patchFileAutocomplete(): void {
    const existing = this.querySelector<HTMLElement>(".file-autocomplete");
    if (!existing) {
      this.render();
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = renderFileAutocomplete(this.fileAutocomplete);
    const next = template.content.firstElementChild;
    if (!next) {
      existing.remove();
      return;
    }
    existing.replaceWith(next);
    next.querySelectorAll<HTMLButtonElement>("[data-file-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseFileAutocomplete(Number(button.dataset.fileIndex ?? "0")));
    });
    this.syncAutocompleteScroll();
  }


  private renderQuestionPanel(isController: boolean): string {
    return renderQuestionPanelHtml(this.pendingQuestion, isController, this.connectionState === "connected");
  }


  private renderRunningQueueHtml(): string {
    const rendered = renderRunningQueue(this.runningQueue, this.runningQueueExpanded, this.mobileLayout && !this.runningQueueSectionExpanded);
    this.runningQueueExpanded = rendered.expanded;
    return rendered.html;
  }

  private activePlanActionItem(): TranscriptItem | null {
    return findActivePlanActionItem(this.transcript, this.dismissedPlanActionTranscriptId);
  }

  private renderPlanComposerTakeover(item: TranscriptItem): string {
    return renderPlanComposerTakeoverHtml(item);
  }

  private renderAttentionNeeded(): string {
    return renderAttentionNeededHtml({ controller: this.controller, connectionState: this.connectionState });
  }

  private renderTranscript(): string {
    return renderTranscriptShell({
      selectedSession: Boolean(this.selectedSession),
      transcript: this.transcript,
      status: this.status,
      expandedToolActivityIds: this.expandedToolActivityIds,
    });
  }

  private useEmptyQuickStart(action: string): void {
    if (action === "screenshot") {
      this.querySelector<HTMLButtonElement>("#attachImages")?.click();
      return;
    }
    const draft = action === "plan" ? "/plan " : action === "file" ? "@" : action === "bash" ? "!" : "";
    if (!draft) return;
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    if (!input || input.disabled) return;
    input.focus();
    input.value = draft;
    input.setSelectionRange(draft.length, draft.length);
    this.updatePromptDraft(input);
  }

  private renderJumpToLatest(): string {
    if (this.transcript.length === 0) return "";
    return this.transcriptFollow.renderJumpToLatest();
  }

  private isTranscriptNearBottom(transcript = this.querySelector<HTMLElement>(".transcript")): boolean {
    return this.transcriptFollow.isNearBottom(transcript);
  }

  private scrollTranscriptToBottom(): void {
    this.transcriptFollow.scrollToBottom(this, "app-scroll-bottom");
  }

  private jumpToLatest(): void {
    this.transcriptFollow.jumpToLatest(this);
    this.render();
  }

  private scheduleTranscriptFollow(): void {
    this.transcriptFollow.scheduleFollow(this, "app-scheduled-follow");
  }

  private syncTranscriptScroll(): void {
    this.transcriptFollow.syncScroll(this);
  }

  private syncAutocompleteScroll(): void {
    const selector = this.commandAutocomplete.active ? ".command-autocomplete" : this.fileAutocomplete.active ? ".file-autocomplete" : null;
    if (!selector) return;
    const container = this.querySelector<HTMLElement>(selector);
    const selected = container?.querySelector<HTMLElement>("button.selected");
    if (!container || !selected) return;

    const selectedTop = selected.offsetTop;
    const selectedBottom = selectedTop + selected.offsetHeight;
    const visibleTop = container.scrollTop;
    const visibleBottom = visibleTop + container.clientHeight;
    if (selectedTop < visibleTop) container.scrollTop = selectedTop;
    else if (selectedBottom > visibleBottom) container.scrollTop = selectedBottom - container.clientHeight;
  }

  private transcriptRowStateOptions(): TranscriptRowStateOptions {
    return {
      showThinking: this.showThinking,
      selectedTranscriptId: this.selectedTranscriptId,
      transcriptExpansion: this.transcriptExpansion,
      openActionMenuId: this.openActionMenuId,
      canFork: (item) => Boolean(this.forkEntryIdForTranscriptItem(item)),
      renderedSegmentCache: this.renderedSegmentCache,
      localImageUrl: (path) => this.localImageUrl(path),
    };
  }

  private transcriptBindingOptions(): TranscriptBindingOptions {
    return {
      onCloseActionMenu: () => { this.openActionMenuId = ""; },
      onSelect: (id) => this.selectTranscriptItem(id),
    };
  }

  private hydrateTranscriptRows(): void {
    hydrateTranscriptDomRows(this, this.transcript, this.transcriptRowStateOptions(), this.transcriptBindingState, this.transcriptBindingOptions());
  }

  private renderStatusPill(): string {
    return renderStatusPillHtml(this.selectedSession, this.status);
  }

  private patchHeaderStatus(): void {
    patchHeaderStatusWithHtml(this, this.renderStatusPill());
  }

  private connectionBannerState() {
    return {
      selectedSession: this.selectedSession,
      connectionState: this.connectionState,
      connectionMessage: this.connectionMessage,
      promptDraft: this.promptDraft,
      promptImageCount: this.promptImages.length,
    };
  }

  private patchConnectionBanner(): void {
    patchConnectionBannerWithState(this, this.connectionBannerState());
  }

  private shouldRenderConnectionBanner(): boolean {
    return shouldRenderConnectionBannerForState(this.connectionBannerState());
  }

  private renderConnectionBanner(): string {
    return renderConnectionBannerHtml(this.connectionBannerState());
  }

  private renderConnectionBannerContent(): string {
    return renderConnectionBannerContentHtml(this.connectionBannerState());
  }

  private patchJumpToLatest(): void {
    this.transcriptFollow.patchJumpToLatest(this, () => this.jumpToLatest());
  }

  private patchRunningQueue(): void {
    const shell = this.querySelector<HTMLElement>(".transcript-shell");
    if (!shell) return;
    const hasQueueItems = hasRunningQueueItems(this.runningQueue);
    shell.classList.toggle("has-running-queue", hasQueueItems);
    const existing = shell.querySelector<HTMLElement>(".running-queue");
    const rendered = renderRunningQueue(this.runningQueue, this.runningQueueExpanded, this.mobileLayout && !this.runningQueueSectionExpanded);
    this.runningQueueExpanded = rendered.expanded;
    if (!rendered.html) {
      existing?.remove();
      this.syncRunningQueueHeight(shell);
      return;
    }
    if (existing) {
      existing.outerHTML = rendered.html;
      this.bindRunningQueueControls();
      this.syncRunningQueueHeight(shell);
      return;
    }
    const jump = shell.querySelector<HTMLElement>(".jump-to-latest");
    if (jump) jump.insertAdjacentHTML("beforebegin", rendered.html);
    else shell.insertAdjacentHTML("beforeend", rendered.html);
    this.bindRunningQueueControls();
    this.syncRunningQueueHeight(shell);
  }

  private syncRunningQueueHeight(shell = this.querySelector<HTMLElement>(".transcript-shell")): void {
    if (!shell) return;
    const queue = shell.querySelector<HTMLElement>(".running-queue");
    if (!queue) {
      if (shell.style.getPropertyValue("--running-queue-height")) recordPerfEvent("queueHeight", "removed", { height: 0 });
      shell.style.removeProperty("--running-queue-height");
      return;
    }
    const height = Math.ceil(queue.getBoundingClientRect().height);
    const nextValue = `${height}px`;
    if (shell.style.getPropertyValue("--running-queue-height") !== nextValue) recordPerfEvent("queueHeight", "changed", { height });
    shell.style.setProperty("--running-queue-height", nextValue);
  }

  private replaceHtmlPreservingTranscript(html: string): void {
    replaceHtmlPreservingTranscriptRows(this, html);
  }

  private patchTranscriptStructure(transcript: HTMLElement): void {
    patchTranscriptStructureHtml({
      host: this,
      transcript,
      items: this.transcript,
      dirtyIds: this.dirtyTranscriptIds,
      renderTranscript: () => this.renderTranscript(),
      hydrateRows: () => this.hydrateTranscriptRows(),
      markClean: () => {
        this.transcriptStructureDirty = false;
        this.dirtyTranscriptIds.clear();
      },
    });
  }

  private syncRunningElapsedTimer(): void {
    const shouldTick = this.status === "running" && Boolean(latestGroupableToolGroupId(this.transcript));
    if (shouldTick && !this.runningElapsedTimer) {
      this.runningElapsedTimer = setInterval(() => {
        if (this.status !== "running" || !latestGroupableToolGroupId(this.transcript)) {
          this.syncRunningElapsedTimer();
          return;
        }
        if (!this.patchRunningToolGroupElapsed()) this.requestRender(0);
      }, 1_000);
    } else if (!shouldTick && this.runningElapsedTimer) {
      clearInterval(this.runningElapsedTimer);
      this.runningElapsedTimer = undefined;
    }
  }

  private patchRunningToolGroupElapsed(): boolean {
    return patchRunningToolGroupElapsedReceipt(this, this.transcript);
  }

  private syncOpenActionMenus(root: ParentNode = this): void {
    syncTranscriptOpenActionMenus(root, this.openActionMenuId);
  }

  private patchLiveRender(): boolean {
    const start = performance.now();
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript || this.forceFullRender) return false;
    this.transcriptFollow.disableFollowIfDetached(transcript);

    if (this.transcriptStructureDirty) {
      this.patchTranscriptStructure(transcript);
      this.patchHeaderStatus();
      this.patchConnectionBanner();
      this.patchComposerMode();
      this.patchRunningQueue();
      this.patchJumpToLatest();
      this.syncOpenActionMenus(transcript);
      this.syncTranscriptScroll();
      this.syncAutocompleteScroll();
      this.shellPatchDirty = false;
      recordTranscriptPatchSample(start, "structure");
      return true;
    }

    const rowOptions = this.transcriptRowStateOptions();
    patchDirtyTranscriptRows(this, transcript, this.transcript, this.dirtyTranscriptIds, rowOptions, this.transcriptBindingState, this.transcriptBindingOptions());
    this.dirtyTranscriptIds.clear();
    this.patchHeaderStatus();
    this.patchConnectionBanner();
    this.patchComposerMode();
    this.patchRunningQueue();
    this.patchJumpToLatest();
    this.syncOpenActionMenus(transcript);
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    this.shellPatchDirty = false;
    recordTranscriptPatchSample(start, "dirty-rows");
    return true;
  }

  private requestRender(delayMs = this.status === "running" ? 150 : 0): void {
    if (this.renderScheduled) {
      if (delayMs !== 0 || !this.renderTimer) return;
      clearTimeout(this.renderTimer);
      this.renderScheduled = false;
      this.renderTimer = undefined;
    }
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      if ((delayMs > 0 || this.shellPatchDirty || this.transcriptStructureDirty || this.dirtyTranscriptIds.size > 0) && this.patchLiveRender()) return;
      recordPerfEvent("renderFallback", "request-render", { delayMs, shellPatchDirty: this.shellPatchDirty, transcriptStructureDirty: this.transcriptStructureDirty, dirtyRows: this.dirtyTranscriptIds.size, forceFullRender: this.forceFullRender });
      this.render();
    }, delayMs);
  }

  private isComposerNotice(): boolean {
    return isComposerNoticeMessage(this.notice);
  }

  private renderComposerNotice(): string {
    return renderComposerNoticeHtml(this.notice);
  }

  private isBashPromptDraft(): boolean {
    return isComposerBashPromptDraft(this.promptDraft);
  }

  private patchComposerMode(): void {
    patchComposerModeWithState(this, {
      promptDraft: this.promptDraft,
      imageCount: this.promptImages.length,
      status: this.status,
      isController: this.controller?.isController ?? true,
    });
  }

  private renderContextUsageNotice(): string {
    const usage = this.settings?.contextUsage;
    if (!this.selectedSession || !usage) return "";
    const percent = Math.max(0, Math.min(100, usage.percent ?? 0));
    const title = usage.tokens === null
      ? `Context usage is currently unknown. Model context window: ${usage.contextWindow.toLocaleString()} tokens.`
      : `Estimated context usage: ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${usage.percent?.toFixed(2) ?? "unknown"}%).`;
    return `<div class="context-usage" aria-label="Model context usage" title="${escapeHtml(title)}">
      <span class="context-usage-full"><strong>Context</strong> ${escapeHtml(contextUsageLabel(usage))}</span>
      <span class="context-usage-compact" aria-hidden="true"><strong>Ctx</strong> ${escapeHtml(contextUsagePercentLabel(usage))}</span>
      <span class="context-usage-bar" aria-hidden="true"><i style="width: ${percent}%"></i></span>
    </div>`;
  }

  private renderViewerCount(): string {
    return renderViewerCountHtml(this.selectedSession, this.controller);
  }

  private renderSessionsMain(): string {
    const chatPath = this.selectedSession ? sessionRoutePath(this.selectedSession.id) : "/";
    return `<main class="sessions-main">
      <header>
        <button id="toggleSessionSidebarMobile" class="mobile-menu-button" type="button" title="${this.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}" aria-label="${this.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}">☰</button>
        <div class="session-identity">
          <strong>Sessions</strong>
          <span>Find and resume prior work across local Bakery sessions.</span>
        </div>
        <div class="header-status">
          <button type="button" data-route-path="${escapeHtml(chatPath)}">${this.selectedSession ? "Current chat" : "Chat"}</button>
        </div>
      </header>
      ${this.notice && !this.isComposerNotice() ? `<p class="notice app-notice">${escapeHtml(this.notice)}</p>` : ""}
      ${renderSessionsPage({ sessions: this.sessions, selectedSessionId: this.selectedSession?.id, collapsedGroups: this.collapsedSessionGroups, status: this.status, searchQuery: this.sessionsSearch })}
    </main>`;
  }

  private renderSettingsMain(): string {
    const chatPath = this.selectedSession ? sessionRoutePath(this.selectedSession.id) : "/";
    return `<main class="settings-main">
      <header>
        <button id="toggleSessionSidebarMobile" class="mobile-menu-button" type="button" title="${this.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}" aria-label="${this.sessionSidebarCollapsed ? "Show navigation" : "Hide navigation"}">☰</button>
        <div class="session-identity">
          <strong>Settings</strong>
          <span>Configure this browser's Bakery connection and app preferences.</span>
        </div>
        <div class="header-status">
          <button type="button" data-route-path="${escapeHtml(chatPath)}">${this.selectedSession ? "Current chat" : "Chat"}</button>
        </div>
      </header>
      ${this.notice && !this.isComposerNotice() ? `<p class="notice app-notice">${escapeHtml(this.notice)}</p>` : ""}
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
              <input id="apiBase" value="${escapeHtml(this.apiBase)}" spellcheck="false" />
            </label>
            <label>Token
              <input id="token" type="password" value="${escapeHtml(this.token)}" autocomplete="off" />
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
                <option value="system" ${this.themePreference === "system" ? "selected" : ""}>System</option>
                <option value="workbench-dark" ${this.themePreference === "workbench-dark" ? "selected" : ""}>Workbench Dark</option>
                <option value="workbench-light" ${this.themePreference === "workbench-light" ? "selected" : ""}>Workbench Light</option>
              </select>
            </label>
          </section>
          <section class="settings-card" aria-labelledby="metadataSettingsHeading">
            <div class="settings-card-heading">
              <h2 id="metadataSettingsHeading">Session metadata</h2>
              <p>Titles and summaries are generated only when you click ✨ in session details.</p>
            </div>
            ${this.renderAppSettings()}
          </section>
        </div>
      </section>
    </main>`;
  }

  private render(): void {
    this.syncRunningElapsedTimer();
    const renderStart = performance.now();
    const existingTranscript = this.querySelector<HTMLElement>(".transcript");
    this.transcriptFollow.captureScrollTop(existingTranscript);
    const prompt = this.querySelector<HTMLTextAreaElement>("#prompt");
    const titleInput = this.querySelector<HTMLInputElement>("#sessionTitle");
    const sessionsSearchInput = this.querySelector<HTMLInputElement>("#sessionsSearch");
    const apiBaseInput = this.querySelector<HTMLInputElement>("#apiBase");
    const tokenInput = this.querySelector<HTMLInputElement>("#token");
    const restorePromptFocus = document.activeElement === prompt;
    const restoreTitleFocus = document.activeElement === titleInput;
    const restoreSessionsSearchFocus = document.activeElement === sessionsSearchInput;
    const restoreApiBaseFocus = document.activeElement === apiBaseInput;
    const restoreTokenFocus = document.activeElement === tokenInput;
    const activeQuestionOptionIndex = (document.activeElement as HTMLElement | null)?.getAttribute("data-question-option-index");
    const promptSelectionStart = prompt?.selectionStart ?? this.promptDraft.length;
    const promptSelectionEnd = prompt?.selectionEnd ?? promptSelectionStart;
    const titleSelectionStart = titleInput?.selectionStart ?? (this.editingTitleDraft?.length ?? 0);
    const titleSelectionEnd = titleInput?.selectionEnd ?? titleSelectionStart;
    const sessionsSearchSelectionStart = sessionsSearchInput?.selectionStart ?? this.sessionsSearch.length;
    const sessionsSearchSelectionEnd = sessionsSearchInput?.selectionEnd ?? sessionsSearchSelectionStart;
    const apiBaseSelectionStart = apiBaseInput?.selectionStart ?? this.apiBase.length;
    const apiBaseSelectionEnd = apiBaseInput?.selectionEnd ?? apiBaseSelectionStart;
    const tokenSelectionStart = tokenInput?.selectionStart ?? this.token.length;
    const tokenSelectionEnd = tokenInput?.selectionEnd ?? tokenSelectionStart;
    const isRunning = this.status === "running";
    const activePlanActionItem = this.activePlanActionItem();
    const sidebarOverlayOpen = this.sidebarOverlayOpen();
    this.classList.toggle("session-sidebar-collapsed", this.sessionSidebarCollapsed);
    this.classList.toggle("session-sidebar-overlay-open", sidebarOverlayOpen);
    this.classList.toggle("mobile-layout", this.mobileLayout);
    const isController = this.controller?.isController ?? true;
    const selectedTitle = this.selectedSession ? (this.editingTitleDraft ?? this.selectedSession.title ?? "") : "";
    const selectedTitlePlaceholder = this.selectedSession ? sessionTitlePlaceholder(this.selectedSession) : "";
    const selectedMeta = this.selectedSession ? sessionMetadataLabel(this.selectedSession) : "";
    const selectedIsIsolated = this.selectedSession?.isolationKind === "git_worktree";
    const headerClasses = [
      this.modelThinkingPickerOpen ? "model-picker-open" : "",
    ].filter(Boolean).join(" ");
    const isBashDraft = this.isBashPromptDraft();
    const bashNoContext = isNoContextBashPromptDraft(this.promptDraft);
    const currentComposerModeLabel = composerModeLabel(this.promptDraft, this.status);
    const canSendFromComposer = isController && this.hasComposerSendContent();
    const promptSendDisabled = canSendFromComposer ? "" : "disabled";
    const attachIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.5 12.4 21a6 6 0 0 1-8.5-8.5l9.2-9.1a4 4 0 0 1 5.6 5.7l-9.2 9.1a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>`;
    const sendIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5" /><path d="m6 11 6-6 6 6" /></svg>`;
    const followUpIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h7a4 4 0 0 1 0 8H5" /><path d="m8 12-3 4 3 4" /></svg>`;
    const stopIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>`;
    const route = parseAppRoute(window.location.pathname);
    if (route.kind === "sessions" || route.kind === "settings") {
      this.innerHTML = `
        ${this.renderSessionSidebarBackdrop()}
        ${this.renderSessionSidebar()}
        ${route.kind === "settings" ? this.renderSettingsMain() : this.renderSessionsMain()}
      `;
      this.forceFullRender = false;
      this.transcriptStructureDirty = false;
      this.dirtyTranscriptIds.clear();
      this.bindEvents();
      if (restoreSessionsSearchFocus) {
        const nextSearch = this.querySelector<HTMLInputElement>("#sessionsSearch");
        if (nextSearch) {
          nextSearch.focus();
          const max = nextSearch.value.length;
          nextSearch.setSelectionRange(Math.min(sessionsSearchSelectionStart, max), Math.min(sessionsSearchSelectionEnd, max));
        }
      }
      if (restoreApiBaseFocus) {
        const nextApiBase = this.querySelector<HTMLInputElement>("#apiBase");
        if (nextApiBase) {
          nextApiBase.focus();
          const max = nextApiBase.value.length;
          nextApiBase.setSelectionRange(Math.min(apiBaseSelectionStart, max), Math.min(apiBaseSelectionEnd, max));
        }
      }
      if (restoreTokenFocus) {
        const nextToken = this.querySelector<HTMLInputElement>("#token");
        if (nextToken) {
          nextToken.focus();
          const max = nextToken.value.length;
          nextToken.setSelectionRange(Math.min(tokenSelectionStart, max), Math.min(tokenSelectionEnd, max));
        }
      }
      this.syncAutocompleteScroll();
      recordPerfSample("render", performance.now() - renderStart, "route");
      return;
    }
    this.replaceHtmlPreservingTranscript(`
      ${this.renderSessionSidebarBackdrop()}
      ${this.renderSessionSidebar()}
      <main>
        <header class="${headerClasses}">
          <button id="toggleSessionSidebarMobile" class="mobile-menu-button" type="button" title="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}" aria-label="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}">☰</button>
          <div class="session-identity">
            ${this.selectedSession ? `<div class="session-title-row"><input id="sessionTitle" class="session-title-input" size="${Math.min(52, Math.max(12, selectedTitle.length || selectedTitlePlaceholder.length))}" value="${escapeHtml(selectedTitle)}" placeholder="${escapeHtml(selectedTitlePlaceholder)}" aria-label="Session title" title="Edit session title" />
              ${selectedIsIsolated ? `<button id="toggleIsolationDetails" class="session-isolation-chip ${this.sessionDetailsOpen ? "active" : ""}" type="button" title="This session runs in an isolated Git worktree" aria-label="Isolated Git worktree session. Open session details" aria-expanded="${this.sessionDetailsOpen}"><span class="session-isolation-icon" aria-hidden="true">⎇</span><span class="session-isolation-label">Isolated</span></button>` : ""}
              <button id="toggleSessionDetails" class="session-details-button ${this.sessionDetailsOpen ? "active" : ""}" type="button" title="Session details" aria-label="Session details" aria-expanded="${this.sessionDetailsOpen}"><span class="session-details-label">Details</span><span class="session-details-icon" aria-hidden="true">i</span></button></div>
              <span class="session-workspace" title="${escapeHtml(this.selectedSession.cwd)}">${escapeHtml(selectedMeta)}</span>
              ${this.renderSessionDetails()}` : `<strong>Create or open a session</strong><span>Select a workspace on the left to start.</span>`}
          </div>
          <div class="header-status">
            ${!isController ? `<button id="takeControl">Take control</button>` : ""}
            ${this.renderStatusPill()}
          </div>
        </header>
        ${this.renderConnectionBanner()}
        ${this.renderAttentionNeeded()}
        ${this.notice && !this.isComposerNotice() ? `<p class="notice app-notice">${escapeHtml(this.notice)}</p>` : ""}
        <div class="transcript-shell ${hasRunningQueueItems(this.runningQueue) ? "has-running-queue" : ""}">
          <section class="transcript ${this.transcript.length === 0 ? "empty" : ""}">${this.renderTranscript()}</section>
          ${this.renderRunningQueueHtml()}
          ${this.renderJumpToLatest()}
        </div>
        <footer class="${isRunning ? "running-footer" : ""} ${activePlanActionItem ? "plan-takeover-footer" : ""} ${this.modelThinkingPickerOpen ? "model-picker-open" : ""}">
          ${this.renderQuestionPanel(isController)}
          ${activePlanActionItem ? this.renderPlanComposerTakeover(activePlanActionItem) : `
            <div class="prompt-shell ${isBashDraft ? "bash-mode" : ""} ${bashNoContext ? "no-context" : ""}">
              ${renderPromptImages(this.promptImages)}
              <div class="composer-mode ${isBashDraft ? "bash-mode" : isRunning ? "running" : "idle"} ${bashNoContext ? "no-context" : ""} ${this.modelThinkingPickerOpen ? "model-picker-open" : ""}">
                <strong>${escapeHtml(currentComposerModeLabel)}</strong>
                <span class="composer-mode-spacer" aria-hidden="true"></span>
                ${this.settings ? renderModelThinkingPicker({ settings: this.settings, isController, open: this.modelThinkingPickerOpen, defaultThinkingLevel: this.config?.modelPolicy.defaultThinkingLevel, showThinking: this.showThinking, includeShowThinking: true, renderPopover: !this.mobileLayout }) : ""}
                ${this.renderViewerCount()}
                ${this.renderContextUsageNotice()}
              </div>
              <textarea id="prompt" rows="2" ${isController ? "" : "disabled"} placeholder="${isController ? (isRunning ? "Steer the active run..." : "Ask pi... Paste/drop screenshots, type / for commands or @ for files.") : "Viewer mode — take control to send"}">${escapeHtml(this.promptDraft)}</textarea>
              ${this.renderComposerNotice()}
              ${renderCommandAutocomplete(this.commandAutocomplete)}
              ${renderFileAutocomplete(this.fileAutocomplete)}
              <div class="controls ${isRunning ? "running" : ""}">
                <button id="attachImages" class="icon-button" data-tooltip="Attach screenshot" aria-label="Attach screenshot" ${isController ? "" : "disabled"}>${attachIcon}</button>
                <button id="send" class="primary-action icon-send" data-tooltip="${isRunning ? "Guide active run · Enter" : "Send · Enter"}" aria-label="${isRunning ? "Guide active run" : "Send"}" ${promptSendDisabled}>${sendIcon}<span class="running-action-label" aria-hidden="true">Guide</span><span class="sr-only">${isRunning ? "Guide active run" : "Send"}</span></button>
                <button id="followUp" class="secondary-action icon-button ${isRunning ? "" : "hidden"}" data-tooltip="Queue follow-up · Alt+Enter" aria-label="Queue follow-up" ${promptSendDisabled}>${followUpIcon}<span class="running-action-label" aria-hidden="true">Follow up</span></button>
                <button id="abort" class="danger icon-button ${isRunning ? "" : "hidden"}" data-tooltip="Stop run" aria-label="Stop run" ${isController ? "" : "disabled"}>${stopIcon}</button>
              </div>
            </div>
          `}
        </footer>
      </main>
      ${this.renderMobileMetadataSuggestion()}
      ${this.renderMobileModelThinkingPopover(isController)}
    `);
    this.forceFullRender = false;
    this.transcriptStructureDirty = false;
    this.dirtyTranscriptIds.clear();
    this.bindEvents();
    this.hydrateTranscriptRows();
    if (restoreTitleFocus) {
      const nextTitle = this.querySelector<HTMLInputElement>("#sessionTitle");
      if (nextTitle) {
        nextTitle.focus();
        const max = nextTitle.value.length;
        nextTitle.setSelectionRange(Math.min(titleSelectionStart, max), Math.min(titleSelectionEnd, max));
      }
    } else if (restorePromptFocus || this.focusPromptOnNextReadyRender) {
      const nextPrompt = this.querySelector<HTMLTextAreaElement>("#prompt");
      if (nextPrompt && !nextPrompt.disabled) {
        nextPrompt.focus();
        const max = nextPrompt.value.length;
        const start = this.focusPromptOnNextReadyRender ? max : Math.min(promptSelectionStart, max);
        const end = this.focusPromptOnNextReadyRender ? max : Math.min(promptSelectionEnd, max);
        nextPrompt.setSelectionRange(start, end);
        if (!this.focusPromptOnNextReadyRender || this.connectionState === "connected") this.focusPromptOnNextReadyRender = false;
      }
    } else if (activeQuestionOptionIndex) {
      this.querySelector<HTMLElement>(`[data-question-option-index="${CSS.escape(activeQuestionOptionIndex)}"]`)?.focus();
    }
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    if (this.focusPendingQuestionOnNextRender) {
      this.focusPendingQuestionOnNextRender = false;
      focusQuestionPanelWithContext(this.questionPanelContext());
    }
    recordPerfSample("render", performance.now() - renderStart, "session");
  }
}

customElements.define("pi-web-agent", PiWebAgentApp);
