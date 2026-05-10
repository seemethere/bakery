import type { WebSession } from "@pi-web-agent/protocol";

export type AgentStatusForConnection = "idle" | "running" | "disconnected" | "connecting";
export type ConnectionStateForController = "connected" | "connecting" | "reconnecting" | "disconnected" | "retry_failed";

export type SessionConnectionContext = {
  apiBase: () => string;
  token: () => string;
  status: () => AgentStatusForConnection | string;
  selectedSessionId: () => string | null | undefined;
  nextSocketGeneration: () => number;
  isCurrentSocketGeneration: (generation: number) => boolean;
  setSocket: (socket: WebSocket | null) => void;
  clearReconnectTimer: () => void;
  setReconnectTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
  incrementReconnectAttempt: () => number;
  resetReconnectAttempt: () => void;
  setConnectionState: (state: ConnectionStateForController) => void;
  setConnectionMessage: (message: string) => void;
  setAgentStatus: (status: AgentStatusForConnection) => void;
  handleSocketMessage: (raw: string) => void;
  requestRender: (delayMs?: number) => void;
};

export function sessionWebSocketUrl(apiBase: string, sessionId: string, token: string, clientId: string | null): URL {
  const url = new URL(`${apiBase}/api/sessions/${sessionId}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  if (clientId) url.searchParams.set("clientId", clientId);
  return url;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1));
}

export function connectSessionWebSocket(ctx: SessionConnectionContext, session: WebSession, state: ConnectionStateForController): void {
  const generation = ctx.nextSocketGeneration();
  ctx.clearReconnectTimer();
  ctx.setConnectionState(state);
  ctx.setConnectionMessage(state === "reconnecting" ? `Reconnecting to ${session.id}...` : `Connecting to ${session.id}...`);
  ctx.setAgentStatus(ctx.status() === "running" ? "running" : "connecting");

  const rememberedClientId = localStorage.getItem(`piWebClientId:${session.id}`);
  const socket = new WebSocket(sessionWebSocketUrl(ctx.apiBase(), session.id, ctx.token(), rememberedClientId));
  ctx.setSocket(socket);
  socket.addEventListener("open", () => {
    if (!ctx.isCurrentSocketGeneration(generation)) return;
    ctx.setConnectionState(state === "reconnecting" ? "reconnecting" : "connecting");
    ctx.setConnectionMessage("Socket opened; waiting for session snapshot...");
    ctx.requestRender(0);
  });
  socket.addEventListener("message", (event) => {
    if (!ctx.isCurrentSocketGeneration(generation)) return;
    ctx.handleSocketMessage(event.data as string);
  });
  socket.addEventListener("close", () => {
    if (!ctx.isCurrentSocketGeneration(generation)) return;
    handleSocketClose(ctx, session);
  });
  socket.addEventListener("error", () => {
    if (!ctx.isCurrentSocketGeneration(generation)) return;
    ctx.setConnectionMessage("Connection error; retrying if possible.");
    ctx.requestRender(0);
  });
}

export function handleSocketClose(ctx: SessionConnectionContext, session: WebSession): void {
  if (ctx.selectedSessionId() !== session.id) return;
  ctx.setAgentStatus("disconnected");
  ctx.setConnectionState("disconnected");
  ctx.setConnectionMessage("Connection lost. Retrying shortly...");
  scheduleReconnect(ctx, session);
  ctx.requestRender(0);
}

export function scheduleReconnect(ctx: SessionConnectionContext, session: WebSession): void {
  ctx.clearReconnectTimer();
  const attempt = ctx.incrementReconnectAttempt();
  if (attempt > 8) {
    ctx.setConnectionState("retry_failed");
    ctx.setConnectionMessage("Reconnect failed. Check whether the backend is running, then use Save / Refresh or reopen the session.");
    return;
  }
  const delay = reconnectDelayMs(attempt);
  ctx.setConnectionState("reconnecting");
  ctx.setConnectionMessage(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}/8)...`);
  ctx.setReconnectTimer(setTimeout(() => {
    if (ctx.selectedSessionId() !== session.id) return;
    connectSessionWebSocket(ctx, session, "reconnecting");
    ctx.requestRender(0);
  }, delay));
}
