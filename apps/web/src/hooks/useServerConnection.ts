import { useState, useEffect, useRef, useCallback } from "react";
import type {
  AppConfig,
  AppSettings,
  AnswerQuestionPayload,
  ControllerInfo,
  PendingQuestion,
  ServerEnvelope,
  HelloMessage,
  ModelInfo,
  SessionIsolationKind,
  SessionRuntimeSettings,
  SessionSnapshot,
  WebSession,
  Workspace,
  ExtensionCatalog,
} from "@pi-web-agent/protocol";
import type { ConnectionStatus } from "@/lib/session-utils";
import type { PromptImage } from "@/lib/prompt-images";
import type { SendMode } from "@/components/Composer";
import { loadExtensionCatalog } from "@/lib/extension-cards";

export type RunningQueueName = "steering" | "followUp";
export type RunningQueueItem = { text: string; imageCount?: number | undefined; status?: "queued" | "pendingTranscript" | undefined };
export type RunningQueueState = { steering: RunningQueueItem[]; followUp: RunningQueueItem[] };

const emptyRunningQueue = (): RunningQueueState => ({ steering: [], followUp: [] });

function defaultApiBase(): string {
  const env = (import.meta.env.VITE_PI_WEB_API_BASE as string | undefined)?.trim();
  if (env) return env.replace(/\/$/, "");
  const { protocol, hostname } = window.location;
  return `${protocol === "https:" ? "https:" : "http:"}//${hostname || "127.0.0.1"}:3141`;
}

