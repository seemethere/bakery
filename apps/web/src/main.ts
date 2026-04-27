import { PROTOCOL_VERSION, type AppSettings, type CommandResponse, type ContextUsage, type ControllerInfo, type FileCompleteResponse, type FileSearchResponse, type HelloMessage, type NavigateTreeResponse, type PendingQuestion, type ServerEnvelope, type SessionMetadataSuggestion, type SessionRuntimeSettings, type SessionSnapshot, type SessionTreeNode, type SessionTreeResponse, type WebSession, type Workspace } from "@pi-web-agent/protocol";
import { closedCommandAutocompleteState, closedFileAutocompleteState, commandAutocompleteToken, fileAutocompleteToken, renderCommandAutocomplete, renderFileAutocomplete, type AutocompleteToken, type CommandAutocompleteState, type FileAutocompleteState } from "./autocomplete";
import { flattenSessionTree, currentSessionTreeEntryId, currentSessionTreePath, forkEntryIdForTranscriptItem as findForkEntryIdForTranscriptItem, nextSessionTreeActiveEntryId, renderCurrentSessionTreePath, renderSessionTreeNodes } from "./session-tree";
import { compactSnapshotTranscript, compactToolSummaryLine, compactWorkflowLaunchSummary, formatToolTitle, isRenderableTranscriptItem, isToolCallOnlyAssistant, itemHasRenderedImage, looksLikeHtml, looksLikeMarkdown, looksLikeSvg, mergeDuplicateToolResult, messageToTranscriptItem, PiTranscriptRow, questionSummaryFromTool, renderMarkdown, renderTranscriptSegments, shouldPreferPendingToolTitle, toolArgsToText, toolCallTitlesForItem, toolResultToSegments, toolResultToText, type ToolGroupPosition, type TranscriptItem } from "./transcript";
import { formatMetadataError, metadataPatchForSuggestion, provisionalTitleFromPrompt, renderMetadataSuggestion as renderMetadataSuggestionHtml, renderSessionSummary as renderSessionSummaryHtml, sessionMetadataLabel, sessionTitlePlaceholder, type MetadataAcceptKind, type MetadataSuggestionDraft } from "./session-metadata";
import { groupedSessions, isSessionRecencyGroupId, persistCollapsedSessionGroups, renderSessionGroups, storedCollapsedSessionGroups, type SessionRecencyGroupId } from "./session-sidebar";
import { TranscriptFollowController } from "./transcript-follow";
import { addRunningQueueItem, emptyRunningQueue, hasRunningQueueItems, removeRunningQueueItem, renderRunningQueue, runningQueueCount, runningQueueFromUpdate, type RunningQueueName, type RunningQueueState } from "./running-queue";
import { escapeHtml, isRecord, recordPerfSample, stringify } from "./utils";
import "./styles.css";

declare global {
  interface Window {
    __piWebImageFailed?: (src: string) => void;
    __piWebFailedImageCount?: number;
  }
}

type AgentStatus = SessionSnapshot["status"] | "disconnected" | "connecting";
type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "retry_failed";
type RightPanelTab = "details" | "preview" | "tree";
type TranscriptRowAction = "copy" | "details" | "preview" | "fork";
type ThemePreference = "system" | "workbench-dark" | "workbench-light";
type PromptImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

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

const supportedPromptImageTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const maxPromptImages = 4;
const maxPromptImageBytes = 8 * 1024 * 1024;
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
  private transcript: TranscriptItem[] = [];
  private status: AgentStatus = "disconnected";
  private connectionState: ConnectionState = "disconnected";
  private connectionMessage = "No session connected.";
  private notice = "";
  private controller: ControllerInfo | null = null;
  private settings: SessionRuntimeSettings | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private appSettings: AppSettings | null = null;
  private metadataSuggestion: SessionMetadataSuggestion | null = null;
  private metadataSuggestionDraft: MetadataSuggestionDraft = { title: "", summary: "" };
  private metadataSuggestionError = "";
  private metadataGenerating = false;
  private editingTitleDraft: string | null = null;
  private sessionTree: SessionTreeResponse | null = null;
  private treeDrawerOpen = false;
  private treeActiveEntryId = "";
  private focusTreeOnNextRender = false;
  private scrollTreeCurrentAfterRefresh = false;
  private lastSelectedSessionId = localStorage.getItem("piWebLastSessionId") ?? "";
  private readonly transcriptFollow = new TranscriptFollowController();
  private showThinking = localStorage.getItem("piWebShowThinking") === "true";
  private themePreference: ThemePreference = storedThemePreference();
  private sessionSidebarCollapsed = localStorage.getItem("piWebSessionSidebarCollapsed") === "true";
  private sessionSidebarPinned = localStorage.getItem("piWebSessionSidebarPinned") === "true";
  private collapsedSessionGroups = storedCollapsedSessionGroups();
  private rightPanelTab: RightPanelTab = (localStorage.getItem("piWebRightPanelTab") as RightPanelTab | null) ?? "details";
  private rightPanelCollapsed = localStorage.getItem("piWebRightPanelCollapsed") === "true";
  private mobileLayout = window.matchMedia(mobileLayoutMediaQuery).matches;
  private selectedTranscriptId = localStorage.getItem("piWebSelectedTranscriptId") ?? "";
  private openActionMenuId = "";
  private transcriptPointerDown: { id: string; x: number; y: number } | null = null;
  private pendingToolCallTitles: string[] = [];
  private promptDraft = "";
  private promptImages: PromptImage[] = [];
  private runningQueue: RunningQueueState = emptyRunningQueue();
  private runningQueueExpanded = false;
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
  private renderScheduled = false;
  private forceFullRender = false;
  private transcriptStructureDirty = false;
  private dirtyTranscriptIds = new Set<string>();
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
    this.mobileLayout = this.mobileLayoutMedia.matches;
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
  private openImagePicker(): void {
    this.imagePickerActive = true;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.top = "0";
    input.addEventListener("change", () => {
      this.imagePickerActive = false;
      const files = Array.from(input.files ?? []);
      this.notice = files.length > 0
        ? `Selected ${files.length} image file${files.length === 1 ? "" : "s"}: ${files.map((file) => `${file.name || "unnamed"}${file.type ? ` (${file.type})` : ""}`).join(", ")}`
        : "File picker returned no files.";
      this.render();
      void this.handleImageFiles(files);
      input.remove();
    }, { once: true });
    document.body.append(input);
    input.click();
  }
  private readonly questionKeyHandler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !this.pendingQuestion || !this.querySelector(".question-panel")) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest(".question-panel")) return;
    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End", "Enter", " ", "Escape"].includes(event.key) || /^[1-9]$/.test(event.key) || event.key.toLowerCase() === "c") {
      this.handleQuestionPanelKeydown(event);
    }
  };
  private readonly sidebarKeyHandler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape" || this.sessionSidebarCollapsed || this.sessionSidebarPinned) return;
    this.sessionSidebarCollapsed = true;
    localStorage.setItem("piWebSessionSidebarCollapsed", "true");
    this.notice = "Session menu hidden.";
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
    window.visualViewport?.removeEventListener("resize", this.viewportResizeHandler);
    this.themeMedia.removeEventListener("change", this.themeMediaHandler);
    this.mobileLayoutMedia.removeEventListener("change", this.mobileLayoutHandler);
    this.persistAttachmentWarningIfNeeded();
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
    if (isToolCallOnlyAssistant(item)) {
      this.pendingToolCallTitles.push(...toolCallTitlesForItem(item));
      const existingIndex = this.transcript.findIndex((candidate) => candidate.id === item.id);
      if (existingIndex !== -1) {
        this.transcript.splice(existingIndex, 1);
        this.transcriptStructureDirty = true;
      }
      return;
    }

    let nextItem = item;
    if (nextItem.kind === "tool" && this.pendingToolCallTitles.length > 0) {
      const pendingTitle = this.pendingToolCallTitles.shift();
      if (pendingTitle && shouldPreferPendingToolTitle(nextItem)) nextItem = { ...nextItem, title: pendingTitle };
    } else if (nextItem.kind !== "tool") {
      this.pendingToolCallTitles.length = 0;
    }

    const index = this.transcript.findIndex((candidate) => candidate.id === nextItem.id);
    const previousForMerge = index === -1 ? this.transcript.at(-1) : this.transcript[index - 1];
    if (previousForMerge && mergeDuplicateToolResult(previousForMerge, nextItem)) {
      this.dirtyTranscriptIds.add(previousForMerge.id);
      return;
    }

    if (!isRenderableTranscriptItem(nextItem)) {
      if (index !== -1) {
        this.transcript.splice(index, 1);
        if (this.selectedTranscriptId === nextItem.id) this.selectTranscriptItem(this.transcript[Math.max(0, index - 1)]?.id ?? "", false);
      }
      this.dirtyTranscriptIds.delete(nextItem.id);
      this.transcriptStructureDirty = true;
      return;
    }

    if (index === -1) this.transcript.push(nextItem);
    else this.transcript[index] = { ...this.transcript[index], ...nextItem };
    const nextIndex = index === -1 ? this.transcript.length - 1 : index;
    this.dirtyTranscriptIds.add(nextItem.id);
    const previous = this.transcript[nextIndex - 1];
    const next = this.transcript[nextIndex + 1];
    if (previous?.kind === "tool") this.dirtyTranscriptIds.add(previous.id);
    if (next?.kind === "tool") this.dirtyTranscriptIds.add(next.id);
    if (nextItem.kind === "tool" && nextItem.status === "done") this.transcriptStructureDirty = true;
    this.transcriptFollow.markUnread(nextItem.id);
    if (!this.selectedTranscriptId) this.selectTranscriptItem(nextItem.id, false);
  }

  private draftKey(sessionId = this.selectedSession?.id): string | null {
    return sessionId ? `piWebPromptDraft:${sessionId}` : null;
  }

  private attachmentWarningKey(sessionId = this.selectedSession?.id): string | null {
    return sessionId ? `piWebPromptAttachmentWarning:${sessionId}` : null;
  }

  private savePromptDraft(): void {
    const key = this.draftKey();
    if (!key) return;
    if (this.promptDraft) localStorage.setItem(key, this.promptDraft);
    else localStorage.removeItem(key);
  }

  private schedulePromptDraftSave(): void {
    if (this.promptDraftSaveTimer) clearTimeout(this.promptDraftSaveTimer);
    this.promptDraftSaveTimer = setTimeout(() => {
      this.promptDraftSaveTimer = undefined;
      this.savePromptDraft();
    }, 250);
  }

  private loadPromptDraft(sessionId: string): string {
    return localStorage.getItem(`piWebPromptDraft:${sessionId}`) ?? "";
  }

  private persistAttachmentWarningIfNeeded(): void {
    const key = this.attachmentWarningKey();
    if (key && this.promptImages.length > 0) localStorage.setItem(key, "lost");
  }

  private async refresh(): Promise<void> {
    try {
      const [workspaces, sessions, appSettings] = await Promise.all([
        this.api<Workspace[]>("/api/workspaces"),
        this.api<WebSession[]>("/api/sessions"),
        this.api<AppSettings>("/api/settings"),
      ]);
      this.workspaces = workspaces;
      this.sessions = sessions;
      this.appSettings = appSettings;
      if (this.selectedSession) {
        const updated = sessions.find((candidate) => candidate.id === this.selectedSession?.id);
        if (updated) this.selectedSession = updated;
      }
      this.notice = "";
      if (!this.selectedSession && this.lastSelectedSessionId) {
        const session = sessions.find((candidate) => candidate.id === this.lastSelectedSessionId);
        if (session) {
          this.openSession(session);
          return;
        }
      }
      this.render();
    } catch (error) {
      this.notice = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async createSession(cwdOverride?: string): Promise<WebSession | null> {
    const select = this.querySelector<HTMLSelectElement>("#workspace");
    const cwd = cwdOverride || select?.value || this.workspaces[0]?.path;
    if (!cwd) return null;
    try {
      const session = await this.api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session);
      return session;
    } catch (error) {
      this.notice = `Create session failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
      return null;
    }
  }

  private openSession(session: WebSession, collapseSidebar = true): void {
    this.persistAttachmentWarningIfNeeded();
    this.selectedSession = session;
    if (collapseSidebar && !this.sessionSidebarPinned) this.sessionSidebarCollapsed = true;
    this.lastSelectedSessionId = session.id;
    localStorage.setItem("piWebLastSessionId", session.id);
    this.transcript = [{ id: "opened", kind: "system", title: "Session", body: `Opened ${session.cwd}` }];
    this.status = "connecting";
    const attachmentWarningKey = this.attachmentWarningKey(session.id);
    const hadLostAttachments = attachmentWarningKey ? localStorage.getItem(attachmentWarningKey) === "lost" : false;
    if (attachmentWarningKey) localStorage.removeItem(attachmentWarningKey);
    this.notice = hadLostAttachments ? "Image attachments are not restored after a refresh. Please attach them again before sending." : "";
    this.promptDraft = this.loadPromptDraft(session.id);
    this.promptImages = [];
    this.runningQueue = emptyRunningQueue();
    this.autoScroll = true;
    this.controller = null;
    this.settings = null;
    this.pendingQuestion = null;
    this.sessionTree = null;
    this.treeDrawerOpen = false;
    this.treeActiveEntryId = "";
    this.focusTreeOnNextRender = false;
    this.scrollTreeCurrentAfterRefresh = false;
    this.transcriptFollow.resetToLatest();
    this.selectedTranscriptId = "opened";
    localStorage.setItem("piWebSelectedTranscriptId", this.selectedTranscriptId);
    this.socketGeneration++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.connectWebSocket(session, "connecting");
    this.render();
  }

  private connectWebSocket(session: WebSession, state: ConnectionState): void {
    const generation = ++this.socketGeneration;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectionState = state;
    this.connectionMessage = state === "reconnecting" ? `Reconnecting to ${session.id}...` : `Connecting to ${session.id}...`;
    this.status = this.status === "running" ? this.status : "connecting";

    const url = new URL(`${this.apiBase}/api/sessions/${session.id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    const rememberedClientId = localStorage.getItem(`piWebClientId:${session.id}`);
    if (rememberedClientId) url.searchParams.set("clientId", rememberedClientId);

    const socket = new WebSocket(url);
    this.ws = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.socketGeneration) return;
      this.connectionState = state === "reconnecting" ? "reconnecting" : "connecting";
      this.connectionMessage = "Socket opened; waiting for session snapshot...";
      this.requestRender(0);
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.socketGeneration) return;
      this.handleSocketMessage(event.data as string);
    });
    socket.addEventListener("close", () => {
      if (generation !== this.socketGeneration) return;
      this.handleSocketClose(session);
    });
    socket.addEventListener("error", () => {
      if (generation !== this.socketGeneration) return;
      this.connectionMessage = "Connection error; retrying if possible.";
      this.requestRender(0);
    });
  }

  private handleSocketClose(session: WebSession): void {
    if (this.selectedSession?.id !== session.id) return;
    this.status = "disconnected";
    this.connectionState = "disconnected";
    this.connectionMessage = "Connection lost. Retrying shortly...";
    this.scheduleReconnect(session);
    this.requestRender(0);
  }

  private scheduleReconnect(session: WebSession): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt++;
    if (this.reconnectAttempt > 8) {
      this.connectionState = "retry_failed";
      this.connectionMessage = "Reconnect failed. Check whether the backend is running, then use Save / Refresh or reopen the session.";
      return;
    }
    const delay = Math.min(8_000, 500 * 2 ** Math.max(0, this.reconnectAttempt - 1));
    this.connectionState = "reconnecting";
    this.connectionMessage = `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt}/8)...`;
    this.reconnectTimer = setTimeout(() => {
      if (this.selectedSession?.id !== session.id) return;
      this.connectWebSocket(session, "reconnecting");
      this.requestRender(0);
    }, delay);
  }

  private applySnapshot(snapshot: SessionSnapshot): void {
    this.status = snapshot.status;
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
    this.transcript = compactSnapshotTranscript(snapshot.messages.map((message, index) => messageToTranscriptItem(message, `snapshot:${index}`)));
    this.runningQueue = emptyRunningQueue();
    this.pendingToolCallTitles = [];
    if (this.transcript.length === 0) this.transcript.push({ id: "empty", kind: "system", title: "Session", body: "No messages yet." });
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
      this.applyAgentEvent(payload.event.data ?? payload.event);
    } else if (payload.type === "controller_update") {
      this.controller = payload.controller;
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
      const mergeSessionMetadata = (existing: WebSession | undefined): WebSession => ({
        ...existing,
        ...payload.session,
        lastUserPrompt: payload.session.lastUserPrompt ?? existing?.lastUserPrompt,
        lastActivityAt: payload.session.lastActivityAt ?? existing?.lastActivityAt,
        status: payload.session.status ?? existing?.status,
      });
      this.selectedSession = mergeSessionMetadata(this.selectedSession?.id === payload.session.id ? this.selectedSession : undefined);
      this.sessions = this.sessions.map((session) => session.id === payload.session.id ? mergeSessionMetadata(session) : session);
    } else if (payload.type === "error") {
      this.upsertTranscript({ id: `error:${Date.now()}`, kind: "error", title: payload.code, body: payload.message });
    }
    this.requestRender();
  }

  private applyAgentEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const type = String(event.type ?? "event");
    const transcript = this.querySelector<HTMLElement>(".transcript");
    this.transcriptFollow.disableFollowIfDetached(transcript);

    if (type === "agent_start" || type === "turn_start") {
      this.status = "running";
    }
    if (type === "agent_end" || type === "turn_end") {
      this.status = "idle";
      this.runningQueue = emptyRunningQueue();
      void this.refreshTree();
    }

    if (type === "web_command_result") {
      this.upsertTranscript({
        id: String(event.id ?? `command:${Date.now()}`),
        kind: event.isError ? "error" : "system",
        title: String(event.title ?? "Slash command"),
        body: String(event.body ?? ""),
        raw: event,
      });
      return;
    }

    if ((type === "message_start" || type === "message_update" || type === "message_end") && isRecord(event.message)) {
      const fallback = type === "message_update" ? "assistant:live" : `${type}:${Date.now()}`;
      const item = messageToTranscriptItem(event.message, fallback);
      item.status = type === "message_update" ? "running" : "done";
      this.upsertTranscript(item);
      return;
    }

    if (type === "tool_execution_start") {
      this.upsertTranscript({
        id: `tool:${String(event.toolCallId ?? Date.now())}`,
        kind: "tool",
        title: formatToolTitle(event.toolName, event.args),
        body: toolArgsToText(event.args ?? {}),
        status: "running",
        raw: event,
      });
      return;
    }

    if (type === "tool_execution_update") {
      const partialResult = event.partialResult ?? {};
      const partialText = toolResultToText(partialResult);
      this.upsertTranscript({
        id: `tool:${String(event.toolCallId ?? Date.now())}`,
        kind: "tool",
        title: formatToolTitle(event.toolName, event.args),
        body: partialText || toolArgsToText(event.args ?? {}),
        segments: toolResultToSegments(partialResult),
        status: "running",
        raw: event,
      });
      return;
    }

    if (type === "tool_execution_end") {
      const id = `tool:${String(event.toolCallId ?? Date.now())}`;
      const existing = this.transcript.find((item) => item.id === id);
      const result = event.result ?? {};
      const toolItem: TranscriptItem = {
        id,
        kind: "tool",
        title: existing?.title ?? formatToolTitle(event.toolName, {}),
        body: toolResultToText(result),
        segments: toolResultToSegments(result),
        status: event.isError ? "error" : "done",
        raw: event,
      };
      this.upsertTranscript(toolItem);
      const questionSummary = questionSummaryFromTool(toolItem);
      if (questionSummary) this.upsertTranscript(questionSummary);
      return;
    }

    if (type === "queue_update") {
      this.runningQueue = runningQueueFromUpdate(
        this.runningQueue,
        Array.isArray(event.steering) ? event.steering : [],
        Array.isArray(event.followUp) ? event.followUp : [],
      );
    }
  }

  private selectTranscriptItem(id: string, shouldRender = true): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    this.transcriptFollow.captureScrollTop(transcript);
    this.selectedTranscriptId = id;
    localStorage.setItem("piWebSelectedTranscriptId", id);
    if (shouldRender) {
      this.transcriptFollow.preserveNextSync();
      this.render();
    }
  }

  private selectedTranscriptItem(): TranscriptItem | null {
    return this.transcript.find((item) => item.id === this.selectedTranscriptId) ?? this.transcript[this.transcript.length - 1] ?? null;
  }

  private treeNodes(nodes = this.sessionTree?.tree ?? []): SessionTreeNode[] {
    return flattenSessionTree(nodes);
  }

  private currentTreePath(): SessionTreeNode[] {
    return currentSessionTreePath(this.sessionTree);
  }

  private currentTreeEntryId(): string {
    return currentSessionTreeEntryId(this.sessionTree);
  }

  private ensureTreeActiveEntryId(): string {
    this.treeActiveEntryId = nextSessionTreeActiveEntryId(this.sessionTree, this.treeActiveEntryId);
    return this.treeActiveEntryId;
  }

  private visibleTreeContainer(source?: HTMLElement | null): HTMLElement | null {
    return source?.closest<HTMLElement>(".session-tree")
      ?? (this.treeDrawerOpen ? this.querySelector<HTMLElement>(".tree-drawer .session-tree") : null)
      ?? this.querySelector<HTMLElement>(".right-panel .session-tree")
      ?? this.querySelector<HTMLElement>(".session-tree");
  }

  private setActiveTreeEntry(entryId: string, sourceRow?: HTMLElement | null, focus = true): void {
    if (!entryId) return;
    this.treeActiveEntryId = entryId;
    this.querySelectorAll<HTMLElement>("[data-tree-entry-id]").forEach((row) => {
      const active = row.dataset.treeEntryId === entryId;
      row.tabIndex = active ? 0 : -1;
      row.classList.toggle("keyboard-active", active);
    });
    if (!focus) return;
    const tree = this.visibleTreeContainer(sourceRow);
    const target = tree?.querySelector<HTMLElement>(`[data-tree-entry-id="${CSS.escape(entryId)}"]`) ?? this.querySelector<HTMLElement>(`[data-tree-entry-id="${CSS.escape(entryId)}"]`);
    target?.focus({ preventScroll: true });
  }

  private handleTreeRowKeydown(event: KeyboardEvent, row: HTMLElement): void {
    const tree = row.closest(".session-tree");
    if (!tree) return;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>("[data-tree-entry-id]"));
    if (!rows.length) return;
    const index = Math.max(0, rows.indexOf(row));
    let nextRow: HTMLElement | undefined;
    if (event.key === "ArrowDown") nextRow = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === "ArrowUp") nextRow = rows[Math.max(0, index - 1)];
    else if (event.key === "Home") nextRow = rows[0];
    else if (event.key === "End") nextRow = rows[rows.length - 1];
    else if (event.key === "Enter") {
      event.preventDefault();
      const entryId = row.dataset.treeEntryId ?? "";
      this.setActiveTreeEntry(entryId, row, true);
      void this.navigateToTreeEntry(entryId);
      return;
    } else if (event.key.toLowerCase() === "c") {
      event.preventDefault();
      this.focusCurrentTreeEntry(row);
      return;
    } else if (event.key.toLowerCase() === "f") {
      if (row.dataset.treeForkable !== "true") return;
      event.preventDefault();
      const entryId = row.dataset.treeEntryId ?? "";
      this.setActiveTreeEntry(entryId, row, true);
      void this.forkFromEntry(entryId);
      return;
    } else {
      return;
    }
    event.preventDefault();
    if (nextRow) this.setActiveTreeEntry(nextRow.dataset.treeEntryId ?? "", nextRow, true);
  }

  private focusCurrentTreeEntry(source?: HTMLElement | null): void {
    const currentId = this.currentTreeEntryId();
    if (!currentId) return;
    this.setActiveTreeEntry(currentId, source, true);
    const tree = this.visibleTreeContainer(source);
    tree?.querySelector<HTMLElement>(`[data-tree-entry-id="${CSS.escape(currentId)}"]`)?.scrollIntoView({ block: "start" });
  }

  private renderCurrentTreePath(path: SessionTreeNode[]): string {
    return renderCurrentSessionTreePath(this.sessionTree, path);
  }

  private forkEntryIdForTranscriptItem(item: TranscriptItem): string | null {
    return findForkEntryIdForTranscriptItem(item, this.treeNodes());
  }

  private async refreshTree(): Promise<void> {
    if (!this.selectedSession) return;
    try {
      this.sessionTree = await this.api<SessionTreeResponse>(`/api/sessions/${this.selectedSession.id}/tree`);
      if (this.focusTreeOnNextRender || this.scrollTreeCurrentAfterRefresh) {
        this.treeActiveEntryId = this.currentTreeEntryId();
        this.focusTreeOnNextRender = true;
        this.scrollTreeCurrentAfterRefresh = false;
      }
      this.ensureTreeActiveEntryId();
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

  private async navigateToTreeEntry(entryId: string): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const result = await this.api<NavigateTreeResponse>(`/api/sessions/${this.selectedSession.id}/tree/navigate`, {
        method: "POST",
        body: JSON.stringify({ entryId, summarize: false }),
      });
      this.applySnapshot(result.snapshot);
      if (result.editorText) {
        this.promptDraft = result.editorText;
        this.savePromptDraft();
      }
      this.notice = result.editorText ? "Navigated to user message draft" : "Navigated to selected point";
      this.render();
    } catch (error) {
      this.notice = `Tree navigation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private openTreeDrawer(): void {
    if (!this.selectedSession) return;
    this.treeDrawerOpen = true;
    this.rightPanelTab = "tree";
    this.focusTreeOnNextRender = true;
    this.scrollTreeCurrentAfterRefresh = true;
    localStorage.setItem("piWebRightPanelTab", "tree");
    void this.refreshTree();
    this.render();
  }

  private closeTreeDrawer(): void {
    this.treeDrawerOpen = false;
    this.render();
  }

  private async copyText(value: string, label = "Copied"): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notice = label;
    } catch (error) {
      this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private async handleTranscriptRowAction(action: TranscriptRowAction | "menu", transcriptId: string): Promise<void> {
    const item = this.transcript.find((candidate) => candidate.id === transcriptId);
    if (!item) return;
    if (action === "menu") {
      this.openActionMenuId = this.openActionMenuId === transcriptId ? "" : transcriptId;
      this.selectTranscriptItem(transcriptId, false);
      if (item.kind === "user" && !this.forkEntryIdForTranscriptItem(item)) await this.refreshTree();
      this.render();
      return;
    }

    this.openActionMenuId = "";
    if (action === "copy") {
      await this.copyText(item.body, "Copied message content");
      return;
    }
    if (action === "details" || action === "preview") {
      if (this.mobileLayout) {
        this.notice = "Inspector is hidden on mobile.";
        this.render();
        return;
      }
      this.selectedTranscriptId = transcriptId;
      localStorage.setItem("piWebSelectedTranscriptId", transcriptId);
      this.rightPanelTab = action;
      this.rightPanelCollapsed = false;
      localStorage.setItem("piWebRightPanelTab", action);
      localStorage.setItem("piWebRightPanelCollapsed", "false");
      this.transcriptFollow.preserveNextSync();
      this.render();
      return;
    }
    if (action === "fork") {
      const entryId = this.forkEntryIdForTranscriptItem(item);
      if (entryId) await this.forkFromEntry(entryId);
      else {
        this.notice = "Fork is only available after this user message appears in the session tree.";
        this.render();
      }
    }
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
      this.notice = nextTitle ? "Session title updated." : "Session title cleared.";
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

  private sendClientMessage(type: "prompt" | "steer" | "follow_up"): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim() || (this.promptImages.length > 0 ? "Please inspect the attached image." : "");
    if (!input || !text) return;
    if (type === "prompt" && /^\/tree(?:\s|$)/i.test(text)) {
      this.promptDraft = "";
      this.savePromptDraft();
      this.closeFileAutocomplete();
      this.closeCommandAutocomplete();
      input.value = "";
      this.openTreeDrawer();
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.notice = "Not connected. Your draft is saved locally; sending will be available after reconnect.";
      this.render();
      return;
    }
    const images = this.promptImages.length > 0 ? this.promptImages.map((image) => image.dataUrl) : undefined;
    this.ws.send(JSON.stringify(images ? { type, text, images } : { type, text }));
    const queuedItem = { text, imageCount: images?.length };
    if (type === "steer") this.runningQueue = addRunningQueueItem(this.runningQueue, "steering", queuedItem);
    if (type === "follow_up") this.runningQueue = addRunningQueueItem(this.runningQueue, "followUp", queuedItem);
    if (type === "prompt" && this.selectedSession && !this.selectedSession.title) {
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
    this.notice = `Queued ${queue === "followUp" ? "follow-up" : "steer"} moved back to the composer.`;
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

  private async handleImageFiles(files: FileList | File[]): Promise<void> {
    const stableFiles = Array.from(files);
    this.notice = `Processing ${stableFiles.length} selected file${stableFiles.length === 1 ? "" : "s"}…`;
    this.render();
    if (stableFiles.length === 0) {
      this.notice = "No files were provided by the browser. Try the paperclip file picker or paste the image.";
      this.render();
      return;
    }
    try {
      const attachedCount = await this.addPromptImageFiles(stableFiles, { quiet: true });
      if (attachedCount === 0) {
        this.notice = `No supported image files found. Supported: PNG, JPEG, GIF, WebP. Saw: ${stableFiles.map((file) => `${file.name || "unnamed"}${file.type ? ` (${file.type})` : ""}`).join(", ")}`;
        this.render();
        return;
      }
      if (!this.selectedSession) {
        this.notice = "Image attached to the prompt. Open a session to upload a transcript preview artifact.";
        this.render();
        return;
      }
      try {
        await this.uploadImageArtifacts(stableFiles);
      } catch (error) {
        this.notice = `Attached image to prompt, but transcript preview upload failed: ${error instanceof Error ? error.message : String(error)}`;
        this.render();
      }
    } catch (error) {
      this.notice = `Could not attach image: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private isSupportedImageFile(file: File): boolean {
    return file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
  }

  private imageMimeType(file: File): string {
    if (file.type === "image/jpg") return "image/jpeg";
    if (file.type.startsWith("image/")) return file.type;
    const extension = file.name.toLowerCase().split(".").pop();
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "png") return "image/png";
    if (extension === "gif") return "image/gif";
    if (extension === "webp") return "image/webp";
    return file.type;
  }

  private artifactPathForFile(file: File): string {
    const safeName = (file.name || "screenshot.png").replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "screenshot.png";
    return `.bakery/artifacts/${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName}`;
  }

  private async uploadImageArtifacts(files: FileList | File[]): Promise<void> {
    if (!this.selectedSession) {
      this.notice = "Open a session before uploading transcript artifacts.";
      this.render();
      return;
    }
    const incoming = Array.from(files).filter((file) => this.isSupportedImageFile(file));
    if (incoming.length === 0) return;
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const uploadedPaths: string[] = [];
    for (const file of incoming) {
      const mimeType = this.imageMimeType(file);
      if (!supportedPromptImageTypes.has(mimeType)) {
        this.notice = `Unsupported image type: ${file.type || file.name}`;
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        this.notice = `${file.name} is larger than 20 MB.`;
        continue;
      }
      const path = this.artifactPathForFile(file);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "").replace(/^data:[^,]+,/, "")));
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read image")));
        reader.readAsDataURL(file);
      });
      await this.api(`/api/sessions/${this.selectedSession.id}/artifacts`, {
        method: "POST",
        body: JSON.stringify({ path, mimeType, data }),
      });
      uploadedPaths.push(path);
    }
    if (uploadedPaths.length > 0) {
      const insertion = uploadedPaths.map((path) => `Screenshot artifact: ${path}`).join("\n");
      if (input) {
        const prefix = input.value.trimEnd();
        input.value = `${prefix}${prefix ? "\n" : ""}${insertion}`;
        this.updatePromptDraft(input);
      } else {
        this.promptDraft = `${this.promptDraft.trimEnd()}${this.promptDraft.trim() ? "\n" : ""}${insertion}`;
        this.schedulePromptDraftSave();
      }
      this.notice = `Attached ${uploadedPaths.length} image${uploadedPaths.length === 1 ? "" : "s"} to the prompt and uploaded transcript artifact preview path${uploadedPaths.length === 1 ? "" : "s"}.`;
    }
    this.render();
  }

  private async addPromptImageFiles(files: FileList | File[], options: { render?: boolean; quiet?: boolean } = {}): Promise<number> {
    const incoming = Array.from(files).filter((file) => this.isSupportedImageFile(file));
    if (incoming.length === 0) return 0;
    const added: PromptImage[] = [];
    for (const file of incoming) {
      if (this.promptImages.length + added.length >= maxPromptImages) {
        this.notice = `Only ${maxPromptImages} images can be attached to one prompt.`;
        break;
      }
      const mimeType = this.imageMimeType(file);
      if (!supportedPromptImageTypes.has(mimeType)) {
        this.notice = `Unsupported image type: ${file.type || file.name}`;
        continue;
      }
      if (file.size > maxPromptImageBytes) {
        this.notice = `${file.name} is larger than 8 MB.`;
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read image")));
        reader.readAsDataURL(file);
      });
      added.push({ id: browserId("image"), name: file.name || "pasted-image", mimeType, dataUrl, size: file.size });
    }
    if (added.length > 0) {
      this.promptImages = [...this.promptImages, ...added];
      if (!options.quiet) this.notice = "Image attachments are ready for this prompt only and are not preserved across page refreshes.";
    }
    if (options.render !== false) this.render();
    return added.length;
  }

  private removePromptImage(id: string): void {
    this.promptImages = this.promptImages.filter((image) => image.id !== id);
    this.render();
  }

  private abort(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "abort" }));
  }

  private takeControl(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "take_control" }));
      this.notice = "Control request sent to the current controller.";
      this.render();
    }
  }

  private respondToControlRequest(approve: boolean, requesterClientId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: approve ? "approve_control" : "deny_control", requesterClientId }));
  }

  private getFileToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return fileAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  private getCommandToken(input: HTMLTextAreaElement): AutocompleteToken | null {
    return commandAutocompleteToken(input.value, input.selectionStart ?? input.value.length);
  }

  private updatePromptDraft(input: HTMLTextAreaElement): void {
    this.promptDraft = input.value;
    this.schedulePromptDraftSave();
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

  private canAnswerPendingQuestion(): boolean {
    return Boolean(this.pendingQuestion && (this.controller?.isController ?? true) && this.connectionState === "connected");
  }

  private answerPendingQuestion(payload: { answer?: string; selectedIndex?: number | null; wasCustom?: boolean; cancelled?: boolean }): void {
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

  private submitCustomQuestionAnswer(): void {
    const input = this.querySelector<HTMLInputElement>("#questionCustomAnswer");
    const answer = input?.value.trim() ?? "";
    if (!answer) {
      this.notice = "Type an answer before submitting, or choose Cancel.";
      this.render();
      return;
    }
    this.answerPendingQuestion({ answer, selectedIndex: null, wasCustom: true });
  }

  private recommendedQuestionOptionIndex(): number {
    const question = this.pendingQuestion;
    if (!question) return -1;
    if (typeof question.recommendedOptionIndex === "number" && question.recommendedOptionIndex >= 0 && question.recommendedOptionIndex < question.options.length) {
      return question.recommendedOptionIndex;
    }
    const recommendation = question.recommendation?.toLowerCase() ?? "";
    if (!recommendation) return -1;
    return question.options.findIndex((option) => {
      const label = option.label.toLowerCase();
      return Boolean(label && recommendation.includes(label));
    });
  }

  private focusQuestionPanel(): void {
    const buttons = Array.from(this.querySelectorAll<HTMLButtonElement>("[data-question-option-index]:not(:disabled)"));
    if (buttons.length > 0) {
      const recommendedIndex = this.recommendedQuestionOptionIndex();
      const target = recommendedIndex >= 0 ? buttons.find((button) => Number(button.dataset.questionOptionIndex ?? "-1") === recommendedIndex) : buttons[0];
      (target ?? buttons[0])?.focus();
      return;
    }
    const customInput = this.querySelector<HTMLInputElement>("#questionCustomAnswer:not(:disabled)");
    if (customInput) {
      customInput.focus();
      return;
    }
    this.querySelector<HTMLElement>(".question-panel")?.focus();
  }

  private handleQuestionPanelKeydown(event: KeyboardEvent): void {
    if (!this.pendingQuestion) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.canAnswerPendingQuestion()) this.answerPendingQuestion({ cancelled: true, selectedIndex: null, wasCustom: false });
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active?.id === "questionCustomAnswer") return;
    const buttons = Array.from(this.querySelectorAll<HTMLButtonElement>("[data-question-option-index]:not(:disabled)"));
    if (buttons.length === 0) return;
    const focusedIndex = buttons.findIndex((button) => button === active);
    const recommendedIndex = this.recommendedQuestionOptionIndex();
    const currentIndex = focusedIndex >= 0 ? focusedIndex : recommendedIndex >= 0 ? buttons.findIndex((button) => Number(button.dataset.questionOptionIndex ?? "-1") === recommendedIndex) : 0;
    const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
    const focusButton = (index: number) => buttons[(index + buttons.length) % buttons.length]?.focus();
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusButton(focusedIndex >= 0 ? safeCurrentIndex + 1 : safeCurrentIndex);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusButton(focusedIndex >= 0 ? safeCurrentIndex - 1 : safeCurrentIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      const button = buttons[safeCurrentIndex];
      const index = Number(button?.dataset.questionOptionIndex ?? "-1");
      const option = this.pendingQuestion.options[index];
      if (option && this.canAnswerPendingQuestion()) {
        event.preventDefault();
        this.answerPendingQuestion({ answer: option.label, selectedIndex: index, wasCustom: false });
      }
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const option = this.pendingQuestion.options[index];
      if (option) {
        event.preventDefault();
        this.answerPendingQuestion({ answer: option.label, selectedIndex: index, wasCustom: false });
      }
    } else if (event.key.toLowerCase() === "c" && this.pendingQuestion.allowCustomAnswer) {
      const customInput = this.querySelector<HTMLInputElement>("#questionCustomAnswer:not(:disabled)");
      if (customInput) {
        event.preventDefault();
        customInput.focus();
      }
    }
  }

  private setModel(model: string): void {
    if (model && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_model", model }));
  }

  private setThinking(level: string): void {
    if (level && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_thinking", level }));
  }

  private markTranscriptUserScrollIntent(): void {
    this.transcriptFollow.markUserScrollIntent();
  }

  private bindEvents(): void {
    this.querySelector<HTMLSelectElement>("#themePreference")?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      this.themePreference = isThemePreference(value) ? value : "system";
      localStorage.setItem(themeStorageKey, this.themePreference);
      applyThemePreference(this.themePreference);
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", () => {
      const apiBase = this.querySelector<HTMLInputElement>("#apiBase")?.value.trim();
      const token = this.querySelector<HTMLInputElement>("#token")?.value.trim() ?? "";
      if (apiBase) {
        this.apiBase = apiBase;
        localStorage.setItem("piWebApiBase", apiBase);
      }
      this.token = token;
      localStorage.setItem("piWebAuthToken", token);
      void this.refresh();
    });
    this.querySelector<HTMLButtonElement>("#newSession")?.addEventListener("click", () => void this.createSession());
    this.querySelector<HTMLSelectElement>("#metadataModelSetting")?.addEventListener("change", (event) => {
      const model = (event.currentTarget as HTMLSelectElement).value;
      void this.api<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ sessionMetadataModel: model ? { model } : null }) }).then((settings) => {
        this.appSettings = settings;
        this.render();
      }).catch((error) => {
        this.notice = `Settings update failed: ${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
    });
    this.querySelectorAll<HTMLButtonElement>("#toggleSessionSidebar, #toggleSessionSidebarMobile").forEach((button) => {
      button.addEventListener("click", () => {
        this.sessionSidebarCollapsed = !this.sessionSidebarCollapsed;
        if (!this.mobileLayout && button.id === "toggleSessionSidebar") this.sessionSidebarPinned = !this.sessionSidebarCollapsed;
        localStorage.setItem("piWebSessionSidebarCollapsed", String(this.sessionSidebarCollapsed));
        localStorage.setItem("piWebSessionSidebarPinned", String(this.sessionSidebarPinned));
        this.notice = this.mobileLayout || !this.sessionSidebarPinned
          ? (this.sessionSidebarCollapsed ? "Session menu hidden." : "Session menu open.")
          : "Session sidebar pinned open for future sessions.";
        this.render();
      });
    });
    this.querySelector<HTMLButtonElement>("#pinSessionSidebar")?.addEventListener("click", () => {
      this.sessionSidebarPinned = true;
      this.sessionSidebarCollapsed = false;
      localStorage.setItem("piWebSessionSidebarPinned", "true");
      localStorage.setItem("piWebSessionSidebarCollapsed", "false");
      this.notice = "Session sidebar pinned open for future sessions.";
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#sessionSidebarBackdrop")?.addEventListener("click", () => {
      this.sessionSidebarCollapsed = true;
      localStorage.setItem("piWebSessionSidebarCollapsed", "true");
      this.notice = "Session menu hidden.";
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-session-group-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.dataset.sessionGroupToggle;
        if (!group || !isSessionRecencyGroupId(group)) return;
        if (this.collapsedSessionGroups.has(group)) this.collapsedSessionGroups.delete(group);
        else this.collapsedSessionGroups.add(group);
        persistCollapsedSessionGroups(this.collapsedSessionGroups);
        this.render();
      });
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
    this.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", () => this.sendFromInput(false));
    this.querySelector<HTMLButtonElement>("#followUp")?.addEventListener("click", () => this.sendFromInput(true));
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
    this.querySelector<HTMLElement>(".question-panel")?.addEventListener("keydown", (event) => this.handleQuestionPanelKeydown(event));
    this.querySelectorAll<HTMLButtonElement>("[data-question-option-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.questionOptionIndex ?? "-1");
        const option = this.pendingQuestion?.options[index];
        if (option && index >= 0) this.answerPendingQuestion({ answer: option.label, selectedIndex: index, wasCustom: false });
      });
    });
    this.querySelector<HTMLButtonElement>("#questionCustomSubmit")?.addEventListener("click", () => this.submitCustomQuestionAnswer());
    this.querySelector<HTMLInputElement>("#questionCustomAnswer")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submitCustomQuestionAnswer();
      }
    });
    this.querySelector<HTMLButtonElement>("#questionCancel")?.addEventListener("click", () => this.answerPendingQuestion({ cancelled: true, selectedIndex: null, wasCustom: false }));
    this.querySelector<HTMLButtonElement>("#abort")?.addEventListener("click", () => this.abort());
    this.querySelector<HTMLButtonElement>("#takeControl")?.addEventListener("click", () => this.takeControl());
    this.querySelector<HTMLButtonElement>("#attentionRefresh")?.addEventListener("click", () => void this.refresh());
    this.querySelector<HTMLButtonElement>("#approveControl")?.addEventListener("click", (event) => {
      this.respondToControlRequest(true, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
    });
    this.querySelector<HTMLButtonElement>("#denyControl")?.addEventListener("click", (event) => {
      this.respondToControlRequest(false, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
    });
    this.querySelectorAll<HTMLButtonElement>("[data-control-action]").forEach((button) => {
      button.addEventListener("click", (event) => {
        const action = (event.currentTarget as HTMLButtonElement).dataset.controlAction;
        if (action === "take") this.takeControl();
        else if (action === "approve") this.respondToControlRequest(true, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
        else if (action === "deny") this.respondToControlRequest(false, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
      });
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
    this.querySelector<HTMLButtonElement>("#toggleRightPanel")?.addEventListener("click", () => {
      this.rightPanelCollapsed = !this.rightPanelCollapsed;
      localStorage.setItem("piWebRightPanelCollapsed", String(this.rightPanelCollapsed));
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-right-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.rightTab === "preview" ? "preview" : button.dataset.rightTab === "tree" ? "tree" : "details";
        this.rightPanelTab = tab;
        this.rightPanelCollapsed = false;
        if (tab === "tree") this.focusTreeOnNextRender = true;
        localStorage.setItem("piWebRightPanelTab", tab);
        localStorage.setItem("piWebRightPanelCollapsed", "false");
        this.render();
      });
    });
    this.querySelector<HTMLButtonElement>("#copySelectedBody")?.addEventListener("click", () => {
      const item = this.selectedTranscriptItem();
      if (item) void this.copyText(item.body, "Copied selected content");
    });
    this.querySelector<HTMLButtonElement>("#copySelectedJson")?.addEventListener("click", () => {
      const item = this.selectedTranscriptItem();
      if (item) void this.copyText(stringify(item.raw ?? item), "Copied selected JSON");
    });
    this.querySelector<HTMLSelectElement>("#model")?.addEventListener("change", (event) => this.setModel((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLSelectElement>("#thinking")?.addEventListener("change", (event) => this.setThinking((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLButtonElement>("#attachImages")?.addEventListener("click", () => this.openImagePicker());
    this.querySelectorAll<HTMLButtonElement>("[data-remove-image-id]").forEach((button) => {
      button.addEventListener("click", () => this.removePromptImage(button.dataset.removeImageId ?? ""));
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragover", (event) => {
      const items = Array.from(event.dataTransfer?.items ?? []);
      const hasPotentialFileDrop = items.length === 0 || items.some((item) => item.kind === "file" || item.type.startsWith("image/"));
      if (!hasPotentialFileDrop) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      (event.currentTarget as HTMLElement).classList.add("dragging-image");
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragleave", (event) => {
      (event.currentTarget as HTMLElement).classList.remove("dragging-image");
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      event.preventDefault();
      (event.currentTarget as HTMLElement).classList.remove("dragging-image");
      if (!files || files.length === 0) {
        this.notice = "Drop image files here to attach them to the prompt.";
        this.render();
        return;
      }
      void this.handleImageFiles(files);
    });
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => this.updatePromptDraft(event.currentTarget as HTMLTextAreaElement));
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (files && Array.from(files).some((file) => this.isSupportedImageFile(file))) void this.handleImageFiles(files);
    });
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("blur", () => {
      window.setTimeout(() => {
        const focused = this.querySelector(":focus");
        if (this.imagePickerActive || focused?.id === "prompt" || focused?.closest(".file-autocomplete") || focused?.closest(".command-autocomplete")) return;
        this.closeFileAutocomplete();
        this.closeCommandAutocomplete();
        this.render();
      }, 120);
    });
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("keydown", (event) => {
      if (this.commandAutocomplete.active) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const count = Math.max(1, this.commandAutocomplete.commands.length);
          this.commandAutocomplete.selectedIndex = (this.commandAutocomplete.selectedIndex + direction + count) % count;
          this.patchAutocompleteSelection("command");
          return;
        }
        if ((event.key === "Tab" || event.key === "Enter") && this.commandAutocomplete.commands.length > 0) {
          event.preventDefault();
          this.chooseCommandAutocomplete();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeCommandAutocomplete();
          this.render();
          return;
        }
      }
      if (this.fileAutocomplete.active) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const count = Math.max(1, this.fileAutocomplete.files.length);
          this.fileAutocomplete.selectedIndex = (this.fileAutocomplete.selectedIndex + direction + count) % count;
          this.patchAutocompleteSelection("file");
          return;
        }
        if ((event.key === "Tab" || event.key === "Enter") && this.fileAutocomplete.files.length > 0) {
          event.preventDefault();
          this.chooseFileAutocomplete();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeFileAutocomplete();
          this.render();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.sendFromInput(event.altKey);
      }
    });
    this.querySelector<HTMLElement>(".transcript")?.addEventListener("click", (event) => {
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
      const action = button.dataset.rowAction as TranscriptRowAction | "menu";
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
    this.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const session = this.sessions.find((candidate) => candidate.id === button.dataset.sessionId);
        if (session) this.openSession(session);
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

    this.querySelectorAll<HTMLButtonElement>("[data-tree-refresh]").forEach((button) => {
      button.addEventListener("click", () => void this.refreshTree());
    });
    this.querySelectorAll<HTMLButtonElement>("[data-open-tree-drawer]").forEach((button) => {
      button.addEventListener("click", () => this.openTreeDrawer());
    });
    this.querySelector<HTMLButtonElement>("#closeTreeDrawer")?.addEventListener("click", () => this.closeTreeDrawer());
    this.querySelectorAll<HTMLButtonElement>("[data-tree-current]").forEach((button) => {
      button.addEventListener("click", () => this.focusCurrentTreeEntry(button));
    });
    this.querySelectorAll<HTMLElement>("[data-tree-entry-id]").forEach((element) => {
      element.addEventListener("click", () => {
        this.setActiveTreeEntry(element.dataset.treeEntryId ?? "", element, false);
        void this.navigateToTreeEntry(element.dataset.treeEntryId ?? "");
      });
      element.addEventListener("focus", () => this.setActiveTreeEntry(element.dataset.treeEntryId ?? "", element, false));
      element.addEventListener("keydown", (event) => this.handleTreeRowKeydown(event, element));
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

  private renderSessionSummary(expanded: boolean): string {
    if (!this.selectedSession) return "";
    return renderSessionSummaryHtml({
      session: this.selectedSession,
      expanded,
      suggestion: this.metadataSuggestion,
      draft: this.metadataSuggestionDraft,
      error: this.metadataSuggestionError,
      metadataGenerating: this.metadataGenerating,
      status: this.status,
      showSuggestion: !this.mobileLayout,
    });
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

  private renderPromptImages(): string {
    if (this.promptImages.length === 0) return "";
    return `
      <div class="prompt-images" aria-label="Attached prompt images">
        ${this.promptImages.map((image) => `
          <figure class="prompt-image">
            <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" />
            <figcaption title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</figcaption>
            <button type="button" data-remove-image-id="${escapeHtml(image.id)}" aria-label="Remove ${escapeHtml(image.name)}">×</button>
          </figure>`).join("")}
      </div>`;
  }

  private renderQuestionPanel(isController: boolean): string {
    const question = this.pendingQuestion;
    if (!question) return "";
    const disabled = !isController || this.connectionState !== "connected";
    const viewerCopy = !isController ? `<p class="question-viewer-copy">Take control to answer this question. Keyboard answer shortcuts are disabled in viewer mode.</p>` : this.connectionState !== "connected" ? `<p class="question-viewer-copy">Reconnect before answering. Keyboard answer shortcuts are disabled while disconnected.</p>` : "";
    const recommendedOptionIndex = this.recommendedQuestionOptionIndex();
    return `
      <section class="question-panel" aria-label="Answer needed" tabindex="-1">
        <div class="question-panel-heading">
          <strong>Answer needed</strong>
          ${question.title ? `<span>${escapeHtml(question.title)}</span>` : ""}
        </div>
        <p class="question-text">${escapeHtml(question.question)}</p>
        ${question.recommendation && recommendedOptionIndex < 0 ? `<p class="question-recommendation"><b>Recommended:</b> ${escapeHtml(question.recommendation)}</p>` : ""}
        ${question.options.length ? `<div class="question-options" role="listbox" aria-label="Answer options. Use arrow keys to choose, then Enter.">
          ${question.options.map((option, index) => {
            const recommended = index === recommendedOptionIndex;
            return `<button type="button" data-question-option-index="${index}" class="${recommended ? "recommended-option" : ""}" aria-keyshortcuts="${index + 1}" aria-label="${recommended ? "Recommended option: " : ""}${index + 1}. ${escapeHtml(option.label)}" ${disabled ? "disabled" : ""}>
              <span class="option-title"><kbd>${index + 1}</kbd><strong>${escapeHtml(option.label)}</strong>${recommended ? `<em>Recommended</em>` : ""}</span>
              ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
            </button>`;
          }).join("")}
        </div>` : ""}
        ${question.allowCustomAnswer ? `<div class="question-custom">
          <label class="question-custom-field"><span><kbd>C</kbd> Custom</span><input id="questionCustomAnswer" type="text" ${disabled ? "disabled" : ""} placeholder="Type a custom answer…" /></label>
          <button id="questionCustomSubmit" type="button" ${disabled ? "disabled" : ""}>Answer <kbd>Enter</kbd></button>
        </div>` : ""}
        <div class="question-actions">
          ${viewerCopy}
          <span class="question-key-hint"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>1-9</kbd> answer · <kbd>C</kbd> custom · <kbd>Esc</kbd> cancel</span>
          <button id="questionCancel" type="button" aria-keyshortcuts="Escape" ${disabled ? "disabled" : ""}>Cancel question</button>
        </div>
      </section>`;
  }


  private renderRunningQueueHtml(): string {
    const rendered = renderRunningQueue(this.runningQueue, this.runningQueueExpanded);
    this.runningQueueExpanded = rendered.expanded;
    return rendered.html;
  }

  private renderRightPanel(): string {
    const item = this.selectedTranscriptItem();
    const detailsActive = this.rightPanelTab === "details";
    const previewActive = this.rightPanelTab === "preview";
    if (this.rightPanelCollapsed) {
      return `
        <aside class="right-panel collapsed" aria-label="Collapsed inspector">
          <button id="toggleRightPanel" title="Show inspector" aria-label="Show inspector">◀</button>
          <span>Inspector</span>
        </aside>`;
    }
    return `
      <aside class="right-panel">
        <div class="right-tabs">
          <button id="toggleRightPanel" class="collapse-panel" title="Hide inspector" aria-label="Hide inspector">▶</button>
          <button data-right-tab="details" class="${detailsActive ? "active" : ""}">Details</button>
          <button data-right-tab="preview" class="${previewActive ? "active" : ""}">Preview</button>
          <button data-right-tab="tree" class="${this.rightPanelTab === "tree" ? "active" : ""}">Tree</button>
        </div>
        ${this.rightPanelTab === "tree" ? this.renderTreePanel() : item ? `
          <div class="right-panel-heading">
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.kind)}${item.status ? ` · ${escapeHtml(item.status)}` : ""}</small>
            </div>
            <div class="right-actions">
              <button id="copySelectedBody">Copy text</button>
              <button id="copySelectedJson">Copy JSON</button>
            </div>
          </div>
          ${detailsActive ? this.renderDetailsPanel(item) : this.renderPreviewPanel(item)}
        ` : `<p class="empty-panel">Select a message or tool to inspect it.</p>`}
      </aside>`;
  }

  private renderTreeNodes(nodes: SessionTreeNode[], currentPathIds = new Set<string>(), activeEntryId = this.ensureTreeActiveEntryId()): string {
    return renderSessionTreeNodes(nodes, currentPathIds, activeEntryId);
  }

  private renderTreePanel(options: { drawer?: boolean } = {}): string {
    if (!this.selectedSession) return `<p class="empty-panel">Open a session to inspect its tree.</p>`;
    const currentPath = this.currentTreePath();
    const currentPathIds = new Set(currentPath.map((node) => node.id));
    const activeEntryId = this.ensureTreeActiveEntryId();
    return `
      <div class="tree-panel tui-tree ${options.drawer ? "drawer-tree" : ""}">
        <div class="tree-toolbar">
          <strong>Session Tree</strong>
          <span>Type <b>/tree</b> to open this wide view. Click a row to navigate; <b>fork</b> creates a new session branch.</span>
          <div class="tree-toolbar-actions">
            <button data-tree-current title="Jump to the current leaf row">Current</button>
            ${options.drawer ? `<button id="closeTreeDrawer">Close</button>` : `<button data-open-tree-drawer>Wide</button>`}
            <button data-tree-refresh>Refresh</button>
          </div>
        </div>
        <div class="tree-hints">Newest first · arrows move up/down · Enter navigates · F forks · C jumps current · ${this.sessionTree?.leafId ? `leaf ${escapeHtml(this.sessionTree.leafId)}` : "no leaf yet"}</div>
        ${this.renderCurrentTreePath(currentPath)}
        ${this.sessionTree?.tree.length
          ? `<div class="session-tree" role="tree" aria-label="Session tree entries">${this.renderTreeNodes(this.sessionTree.tree, currentPathIds, activeEntryId)}</div>`
          : `<p class="empty-panel">No tree entries yet. Send a prompt first.</p>`}
      </div>`;
  }

  private renderTreeDrawer(): string {
    if (!this.treeDrawerOpen) return "";
    return `<div class="tree-drawer" role="dialog" aria-label="Session tree">${this.renderTreePanel({ drawer: true })}</div>`;
  }

  private renderDetailsPanel(item: TranscriptItem): string {
    const raw = item.raw ?? item;
    const rawText = stringify(raw);
    const bodyPreview = item.body.trim();
    return `
      <div class="details-panel">
        <dl class="detail-grid">
          <dt>ID</dt><dd><code>${escapeHtml(item.id)}</code></dd>
          <dt>Kind</dt><dd>${escapeHtml(item.kind)}</dd>
          <dt>Status</dt><dd>${escapeHtml(item.status ?? "—")}</dd>
          <dt>Content</dt><dd>${escapeHtml(String(item.body.length))} chars</dd>
          <dt>Raw</dt><dd>${escapeHtml(String(rawText.length))} chars</dd>
        </dl>
        ${bodyPreview ? `
          <section class="detail-section">
            <h3>Content</h3>
            <pre>${escapeHtml(bodyPreview)}</pre>
          </section>` : ""}
        <details class="detail-section raw-detail">
          <summary>Raw event/message JSON</summary>
          <pre>${escapeHtml(rawText)}</pre>
        </details>
      </div>`;
  }

  private renderPreviewPanel(item: TranscriptItem): string {
    const body = item.body.trim();
    if (!body) return `<p class="empty-panel">No previewable content.</p>`;
    if (looksLikeHtml(body) || looksLikeSvg(body)) {
      return `<iframe class="preview-frame" sandbox srcdoc="${escapeHtml(body)}"></iframe>`;
    }
    if (item.kind === "assistant" || item.kind === "user") {
      return `<div class="preview-markdown markdown-body">${renderTranscriptSegments(item, this.showThinking, { cache: this.renderedSegmentCache, localImageUrl: (path) => this.localImageUrl(path) })}</div>`;
    }
    if (looksLikeMarkdown(body)) {
      return `<div class="preview-markdown markdown-body">${renderMarkdown(body)}</div>`;
    }
    return `<div class="preview-code"><pre>${escapeHtml(body)}</pre></div>`;
  }

  private renderTranscriptItemShell(item: TranscriptItem): string {
    return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
  }

  private renderToolRunGroup(items: TranscriptItem[]): string {
    const groupId = items.map((item) => item.id).join("|");
    const selectedInside = items.some((item) => item.id === this.selectedTranscriptId || item.id === this.openActionMenuId);
    const labels = items
      .slice(0, 3)
      .map((item) => item.title.replace(/^\$\s*/, ""))
      .join(" · ");
    return `<details class="tool-run-group" data-tool-run-group="${escapeHtml(groupId)}" ${selectedInside ? "open" : ""}>
      <summary>
        <strong>Ran ${items.length} tools</strong>
        ${labels ? `<span>${escapeHtml(labels)}${items.length > 3 ? " …" : ""}</span>` : ""}
      </summary>
      <div class="tool-run-items">
        ${items.map((item) => this.renderTranscriptItemShell(item)).join("")}
      </div>
    </details>`;
  }

  private currentActivity(): { label: string; detail: string; queued: number } | null {
    if (this.status !== "running") return null;
    const runningTool = [...this.transcript].reverse().find((item) => item.kind === "tool" && item.status === "running");
    const queued = runningQueueCount(this.runningQueue);
    if (runningTool) {
      const detail = runningTool.body
        .split(/\r?\n/)
        .map(compactToolSummaryLine)
        .filter((line): line is string => Boolean(line))
        .at(-1) ?? "tool is running";
      return { label: runningTool.title, detail, queued };
    }
    const runningAssistant = [...this.transcript].reverse().find((item) => item.kind === "assistant" && item.status === "running");
    return { label: runningAssistant ? "Pi is responding" : "Pi is working", detail: queued > 0 ? "Queued input will be applied during this run." : "Waiting for the next agent update…", queued };
  }

  private renderComposerActivity(): string {
    const activity = this.currentActivity();
    if (!activity) return "";
    return `<span class="composer-activity" title="${escapeHtml(`${activity.label} — ${activity.detail}`)}">
      <span>${escapeHtml(activity.label)}</span>
      <small>${escapeHtml(activity.detail)}</small>
      ${activity.queued > 0 ? `<b>${activity.queued} queued</b>` : ""}
    </span>`;
  }

  private renderAttentionNeeded(): string {
    const takeoverRequest = this.controller?.takeoverRequest;
    const takeoverPending = takeoverRequest?.state === "requested";
    const takeoverIncoming = takeoverRequest?.state === "incoming";
    const isController = this.controller?.isController ?? true;
    if (takeoverIncoming) {
      const requesterId = escapeHtml(takeoverRequest?.requesterClientId ?? "");
      return `<div class="attention-needed urgent" role="alert">
        <strong>Input needed</strong>
        <span>Another tab wants to control this session.</span>
        <div class="attention-actions"><button type="button" data-control-action="approve" data-requester-client-id="${requesterId}">Approve</button><button type="button" data-control-action="deny" data-requester-client-id="${requesterId}">Deny</button></div>
      </div>`;
    }
    if (this.connectionState === "retry_failed") {
      return `<div class="attention-needed urgent" role="alert">
        <strong>Reconnect failed</strong>
        <span>Check whether the backend is running, then refresh or reopen the session. Your prompt draft stays local.</span>
        <div class="attention-actions"><button type="button" id="attentionRefresh">Save / Refresh</button></div>
      </div>`;
    }
    if (this.connectionState === "disconnected") {
      return `<div class="attention-needed warning" role="status">
        <strong>Disconnected</strong>
        <span>Sending is paused while the browser reconnects. Your prompt draft is saved locally.</span>
      </div>`;
    }
    if (takeoverPending) {
      return `<div class="attention-needed warning" role="status">
        <strong>Control requested</strong>
        <span>Waiting for the current controller to approve input from this tab.</span>
      </div>`;
    }
    if (!isController) {
      return `<div class="attention-needed viewer" role="status">
        <strong>Viewer mode</strong>
        <span>Take control before sending prompts or steering the active run.</span>
        <div class="attention-actions"><button type="button" data-control-action="take" ${takeoverPending ? "disabled" : ""}>${takeoverPending ? "Control requested" : "Take control"}</button></div>
      </div>`;
    }
    return "";
  }

  private renderTranscript(): string {
    const parts: string[] = [];
    for (let index = 0; index < this.transcript.length;) {
      const item = this.transcript[index]!;
      if (!isRenderableTranscriptItem(item)) {
        index++;
        continue;
      }
      if (!this.isGroupableToolItem(item)) {
        parts.push(this.renderTranscriptItemShell(item));
        index++;
        continue;
      }
      const group: TranscriptItem[] = [];
      while (index < this.transcript.length && isRenderableTranscriptItem(this.transcript[index]!) && this.isGroupableToolItem(this.transcript[index]!)) {
        group.push(this.transcript[index]!);
        index++;
      }
      if (group.length >= 2) parts.push(this.renderToolRunGroup(group));
      else parts.push(this.renderTranscriptItemShell(group[0]!));
    }
    return parts.join("");
  }

  private renderJumpToLatest(): string {
    return this.transcriptFollow.renderJumpToLatest();
  }

  private isTranscriptNearBottom(transcript = this.querySelector<HTMLElement>(".transcript")): boolean {
    return this.transcriptFollow.isNearBottom(transcript);
  }

  private scrollTranscriptToBottom(): void {
    this.transcriptFollow.scrollToBottom(this);
  }

  private jumpToLatest(): void {
    this.transcriptFollow.jumpToLatest(this);
    this.render();
  }

  private scheduleTranscriptFollow(): void {
    this.transcriptFollow.scheduleFollow(this);
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

  private findTranscriptElement(id: string): PiTranscriptRow | null {
    return this.querySelector<PiTranscriptRow>(`.transcript pi-transcript-row[data-transcript-id="${CSS.escape(id)}"]`);
  }

  private transcriptElementOrderIndex(element: Element): number {
    if (element instanceof PiTranscriptRow) {
      return this.transcript.findIndex((item) => item.id === element.dataset.transcriptId);
    }
    const groupIds = (element as HTMLElement).dataset.toolRunGroup?.split("|") ?? [];
    const indexes = groupIds.map((id) => this.transcript.findIndex((item) => item.id === id)).filter((index) => index >= 0);
    return indexes.length ? Math.min(...indexes) : Number.POSITIVE_INFINITY;
  }

  private insertTranscriptRowInOrder(transcript: HTMLElement, row: PiTranscriptRow, item: TranscriptItem): void {
    const itemIndex = this.transcript.findIndex((candidate) => candidate.id === item.id);
    if (itemIndex < 0) {
      transcript.append(row);
      return;
    }
    const nextSibling = Array.from(transcript.children).find((child) => this.transcriptElementOrderIndex(child) > itemIndex);
    transcript.insertBefore(row, nextSibling ?? null);
  }

  private bindTranscriptElement(element: HTMLElement): void {
    if (element.dataset.transcriptBound === "true") return;
    element.dataset.transcriptBound = "true";
    element.addEventListener("pointerdown", (event) => {
      this.transcriptPointerDown = { id: element.dataset.transcriptId ?? "", x: event.clientX, y: event.clientY };
    });
    element.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest(".message-action-area")) return;
      if ((event.target as HTMLElement | null)?.closest(".message-header") && element.classList.contains("collapsible")) return;
      if (this.shouldPreserveTextSelection(element, event)) return;
      this.openActionMenuId = "";
      this.selectTranscriptItem(element.dataset.transcriptId ?? "");
    });
  }

  private shouldPreserveTextSelection(element: HTMLElement, event: MouseEvent): boolean {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        if (range.intersectsNode(element)) return true;
      }
    }

    const pointerDown = this.transcriptPointerDown;
    if (!pointerDown || pointerDown.id !== (element.dataset.transcriptId ?? "")) return false;
    const movedX = Math.abs(event.clientX - pointerDown.x);
    const movedY = Math.abs(event.clientY - pointerDown.y);
    return movedX > 4 || movedY > 4;
  }

  private isGroupableToolItem(item: TranscriptItem): boolean {
    return item.kind === "tool"
      && item.status === "done"
      && !itemHasRenderedImage(item);
  }

  private toolGroupPositionFor(item: TranscriptItem): ToolGroupPosition {
    const index = this.transcript.findIndex((candidate) => candidate.id === item.id);
    if (index === -1 || !this.isGroupableToolItem(item)) return "single";
    const previousGrouped = index > 0 && this.isGroupableToolItem(this.transcript[index - 1]!);
    const nextGrouped = index < this.transcript.length - 1 && this.isGroupableToolItem(this.transcript[index + 1]!);
    if (previousGrouped && nextGrouped) return "middle";
    if (nextGrouped) return "start";
    if (previousGrouped) return "end";
    return "single";
  }

  private isAfterRunningTool(item: TranscriptItem): boolean {
    const index = this.transcript.findIndex((candidate) => candidate.id === item.id);
    if (index <= 0 || item.kind !== "tool" || item.status !== "done") return false;
    const previous = this.transcript[index - 1];
    return previous?.kind === "tool" && previous.status === "running";
  }

  private updateTranscriptRow(row: PiTranscriptRow, item: TranscriptItem): void {
    row.setState(item, {
      showThinking: this.showThinking,
      selected: item.id === this.selectedTranscriptId,
      actionMenuOpen: item.id === this.openActionMenuId,
      canFork: Boolean(this.forkEntryIdForTranscriptItem(item)),
      afterRunningTool: this.isAfterRunningTool(item),
      toolGroupPosition: this.toolGroupPositionFor(item),
      cache: this.renderedSegmentCache,
      hideInspectorActions: this.mobileLayout,
      localImageUrl: (path) => this.localImageUrl(path),
    });
  }

  private hydrateTranscriptRows(): void {
    this.querySelectorAll<PiTranscriptRow>("pi-transcript-row[data-transcript-id]").forEach((row) => {
      this.bindTranscriptElement(row);
      const item = this.transcript.find((candidate) => candidate.id === row.dataset.transcriptId);
      if (item) this.updateTranscriptRow(row, item);
    });
  }

  private patchHeaderStatus(): void {
    const status = this.querySelector<HTMLElement>(".status");
    if (!status) return;
    status.className = `status ${this.status}`;
    status.textContent = this.status;
  }

  private patchConnectionBanner(): void {
    const banner = this.querySelector<HTMLElement>(".connection-banner");
    if (!this.shouldRenderConnectionBanner()) {
      banner?.remove();
      return;
    }
    const html = this.renderConnectionBanner();
    if (banner) {
      banner.outerHTML = html;
      return;
    }
    this.querySelector("main > header")?.insertAdjacentHTML("afterend", html);
  }

  private shouldRenderConnectionBanner(): boolean {
    if (!this.selectedSession) return false;
    return this.connectionState !== "connected" || Boolean(this.promptDraft) || this.promptImages.length > 0;
  }

  private renderConnectionBanner(): string {
    if (!this.shouldRenderConnectionBanner()) return "";
    return `<div class="connection-banner ${escapeHtml(this.connectionState)}" role="status">${this.renderConnectionBannerContent()}</div>`;
  }

  private renderConnectionBannerContent(): string {
    const stateLabel = this.connectionState.replace("_", " ");
    const message = this.connectionMessage.trim();
    const showMessage = message.length > 0 && message.toLowerCase() !== `${stateLabel}.`;
    return `
      <strong>${escapeHtml(stateLabel)}</strong>
      ${showMessage ? `<span>${escapeHtml(message)}</span>` : ""}
      ${this.promptDraft ? `<small>Draft saved locally for this session.</small>` : ""}
      ${this.promptImages.length > 0 ? `<small>Attached images will be lost on refresh.</small>` : ""}`;
  }

  private patchComposerActivity(): void {
    const mode = this.querySelector<HTMLElement>(".composer-mode");
    if (!mode) return;
    const existing = mode.querySelector<HTMLElement>(".composer-activity");
    const html = this.renderComposerActivity();
    if (!html) {
      existing?.remove();
      return;
    }
    if (existing) existing.outerHTML = html;
    else mode.querySelector(".composer-hint")?.insertAdjacentHTML("afterend", html);
  }

  private patchJumpToLatest(): void {
    this.transcriptFollow.patchJumpToLatest(this, () => this.jumpToLatest());
  }

  private patchTranscriptStructure(transcript: HTMLElement): void {
    transcript.innerHTML = this.renderTranscript();
    this.hydrateTranscriptRows();
    this.transcriptStructureDirty = false;
    this.dirtyTranscriptIds.clear();
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
      this.patchComposerActivity();
      this.patchJumpToLatest();
      this.syncTranscriptScroll();
      this.syncAutocompleteScroll();
      recordPerfSample("patch", performance.now() - start);
      return true;
    }

    for (const id of this.dirtyTranscriptIds) {
      const item = this.transcript.find((candidate) => candidate.id === id);
      const existing = this.findTranscriptElement(id);
      if (!item || !isRenderableTranscriptItem(item)) {
        existing?.remove();
        continue;
      }
      if (existing) {
        this.updateTranscriptRow(existing, item);
      } else {
        const next = document.createElement("pi-transcript-row") as PiTranscriptRow;
        next.dataset.transcriptId = item.id;
        this.bindTranscriptElement(next);
        this.updateTranscriptRow(next, item);
        this.insertTranscriptRowInOrder(transcript, next, item);
      }
    }
    this.dirtyTranscriptIds.clear();
    this.patchHeaderStatus();
    this.patchConnectionBanner();
    this.patchComposerActivity();
    this.patchJumpToLatest();
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    recordPerfSample("patch", performance.now() - start);
    return true;
  }

  private requestRender(delayMs = this.status === "running" ? 150 : 0): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      if ((delayMs > 0 || this.transcriptStructureDirty || this.dirtyTranscriptIds.size > 0) && this.patchLiveRender()) return;
      this.render();
    }, delayMs);
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

  private render(): void {
    const renderStart = performance.now();
    const existingTranscript = this.querySelector<HTMLElement>(".transcript");
    this.transcriptFollow.captureScrollTop(existingTranscript);
    const prompt = this.querySelector<HTMLTextAreaElement>("#prompt");
    const titleInput = this.querySelector<HTMLInputElement>("#sessionTitle");
    const restorePromptFocus = document.activeElement === prompt;
    const restoreTitleFocus = document.activeElement === titleInput;
    const promptSelectionStart = prompt?.selectionStart ?? this.promptDraft.length;
    const promptSelectionEnd = prompt?.selectionEnd ?? promptSelectionStart;
    const titleSelectionStart = titleInput?.selectionStart ?? (this.editingTitleDraft?.length ?? 0);
    const titleSelectionEnd = titleInput?.selectionEnd ?? titleSelectionStart;
    const isRunning = this.status === "running";
    const sidebarOverlayOpen = !this.sessionSidebarPinned && !this.sessionSidebarCollapsed;
    this.classList.toggle("session-sidebar-collapsed", this.sessionSidebarCollapsed);
    this.classList.toggle("session-sidebar-overlay-open", sidebarOverlayOpen);
    this.classList.toggle("inspector-collapsed", this.mobileLayout || this.rightPanelCollapsed);
    this.classList.toggle("mobile-layout", this.mobileLayout);
    const isController = this.controller?.isController ?? true;
    const takeoverRequest = this.controller?.takeoverRequest;
    const takeoverPending = takeoverRequest?.state === "requested";
    const takeoverIncoming = takeoverRequest?.state === "incoming";
    const controllerLabel = this.controller
      ? `${this.controller.isController ? "controller" : "viewer"} · ${this.controller.connectedClients} client${this.controller.connectedClients === 1 ? "" : "s"}`
      : "";
    const currentModelId = this.settings?.model?.id ?? "";
    const sessionGroups = groupedSessions(this.sessions);
    const selectedTitle = this.selectedSession ? (this.editingTitleDraft ?? this.selectedSession.title ?? "") : "";
    const selectedTitlePlaceholder = this.selectedSession ? sessionTitlePlaceholder(this.selectedSession) : "";
    const selectedMeta = this.selectedSession ? sessionMetadataLabel(this.selectedSession) : "";
    const summaryExpanded = this.selectedSession ? this.summaryExpanded(this.selectedSession.id) : false;
    this.innerHTML = `
      ${sidebarOverlayOpen ? `<button id="sessionSidebarBackdrop" class="session-sidebar-backdrop" type="button" aria-label="Hide sessions"></button>` : ""}
      <aside class="session-sidebar ${this.sessionSidebarCollapsed ? "collapsed" : ""} ${sidebarOverlayOpen ? "overlay" : ""}">
        <div class="sidebar-titlebar">
          <h1>Pi Web Agent</h1>
          <div class="sidebar-titlebar-actions">
            ${sidebarOverlayOpen && !this.mobileLayout ? `<button id="pinSessionSidebar" class="pin-sidebar" type="button" title="Pin sessions as a left column">Pin</button>` : ""}
            <button id="toggleSessionSidebar" class="collapse-sidebar" title="${this.sessionSidebarCollapsed ? "Show sessions" : this.sessionSidebarPinned ? "Hide sessions and unpin auto-collapse" : "Hide sessions"}" aria-label="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}">${this.sessionSidebarCollapsed ? "▶" : "◀"}</button>
          </div>
        </div>
        ${this.sessionSidebarCollapsed ? `
          <span class="collapsed-sidebar-label">Sessions</span>
          ${this.selectedSession ? `<span class="collapsed-sidebar-session" title="${escapeHtml(this.selectedSession.title ?? this.selectedSession.cwd)}">●</span>` : ""}
        ` : `
          <div class="sidebar-section sidebar-session-section">
            <label>Workspace
              <select id="workspace">
                ${this.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
              </select>
            </label>
            <button id="newSession">New session</button>
            <div class="sessions-heading">
              <h2>Recent sessions</h2>
            </div>
            <div class="session-groups">
              ${renderSessionGroups({ groups: sessionGroups, selectedSessionId: this.selectedSession?.id, collapsedGroups: this.collapsedSessionGroups, status: this.status })}
            </div>
          </div>
          <div class="sidebar-section sidebar-settings-section">
            <hr />
            <label>API <input id="apiBase" value="${escapeHtml(this.apiBase)}" /></label>
            <label>Token <input id="token" type="password" value="${escapeHtml(this.token)}" /></label>
            <label>Theme
              <select id="themePreference">
                <option value="system" ${this.themePreference === "system" ? "selected" : ""}>System</option>
                <option value="workbench-dark" ${this.themePreference === "workbench-dark" ? "selected" : ""}>Workbench Dark</option>
                <option value="workbench-light" ${this.themePreference === "workbench-light" ? "selected" : ""}>Workbench Light</option>
              </select>
            </label>
            <button id="saveSettings">Save / Refresh</button>
            ${this.notice ? `<p class="notice">${escapeHtml(this.notice)}</p>` : ""}
            ${this.renderAppSettings()}
            ${this.sessionSidebarPinned ? `<p class="sidebar-mode">Pinned open as a left column</p>` : `<p class="sidebar-mode">Opens as a temporary session menu</p>`}
          </div>
        `}
      </aside>
      <main>
        <header>
          <button id="toggleSessionSidebarMobile" class="mobile-menu-button" type="button" title="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}" aria-label="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}">☰</button>
          <div class="session-identity">
            ${this.selectedSession ? `<div class="session-title-row"><input id="sessionTitle" class="session-title-input" size="${Math.min(52, Math.max(12, selectedTitle.length || selectedTitlePlaceholder.length))}" value="${escapeHtml(selectedTitle)}" placeholder="${escapeHtml(selectedTitlePlaceholder)}" aria-label="Session title" title="Edit session title" />
              <button id="generateMetadata" class="metadata-generate-button" title="Suggest title and summary" aria-label="Suggest title and summary" ${this.metadataGenerating || this.status === "running" ? "disabled" : ""}>${this.metadataGenerating ? "…" : "✨"}</button></div>
              <span title="${escapeHtml(this.selectedSession.cwd)}">${escapeHtml(selectedMeta)}</span>
              ${this.renderSessionSummary(summaryExpanded)}` : `<strong>Create or open a session</strong><span>Select a workspace on the left to start.</span>`}
          </div>
          <div class="header-status">
            ${controllerLabel ? `<span class="controller ${isController ? "" : "viewer"}">${escapeHtml(controllerLabel)}</span>` : ""}
            ${!isController ? `<button id="takeControl" ${takeoverPending ? "disabled" : ""}>${takeoverPending ? "Control requested" : "Take control"}</button>` : ""}
            ${takeoverIncoming ? `<span class="control-request">Another tab wants control <button id="approveControl" data-requester-client-id="${escapeHtml(takeoverRequest?.requesterClientId ?? "")}">Approve</button><button id="denyControl" data-requester-client-id="${escapeHtml(takeoverRequest?.requesterClientId ?? "")}">Deny</button></span>` : ""}
            <label class="inline-control autoscroll"><input id="autoScroll" type="checkbox" ${this.autoScroll ? "checked" : ""} /> Auto-scroll</label>
            <label class="inline-control"><input id="showThinking" type="checkbox" ${this.showThinking ? "checked" : ""} /> Show thinking</label>
            ${this.settings ? `<label class="inline-control">Model
              <select id="model" ${isController ? "" : "disabled"}>
                ${this.settings.availableModels.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === currentModelId ? "selected" : ""}>${escapeHtml(model.name ?? model.id)} [${escapeHtml(model.provider)}]</option>`).join("")}
              </select>
            </label>
            <label class="inline-control">Thinking
              <select id="thinking" ${isController ? "" : "disabled"}>
                ${this.settings.availableThinkingLevels.map((level) => `<option value="${escapeHtml(level)}" ${level === this.settings?.thinkingLevel ? "selected" : ""}>${escapeHtml(level)}</option>`).join("")}
              </select>
            </label>` : ""}
            <span class="status ${escapeHtml(this.status)}">${escapeHtml(this.status)}</span>
          </div>
        </header>
        ${this.renderConnectionBanner()}
        ${this.renderAttentionNeeded()}
        ${this.notice ? `<p class="notice app-notice">${escapeHtml(this.notice)}</p>` : ""}
        <div class="transcript-shell ${hasRunningQueueItems(this.runningQueue) ? "has-running-queue" : ""}">
          <section class="transcript">${this.renderTranscript()}</section>
          ${this.renderRunningQueueHtml()}
          ${this.renderJumpToLatest()}
        </div>
        <footer class="${isRunning ? "running-footer" : ""}">
          ${this.renderQuestionPanel(isController)}
          <div class="prompt-shell">
            <div class="composer-mode ${isRunning ? "running" : "idle"}">
              <strong>${isRunning ? "Running input" : "Prompt"}</strong>
              <span class="composer-hint">${isRunning ? "Enter steers now · Alt+Enter queues a follow-up" : "Enter sends · Shift+Enter adds a line"}</span>
              ${this.renderComposerActivity()}
              ${this.renderContextUsageNotice()}
            </div>
            ${this.renderPromptImages()}
            <textarea id="prompt" rows="2" ${isController ? "" : "disabled"} placeholder="${isController ? (isRunning ? "Steer the active run..." : "Ask pi... Paste/drop screenshots, type / for commands or @ for files.") : "Viewer mode — take control to send"}">${escapeHtml(this.promptDraft)}</textarea>
            ${renderCommandAutocomplete(this.commandAutocomplete)}
            ${renderFileAutocomplete(this.fileAutocomplete)}
          </div>
          <div class="controls ${isRunning ? "running" : ""}">
            <button id="attachImages" class="icon-button" title="Attach screenshot" aria-label="Attach screenshot" ${isController ? "" : "disabled"}>📎</button>
            <button id="send" class="primary-action" ${isController ? "" : "disabled"}>${isRunning ? "Steer" : "Send"}<small>Enter</small></button>
            <button id="followUp" class="secondary-action ${isRunning ? "" : "hidden"}" ${isController ? "" : "disabled"}>Follow-up<small>Alt+Enter</small></button>
            <button id="abort" class="${isRunning ? "danger" : "hidden"}" ${isController ? "" : "disabled"}>Abort</button>
          </div>
        </footer>
      </main>
      ${this.mobileLayout ? "" : this.renderRightPanel()}
      ${this.renderMobileMetadataSuggestion()}
      ${this.renderTreeDrawer()}
    `;
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
    }
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    if (this.focusPendingQuestionOnNextRender) {
      this.focusPendingQuestionOnNextRender = false;
      this.focusQuestionPanel();
    }
    if (this.focusTreeOnNextRender && this.rightPanelTab === "tree") {
      const tree = this.visibleTreeContainer();
      const currentId = this.currentTreeEntryId();
      if (currentId) this.treeActiveEntryId = currentId;
      const treeRow = tree?.querySelector<HTMLElement>(currentId ? `[data-tree-entry-id="${CSS.escape(currentId)}"]` : "[tabindex='0']");
      if (treeRow) {
        this.focusTreeOnNextRender = false;
        this.setActiveTreeEntry(treeRow.dataset.treeEntryId ?? "", treeRow, false);
        treeRow.focus({ preventScroll: true });
        const panel = treeRow.closest<HTMLElement>(".tree-panel");
        const scrollToCurrent = () => {
          if (panel) panel.scrollTop = 0;
        };
        scrollToCurrent();
        requestAnimationFrame(scrollToCurrent);
      }
    }
    recordPerfSample("render", performance.now() - renderStart);
  }
}

customElements.define("pi-web-agent", PiWebAgentApp);