function reconnectDelay(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function wsUrl(apiBase: string, sessionId: string, token: string, clientId: string | null): string {
  const url = new URL(`${apiBase}/api/sessions/${sessionId}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  if (clientId) url.searchParams.set("clientId", clientId);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentEventData(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.data)) return event;
  return { ...event.data, eventTime: event.time };
}

function replaceSession(sessions: WebSession[], session: WebSession): WebSession[] {
  return sessions.some((candidate) => candidate.id === session.id)
    ? sessions.map((candidate) => candidate.id === session.id ? session : candidate)
    : [session, ...sessions];
}

type ModelCatalog = {
  defaultModel: string | null;
  models: ModelInfo[];
  thinking: { default: string; levels: string[] };
};

function fallbackRuntimeSettings(config: AppConfig | null, catalog: ModelCatalog | null): SessionRuntimeSettings | null {
  if (!config) return null;
  const availableModels = catalog?.models ?? [];
  const defaultModel = catalog?.defaultModel ?? config.modelPolicy.defaultModel ?? null;
  const model = availableModels.find((item) => item.id === defaultModel) ?? availableModels[0] ?? null;
  return {
    model,
    availableModels,
    thinkingLevel: catalog?.thinking.default ?? config.modelPolicy.defaultThinkingLevel,
    availableThinkingLevels: catalog?.thinking.levels ?? config.modelPolicy.allowedThinkingLevels,
    contextUsage: { tokens: null, contextWindow: 1, percent: null },
  };
}

export type ServerConnectionHandle = {
  sessions: WebSession[];
  workspaces: Workspace[];
  config: AppConfig | null;
  appSettings: AppSettings | null;
  runtimeSettings: SessionRuntimeSettings | null;
  selectedSession: WebSession | null;
  connectionStatus: ConnectionStatus;
  snapshot: SessionSnapshot | null;
  pendingQuestion: PendingQuestion | null;
  controller: ControllerInfo | null;
  extensionCatalog: ExtensionCatalog | null;
  runningQueue: RunningQueueState;
  isBootstrapping: boolean;
  bootstrapError: string | null;
  apiBase: string;
  token: string;
  selectSession: (id: string) => void;
  newSession: (cwd?: string) => Promise<WebSession | null>;
  newIsolatedSession: (cwd?: string) => Promise<WebSession | null>;
  attachWorkspace: (sessionId: string, cwd: string) => Promise<WebSession | null>;
  deleteSession: (id: string) => Promise<{ deleted: boolean; nextSession: WebSession | null; error?: string }>;
  renameSession: (id: string, title: string) => Promise<{ renamed: boolean; error?: string }>;
  togglePinSession: (id: string, pinned: boolean) => Promise<WebSession | null>;
  forkSession: (sourceSessionId: string, entryId: string) => Promise<WebSession | null>;
  updateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
  cancelQueuedMessage: (queue: RunningQueueName, index: number, text?: string) => void;
  send: (sessionId: string, text: string, images: PromptImage[], followUp: boolean, mode?: SendMode) => void;
  abort: (sessionId: string) => void;
  answerQuestion: (payload: AnswerQuestionPayload) => void;
  takeControl: () => void;
  saveConnection: (apiBase: string, token: string) => void;
  saveAppSettings: (updates: Partial<AppSettings>) => Promise<void>;
  setModel: (sessionId: string, model: string) => void;
  setThinking: (sessionId: string, level: string) => void;
  subscribeAgentEvents: (cb: (event: unknown) => void) => () => void;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export function useServerConnection(preferredSessionId?: string | null): ServerConnectionHandle {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem("piWebApiBase") ?? defaultApiBase());
  const [token, setToken] = useState(() => localStorage.getItem("piWebAuthToken") ?? ((import.meta.env.VITE_PI_WEB_AUTH_TOKEN as string | undefined)?.trim() ?? ""));
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<SessionRuntimeSettings | null>(null);
  const [selectedSession, setSelectedSession] = useState<WebSession | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [controller, setController] = useState<ControllerInfo | null>(null);
  const [extensionCatalog, setExtensionCatalog] = useState<ExtensionCatalog | null>(null);
  const [runningQueue, setRunningQueue] = useState<RunningQueueState>(() => emptyRunningQueue());
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>("disconnected");

  // Refs so callbacks always see latest values without re-creating
  const apiBaseRef = useRef(apiBase);
  const tokenRef = useRef(token);
  const configRef = useRef<AppConfig | null>(null);
  const modelCatalogRef = useRef<ModelCatalog | null>(null);
  const preferredSessionIdRef = useRef(preferredSessionId);
  const selectedSessionRef = useRef<WebSession | null>(null);
  const sessionsRef = useRef<WebSession[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const genRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const agentEventListenersRef = useRef<Set<(event: unknown) => void>>(new Set());
  const runningQueueRef = useRef<RunningQueueState>(emptyRunningQueue());
  const pendingPinUpdatesRef = useRef<Map<string, boolean>>(new Map());
  const clientIdsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => { apiBaseRef.current = apiBase; }, [apiBase]);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { modelCatalogRef.current = modelCatalog; }, [modelCatalog]);
  useEffect(() => { preferredSessionIdRef.current = preferredSessionId; }, [preferredSessionId]);
  useEffect(() => { connectionStatusRef.current = connectionStatus; }, [connectionStatus]);

  const api = useCallback(async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers: HeadersInit = {};
    if (init?.body !== undefined && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
    if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;
    const res = await fetch(`${apiBaseRef.current}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }, []);

  const mergeSessionUpdate = useCallback((incoming: WebSession): WebSession => {
    const pendingPinned = pendingPinUpdatesRef.current.get(incoming.id);
    const current = sessionsRef.current.find((session) => session.id === incoming.id);
    const merged = {
      ...current,
      ...incoming,
      pinned: pendingPinned ?? incoming.pinned,
    };
    const next = replaceSession(sessionsRef.current, merged);
    sessionsRef.current = next;
    setSessions(next);
    if (selectedSessionRef.current?.id === merged.id) {
      selectedSessionRef.current = merged;
      setSelectedSession(merged);
    }
    setSnapshot((currentSnapshot) => currentSnapshot?.session.id === merged.id
      ? { ...currentSnapshot, session: { ...currentSnapshot.session, ...merged } }
      : currentSnapshot);
    return merged;
  }, []);

  const connectWebSocket = useCallback((session: WebSession) => {
    // Bump generation — stale socket callbacks will bail out
    const gen = ++genRef.current;
    clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    reconnectAttemptRef.current = 0;

    setConnectionStatus("connecting");
    setSnapshot(null);
    setRuntimeSettings(fallbackRuntimeSettings(configRef.current, modelCatalogRef.current));
    setPendingQuestion(null);
    setController(null);
    setRunningQueue(emptyRunningQueue());
    runningQueueRef.current = emptyRunningQueue();

    // Keep WebSocket identities tab-scoped. Persisting these ids in localStorage makes
    // multiple tabs for the same session evict each other forever because the server
    // treats a repeated clientId as a reconnect of the same client.
    const clientId = clientIdsRef.current.get(session.id) ?? null;
    const ws = new WebSocket(wsUrl(apiBaseRef.current, session.id, tokenRef.current, clientId));
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      if (genRef.current !== gen) return;
      // Waiting for session_snapshot — status stays "connecting"
    });

    ws.addEventListener("message", (event) => {
      if (genRef.current !== gen) return;
      try {
        const data = JSON.parse(event.data as string) as ServerEnvelope | HelloMessage;
        if (!("payload" in data)) {
          // HelloMessage
          if (data.type === "hello") {
            clientIdsRef.current.set(data.sessionId, data.clientId);
          }
          return;
        }
        const { payload } = data;
        if (payload.type === "session_snapshot") {
          reconnectAttemptRef.current = 0;
          setIsBootstrapping(false);
          setBootstrapError(null);
          const snap = payload.snapshot;
          setSnapshot(snap);
          setRuntimeSettings(snap.settings ?? fallbackRuntimeSettings(configRef.current, modelCatalogRef.current));
          setConnectionStatus(snap.status);
          setPendingQuestion(snap.pendingQuestion ?? null);
          setController(snap.controller ?? null);
          // Update session list with fresh data from snapshot
          mergeSessionUpdate(snap.session);
        } else if (payload.type === "agent_event") {
          const eventData = agentEventData(payload.event);
          // Broadcast to transcript subscribers
          agentEventListenersRef.current.forEach((cb) => cb(eventData));
          // Update running status from agent events
          const eventType = isRecord(eventData) ? String(eventData.type ?? "") : "";
          if (eventType === "queue_update" && isRecord(eventData)) {
            reconcileRunningQueue(
              Array.isArray(eventData.steering) ? eventData.steering : [],
              Array.isArray(eventData.followUp) ? eventData.followUp : [],
            );
          }
          if (eventType === "message_end" && isRecord(eventData) && isRecord(eventData.message) && eventData.message.role === "user") {
            removePendingTranscriptQueueItem(String(eventData.message.content ?? ""));
          }
          if (eventType === "agent_start" || eventType === "turn_start") {
            setConnectionStatus("running");
          } else if (eventType === "agent_end" || eventType === "turn_end") {
            setConnectionStatus("idle");
          }
        } else if (payload.type === "question_update") {
          setPendingQuestion(payload.question ?? null);
        } else if (payload.type === "controller_update") {
          setController(payload.controller);
        } else if (payload.type === "settings_update") {
          setRuntimeSettings(payload.settings);
        } else if (payload.type === "session_metadata_update") {
          mergeSessionUpdate(payload.session);
        } else if (payload.type === "error") {
          agentEventListenersRef.current.forEach((cb) => cb({
            type: "web_command_result",
            id: `server-error:${Date.now()}`,
            title: "Server error",
            body: `${payload.code}: ${payload.message}`,
            isError: true,
          }));
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.addEventListener("close", () => {
      if (genRef.current !== gen) return;
      setConnectionStatus("disconnected");
      setIsBootstrapping(false);
      // Schedule reconnect
      const attempt = ++reconnectAttemptRef.current;
      if (attempt > 8) return; // Give up
      const delay = reconnectDelay(attempt);
      reconnectTimerRef.current = setTimeout(() => {
        if (genRef.current !== gen) return;
        // Re-use same generation — reconnect is part of same "session open"
        genRef.current--; // will be re-incremented inside connectWebSocket
        connectWebSocket(session);
      }, delay);
    });

    ws.addEventListener("error", () => {
      // Will fire close next; nothing extra needed
    });
  }, [mergeSessionUpdate]);

  const fetchInitialData = useCallback(async () => {
    setIsBootstrapping(true);
    setBootstrapError(null);
    try {
      const [fetchedConfig, fetchedModelCatalog, fetchedWorkspaces, fetchedSessions, fetchedSettings] = await Promise.all([
        api<AppConfig>("/api/config"),
        api<ModelCatalog>("/api/models"),
        api<Workspace[]>("/api/workspaces"),
        api<WebSession[]>("/api/sessions"),
        api<AppSettings>("/api/settings"),
      ]);
      setConfig(fetchedConfig);
      configRef.current = fetchedConfig;
      setModelCatalog(fetchedModelCatalog);
      modelCatalogRef.current = fetchedModelCatalog;
      setWorkspaces(fetchedWorkspaces);
      setAppSettings(fetchedSettings);
      setRuntimeSettings((current) => current ?? fallbackRuntimeSettings(fetchedConfig, fetchedModelCatalog));
      void loadExtensionCatalog({ apiBase: apiBaseRef.current, token: tokenRef.current, api }).then(setExtensionCatalog).catch(() => setExtensionCatalog(null));
      setSessions(fetchedSessions);
      sessionsRef.current = fetchedSessions;

      // Re-open selected session with fresh data (or auto-select last)
      const currentId = preferredSessionIdRef.current ?? selectedSessionRef.current?.id ?? localStorage.getItem("piWebLastSessionId");
      let connectingInitialSession = false;
      if (currentId) {
        const fresh = fetchedSessions.find((s) => s.id === currentId);
        if (fresh) {
          localStorage.setItem("piWebLastSessionId", fresh.id);
          setSelectedSession(fresh);
          selectedSessionRef.current = fresh;
          connectWebSocket(fresh);
          connectingInitialSession = true;
        }
      }
      if (!connectingInitialSession) {
        setIsBootstrapping(false);
      }
    } catch (error) {
      setBootstrapError(error instanceof Error ? error.message : String(error));
      // Connection unavailable — stay disconnected
      setIsBootstrapping(false);
    }
  }, [api, connectWebSocket]);

  // Initial fetch on mount + cleanup
  useEffect(() => {
    void fetchInitialData();
    return () => {
      clearTimeout(reconnectTimerRef.current);
      genRef.current++;
      wsRef.current?.close();
    };
  }, [fetchInitialData]);

  const selectSession = useCallback((id: string) => {
    const existingSocket = wsRef.current;
    if (
      selectedSessionRef.current?.id === id
      && existingSocket
      && (existingSocket.readyState === WebSocket.CONNECTING || existingSocket.readyState === WebSocket.OPEN)
    ) {
      localStorage.setItem("piWebLastSessionId", id);
      return;
    }

    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    localStorage.setItem("piWebLastSessionId", id);
    setSelectedSession(session);
    selectedSessionRef.current = session;
    connectWebSocket(session);
  }, [connectWebSocket]);

  const newSession = useCallback(async (cwdOverride?: string) => {
    try {
      const body = cwdOverride
        ? { cwd: cwdOverride, isolation: "none" as SessionIsolationKind }
        : {};
      const session = await api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSessions((prev) => {
        const next = [session, ...prev];
        sessionsRef.current = next;
        return next;
      });
      localStorage.setItem("piWebLastSessionId", session.id);
      setSelectedSession(session);
      selectedSessionRef.current = session;
      connectWebSocket(session);
      return session;
    } catch {
      // TODO: surface error
      return null;
    }
  }, [api, connectWebSocket]);

  const attachWorkspace = useCallback(async (sessionId: string, cwd: string) => {
    try {
      const updated = await api<WebSession>(`/api/sessions/${encodeURIComponent(sessionId)}/workspace`, {
        method: "PATCH",
        body: JSON.stringify({ cwd }),
      });
      setSessions((prev) => {
        const next = prev.map((s) => (s.id === sessionId ? updated : s));
        sessionsRef.current = next;
        return next;
      });
      if (selectedSessionRef.current?.id === sessionId) {
        setSelectedSession(updated);
        selectedSessionRef.current = updated;
        connectWebSocket(updated);
      }
      return updated;
    } catch {
      return null;
    }
  }, [api, connectWebSocket]);

  const newIsolatedSession = useCallback(async (cwdOverride?: string) => {
    const cwd = cwdOverride ?? workspaces[0]?.path;
    if (!cwd) return null;
    try {
      const session = await api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd, isolation: "git_worktree" as SessionIsolationKind }),
      });
      setSessions((prev) => {
        const next = [session, ...prev];
        sessionsRef.current = next;
        return next;
      });
      localStorage.setItem("piWebLastSessionId", session.id);
      setSelectedSession(session);
      selectedSessionRef.current = session;
      connectWebSocket(session);
      return session;
    } catch {
      // TODO: surface error
      return null;
    }
  }, [api, connectWebSocket, workspaces]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

      const nextSessions = sessionsRef.current.filter((session) => session.id !== id);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      clientIdsRef.current.delete(id);

      if (selectedSessionRef.current?.id !== id) {
        return { deleted: true, nextSession: selectedSessionRef.current };
      }

      const nextSession = nextSessions[0] ?? null;
      if (nextSession) {
        localStorage.setItem("piWebLastSessionId", nextSession.id);
        setSelectedSession(nextSession);
        selectedSessionRef.current = nextSession;
        connectWebSocket(nextSession);
      } else {
        localStorage.removeItem("piWebLastSessionId");
        selectedSessionRef.current = null;
        setSelectedSession(null);
        setSnapshot(null);
        setRuntimeSettings(null);
        setPendingQuestion(null);
        setController(null);
        setRunningQueue(emptyRunningQueue());
        runningQueueRef.current = emptyRunningQueue();
        setConnectionStatus("disconnected");
        genRef.current++;
        clearTimeout(reconnectTimerRef.current);
        wsRef.current?.close();
        wsRef.current = null;
      }

      return { deleted: true, nextSession };
    } catch (error) {
      return {
        deleted: false,
        nextSession: selectedSessionRef.current,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [api, connectWebSocket]);

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await api<WebSession>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      mergeSessionUpdate(updated);
      return { renamed: true };
    } catch (error) {
      return { renamed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [api, mergeSessionUpdate]);

  const togglePinSession = useCallback(async (id: string, pinned: boolean) => {
    const previousSessions = sessionsRef.current;
    const previousSelectedSession = selectedSessionRef.current;
    const optimisticSessions = previousSessions.map((s) => s.id === id ? { ...s, pinned } : s);
    pendingPinUpdatesRef.current.set(id, pinned);
    sessionsRef.current = optimisticSessions;
    setSessions(optimisticSessions);
    if (previousSelectedSession?.id === id) {
      const optimisticSelected = { ...previousSelectedSession, pinned };
      selectedSessionRef.current = optimisticSelected;
      setSelectedSession(optimisticSelected);
    }
    try {
      const updated = await api<WebSession>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
      const reconciled = mergeSessionUpdate({ ...updated, pinned });
      pendingPinUpdatesRef.current.delete(id);
      return reconciled;
    } catch {
      pendingPinUpdatesRef.current.delete(id);
      sessionsRef.current = previousSessions;
      setSessions(previousSessions);
      if (previousSelectedSession?.id === id) {
        selectedSessionRef.current = previousSelectedSession;
        setSelectedSession(previousSelectedSession);
      }
      return null;
    }
  }, [api, mergeSessionUpdate]);

  const forkSession = useCallback(async (sourceSessionId: string, entryId: string) => {
    try {
      const session = await api<WebSession>(`/api/sessions/${encodeURIComponent(sourceSessionId)}/fork`, {
        method: "POST",
        body: JSON.stringify({ entryId }),
      });
      setSessions((prev) => {
        const next = [session, ...prev.filter((candidate) => candidate.id !== session.id)];
        sessionsRef.current = next;
        return next;
      });
      localStorage.setItem("piWebLastSessionId", session.id);
      setSelectedSession(session);
      selectedSessionRef.current = session;
      connectWebSocket(session);
      return session;
    } catch {
      return null;
    }
  }, [api, connectWebSocket]);

  const updateSessionMetadata = useCallback(async (id: string, input: { title?: string | null; summary?: string | null }) => {
    try {
      const updated = await api<WebSession>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      mergeSessionUpdate(updated);
      return updated;
    } catch {
      return null;
    }
  }, [api, mergeSessionUpdate]);

  const send = useCallback((_sessionId: string, text: string, images: PromptImage[], followUp: boolean, mode: SendMode = "prompt") => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const imageDataUrls = images.map((img) => img.dataUrl);
    const trimmed = text.trimStart();
    // Bash shorthand: !! = no-context bash, ! = bash
    if (trimmed.startsWith("!!")) {
      const command = trimmed.slice(2).trim();
      if (command) { ws.send(JSON.stringify({ type: "bash", command, excludeFromContext: true })); return; }
    }
    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (command) { ws.send(JSON.stringify({ type: "bash", command, excludeFromContext: false })); return; }
    }
    // Slash command
    if (trimmed.startsWith("/")) {
      ws.send(JSON.stringify({ type: "command", text: trimmed }));
      return;
    }
    const isRunning = connectionStatusRef.current === "running";
    const type = followUp ? "follow_up" : mode === "ask" ? "ask" : isRunning ? "steer" : "prompt";
    const msg: Record<string, unknown> = { type, text };
    if (imageDataUrls.length > 0) msg.images = imageDataUrls;
    ws.send(JSON.stringify(msg));
    if (type === "steer") addRunningQueueItem("steering", { text, imageCount: images.length || undefined, status: "queued" });
    if (type === "follow_up") addRunningQueueItem("followUp", { text, imageCount: images.length || undefined, status: "queued" });
  }, []);

  function addRunningQueueItem(queue: RunningQueueName, item: RunningQueueItem) {
    const next = { ...runningQueueRef.current, [queue]: [...runningQueueRef.current[queue], item] };
    runningQueueRef.current = next;
    setRunningQueue(next);
  }

  function reconcileRunningQueue(steering: unknown[], followUp: unknown[]) {
    const previous = runningQueueRef.current;
    const reconcile = (name: RunningQueueName, values: unknown[]): RunningQueueItem[] => {
      const previousItems = [...previous[name]];
      const queued = values.map((value) => {
        const text = String(value);
        const matchIndex = previousItems.findIndex((item) => item.text === text && item.status !== "pendingTranscript");
        const match = matchIndex >= 0 ? previousItems.splice(matchIndex, 1)[0] : undefined;
        return { text, imageCount: match?.imageCount, status: "queued" as const };
      });
      const pendingTranscript = name === "followUp"
        ? previousItems
          .filter((item) => item.status !== "pendingTranscript" || !queued.some((queuedItem) => queuedItem.text === item.text))
          .map((item) => ({ ...item, status: "pendingTranscript" as const }))
        : [];
      return [...queued, ...pendingTranscript];
    };
    const next = { steering: reconcile("steering", steering), followUp: reconcile("followUp", followUp) };
    runningQueueRef.current = next;
    setRunningQueue(next);
  }

  function removePendingTranscriptQueueItem(text: string) {
    const nextFollowUp = runningQueueRef.current.followUp.filter((item) => item.status !== "pendingTranscript" || item.text !== text);
    if (nextFollowUp.length === runningQueueRef.current.followUp.length) return;
    const next = { ...runningQueueRef.current, followUp: nextFollowUp };
    runningQueueRef.current = next;
    setRunningQueue(next);
  }

  const cancelQueuedMessage = useCallback((queue: RunningQueueName, index: number, text?: string) => {
    const ws = wsRef.current;
    const next = { ...runningQueueRef.current, [queue]: runningQueueRef.current[queue].filter((_, candidateIndex) => candidateIndex !== index) };
    runningQueueRef.current = next;
    setRunningQueue(next);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "cancel_queued_message", queue, index, ...(text ? { text } : {}) }));
  }, []);

  const abort = useCallback((_: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "abort" }));
  }, []);

  const answerQuestion = useCallback((payload: AnswerQuestionPayload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "answer_question", payload }));
  }, []);

  const takeControl = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "take_control" }));
  }, []);

  const setModel = useCallback((_: string, model: string) => {
    const ws = wsRef.current;
    if (!model || !ws || ws.readyState !== WebSocket.OPEN) return;
    setRuntimeSettings((current) => {
      if (!current) return current;
      const selected = current.availableModels.find((item) => item.id === model);
      return selected ? { ...current, model: selected } : current;
    });
    ws.send(JSON.stringify({ type: "set_model", model }));
  }, []);

  const setThinking = useCallback((_: string, level: string) => {
    const ws = wsRef.current;
    if (!level || !ws || ws.readyState !== WebSocket.OPEN) return;
    setRuntimeSettings((current) => current ? { ...current, thinkingLevel: level } : current);
    ws.send(JSON.stringify({ type: "set_thinking", level }));
  }, []);

  const saveConnection = useCallback((newApiBase: string, newToken: string) => {
    localStorage.setItem("piWebApiBase", newApiBase);
    localStorage.setItem("piWebAuthToken", newToken);
    apiBaseRef.current = newApiBase;
    tokenRef.current = newToken;
    setApiBase(newApiBase);
    setToken(newToken);
    void fetchInitialData();
  }, [fetchInitialData]);

  const subscribeAgentEvents = useCallback((cb: (event: unknown) => void) => {
    agentEventListenersRef.current.add(cb);
    return () => { agentEventListenersRef.current.delete(cb); };
  }, []);

  const saveAppSettings = useCallback(async (updates: Partial<AppSettings>) => {
    const updated = await api<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    setAppSettings(updated);
  }, [api]);

  return {
    sessions,
    workspaces,
    config,
    appSettings,
    runtimeSettings,
    selectedSession,
    connectionStatus,
    snapshot,
    pendingQuestion,
    controller,
    extensionCatalog,
    runningQueue,
    isBootstrapping,
    bootstrapError,
    apiBase,
    token,
    selectSession,
    newSession,
    newIsolatedSession,
    attachWorkspace,
    deleteSession,
    renameSession,
    togglePinSession,
    forkSession,
    updateSessionMetadata,
    cancelQueuedMessage,
    send,
    abort,
    answerQuestion,
    takeControl,
    saveConnection,
    saveAppSettings,
    setModel,
    setThinking,
    subscribeAgentEvents,
    fetchJson: api,
  };
}
