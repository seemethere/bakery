import type { FastifyInstance } from "fastify";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  type ActiveToolExecutionSnapshot,
  type ControllerInfo,
  type HelloMessage,
  type NormalizedAgentEvent,
  type ServerEnvelope,
  type ServerMessage,
  type SessionSnapshot,
  type WebSession,
} from "@pi-web-agent/protocol";
import type { ServerConfig } from "./config.js";
import { parseSlashCommand, runBundledExtensionCommand } from "./extensions.js";
import { cleanMetadataText, firstPromptTitle, generateAndApplySessionDetails } from "./metadata-routes.js";
import type { MetadataStore, SubmittedPromptRecord, WebCommandResultRecord } from "./metadata-store.js";
import type { ImageContent, PiSessionRunner, SessionHandle } from "./pi-runner.js";
import { isBrowserOriginAllowed } from "./security-origin.js";

function envelope(seq: number, payload: ServerMessage): ServerEnvelope {
  return { seq, time: new Date().toISOString(), payload };
}

export function dataUrlToImageContent(value: string): ImageContent {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) throw new Error("Images must be png, jpeg, gif, or webp data URLs");
  return { type: "image", mimeType: match[1]!.toLowerCase(), data: match[2]!.replace(/\s/g, "") };
}

function askPrompt(text: string): string {
  return [
    "Answer the following operator question directly.",
    "Treat this as an ask/explain turn: do not edit files, run shell commands, or call tools unless the operator explicitly asks you to.",
    "",
    text,
  ].join("\n");
}

export function parseNameCommand(text: string): { matched: boolean; clear?: boolean; title?: string } {
  const trimmed = text.trim();
  if (!/^\/name(?:\s|$)/.test(trimmed)) return { matched: false };
  const args = trimmed.replace(/^\/name(?:\s+)?/, "").trim();
  if (args === "--clear") return { matched: true, clear: true };
  if (!args) return { matched: true };
  return { matched: true, title: cleanMetadataText(args, 120) };
}

type WebCommandResultSnapshotMessage = {
  role: "webCommandResult";
  id: string;
  title: string;
  body: string;
  isError: boolean;
  timestamp: string;
  data?: unknown;
};

type SubmittedPromptSnapshotMessage = {
  role: "user";
  id: string;
  content: Array<{ type: "text"; text: string }>;
  timestamp: string;
  webSubmittedPrompt: true;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function messageTimestampMs(message: unknown): number | null {
  if (!isRecord(message)) return null;
  return timestampMs(message.timestamp);
}

function webCommandResultSnapshotMessage(record: WebCommandResultRecord): WebCommandResultSnapshotMessage {
  return {
    role: "webCommandResult",
    id: record.id,
    title: record.title,
    body: record.body,
    isError: record.isError,
    timestamp: record.timestamp,
    ...(record.data !== undefined ? { data: record.data } : {}),
  };
}

function submittedPromptSnapshotMessage(record: SubmittedPromptRecord): SubmittedPromptSnapshotMessage {
  return {
    role: "user",
    id: record.id,
    content: [{ type: "text", text: record.text }],
    timestamp: record.timestamp,
    webSubmittedPrompt: true,
    ...(record.error ? { error: record.error } : {}),
  };
}

function messageText(message: unknown): string | null {
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function userMessageText(message: unknown): string | null {
  return isRecord(message) && message.role === "user" ? messageText(message) : null;
}

function submittedPromptMatchesMessage(record: SubmittedPromptRecord, text: string): boolean {
  return record.text === text || (record.kind === "ask" && askPrompt(record.text) === text);
}

export function mergeSnapshotMessagesWithWebCommands(messages: unknown[], records: WebCommandResultRecord[], submittedPrompts: SubmittedPromptRecord[] = []): unknown[] {
  const userTexts = messages.map(userMessageText).filter((value): value is string => Boolean(value));
  const promptMessages = submittedPrompts
    .filter((record) => !userTexts.some((text) => submittedPromptMatchesMessage(record, text)))
    .map(submittedPromptSnapshotMessage);
  const commandMessages = records.map(webCommandResultSnapshotMessage);
  const webMessages = [...promptMessages, ...commandMessages];
  if (messages.length === 0) return webMessages;
  if (webMessages.length === 0) return messages;

  const messageEntries = messages.map((message, index) => ({ kind: "message" as const, value: message, time: messageTimestampMs(message), index }));
  const webEntries = webMessages.map((message, index) => ({ kind: "web" as const, value: message, time: timestampMs(message.timestamp), index }));

  // If the runner snapshot lacks reliable timestamps, fall back to the previous
  // append behavior rather than guessing where persisted web-only cards belong.
  if (messageEntries.some((entry) => entry.time === null) || webEntries.some((entry) => entry.time === null)) return [...messages, ...webMessages];

  return [...messageEntries, ...webEntries]
    .sort((left, right) => {
      const byTime = left.time! - right.time!;
      if (byTime !== 0) return byTime;
      if (left.kind !== right.kind) return left.kind === "message" ? -1 : 1;
      return left.index - right.index;
    })
    .map((entry) => entry.value);
}

export function activeToolCallId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const id = value.toolCallId;
  return typeof id === "string" && id.trim() ? id : null;
}

export function activeToolSnapshotFromEvent(event: NormalizedAgentEvent, existing?: ActiveToolExecutionSnapshot): ActiveToolExecutionSnapshot | null {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update") return null;
  if (!isRecord(event.data)) return null;
  const toolCallId = activeToolCallId(event.data);
  if (!toolCallId) return null;
  const snapshot: ActiveToolExecutionSnapshot = {
    ...existing,
    ...event.data,
    type: event.type,
    toolCallId,
    ...(typeof event.time === "string" ? { eventTime: event.time } : {}),
  };
  if (existing?.toolName !== undefined && snapshot.toolName === undefined) snapshot.toolName = existing.toolName;
  if (existing?.args !== undefined && snapshot.args === undefined) snapshot.args = existing.args;
  if (existing?.startedAt !== undefined && snapshot.startedAt === undefined) snapshot.startedAt = existing.startedAt;
  return snapshot;
}

type SocketClient = {
  clientId: string;
  seq: number;
  snapshotPending: boolean;
  bufferedPayloads: ServerMessage[];
  socket: { send(data: string): void; close(code?: number, reason?: string): void; on(event: string, listener: (...args: never[]) => void): void };
};

export type BroadcastMetricsSnapshot = {
  broadcasts: number;
  sentMessages: number;
  bufferedMessages: number;
  sentBytes: number;
  maxPayloadBytes: number;
  maxBufferedPayloads: number;
  maxClients: number;
  slowestBroadcastMs: number;
  lastPayloadType: ServerMessage["type"] | null;
};

function emptyBroadcastMetrics(): BroadcastMetricsSnapshot {
  return { broadcasts: 0, sentMessages: 0, bufferedMessages: 0, sentBytes: 0, maxPayloadBytes: 0, maxBufferedPayloads: 0, maxClients: 0, slowestBroadcastMs: 0, lastPayloadType: null };
}

export type SessionBroadcaster = Pick<SessionHub, "broadcastMetadataUpdate">;

export type SessionHubRegistry = {
  getBroadcaster(sessionId: string): SessionBroadcaster | undefined;
  disposeHub(sessionId: string): Promise<boolean>;
  disposeAll(): Promise<void>;
  registerRoutes(app: FastifyInstance): void;
};

type SessionHubDeps = {
  config: ServerConfig;
  store: MetadataStore;
  runner: PiSessionRunner;
  removeHub(sessionId: string): void;
};

export class SessionHub {
  private readonly clients = new Map<string, SocketClient>();
  private readonly activeToolExecutions = new Map<string, ActiveToolExecutionSnapshot>();
  private controllerId: string | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingCommands: string[] = [];
  private flushingPendingCommands = false;
  private readonly broadcastMetrics = emptyBroadcastMetrics();
  private readonly sessionId: string;
  private handle: SessionHandle | null;
  private unsubscribe: () => void = () => undefined;
  private unsubscribeQuestion: () => void = () => undefined;
  private promotePromise: Promise<SessionHandle> | null = null;
  private pendingModel: string | null = null;
  private pendingThinkingLevel: string | null = null;

  constructor(sessionId: string, handle: SessionHandle | null, private readonly deps: SessionHubDeps) {
    this.sessionId = sessionId;
    this.handle = null;
    if (handle) this.attachHandle(handle);
  }

  private attachHandle(handle: SessionHandle): void {
    this.handle = handle;
    this.unsubscribe = handle.subscribe((event, raw) => {
      this.reconcileSubmittedPrompt(raw);
      this.rememberActiveToolExecution(event);
      this.broadcast({ type: "agent_event", event, raw });
      if (event.type === "agent_end" || event.type === "turn_end") {
        void this.broadcastSettingsUpdate();
        void this.flushPendingCommands();
      }
      const webSession = this.deps.store.getSession(handle.id);
      if (this.clients.size === 0 && webSession) {
        void handle.snapshot(webSession).then((snapshot) => {
          if (snapshot.status === "idle") this.scheduleDispose();
        });
      }
    });
    this.unsubscribeQuestion = handle.subscribeQuestion((question) => {
      this.broadcast({ type: "question_update", question });
    });
  }

  private reconcileSubmittedPrompt(raw: unknown): void {
    if (!isRecord(raw) || raw.type !== "message_end") return;
    this.reconcileSubmittedPromptText(userMessageText(raw.message));
  }

  private reconcileSubmittedPromptText(text: string | null): void {
    if (!text) return;
    const match = this.deps.store
      .listUnreconciledSubmittedPrompts(this.sessionId)
      .find((record) => submittedPromptMatchesMessage(record, text));
    if (match) this.deps.store.markSubmittedPromptReconciled(this.sessionId, match.id);
  }

  private reconcileSubmittedPromptsFromMessages(messages: unknown[]): void {
    for (const message of messages) this.reconcileSubmittedPromptText(userMessageText(message));
  }

  private async promote(webSession: WebSession): Promise<SessionHandle> {
    if (this.handle) return this.handle;
    if (this.promotePromise) return this.promotePromise;
    const mode: "workspace" | "chat_only" = webSession.cwd ? "workspace" : "chat_only";
    this.promotePromise = (async () => {
      const handle = await this.deps.runner.createSession({
        id: webSession.id,
        cwd: webSession.cwd,
        piSessionFile: webSession.piSessionFile,
        mode,
      });
      if (this.pendingModel) await handle.setModel(this.pendingModel);
      if (this.pendingThinkingLevel) await handle.setThinkingLevel(this.pendingThinkingLevel);
      this.pendingModel = null;
      this.pendingThinkingLevel = null;
      if (webSession.kind === "draft") {
        this.deps.store.setKind(webSession.id, mode);
      }
      this.attachHandle(handle);
      void this.broadcastSettingsUpdate();
      return handle;
    })();
    try {
      return await this.promotePromise;
    } finally {
      this.promotePromise = null;
    }
  }

  private requireHandle(): SessionHandle {
    if (!this.handle) throw new Error("session has not been started yet");
    return this.handle;
  }

  private async ensureHandle(): Promise<SessionHandle> {
    if (this.handle) return this.handle;
    const webSession = this.deps.store.getSession(this.sessionId);
    if (!webSession) throw new Error("session not found");
    return this.promote(webSession);
  }

  add(socket: SocketClient["socket"], requestedClientId?: string): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = undefined;

    const clientId = requestedClientId ?? crypto.randomUUID();
    const previousClient = this.clients.get(clientId);
    if (previousClient) {
      previousClient.bufferedPayloads = [];
      previousClient.socket.close(1000, "client reconnected");
    }
    const client: SocketClient = { clientId, seq: 0, snapshotPending: true, bufferedPayloads: [], socket };
    this.clients.set(clientId, client);
    if (!this.controllerId) this.controllerId = clientId;

    const webSession = this.deps.store.getSession(this.sessionId);
    if (!webSession) {
      socket.close(1008, "session not found");
      return;
    }

    const hello: HelloMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: webSession.id,
      serverVersion: "0.0.0",
      clientId,
    };
    socket.send(JSON.stringify(hello));

    socket.on("message", (...args: never[]) => {
      const [raw] = args as unknown as [Buffer | string];
      void this.handleMessage(client, raw);
    });

    socket.on("close", () => {
      if (this.clients.get(clientId) !== client) return;
      this.clients.delete(clientId);
      client.bufferedPayloads = [];
      if (this.controllerId === clientId) {
        this.controllerId = this.clients.keys().next().value ?? null;
      }
      this.broadcastControllerUpdate();
      if (this.clients.size === 0) this.scheduleDispose();
    });

    void this.snapshotWithWebCommands(webSession).then((snapshot) => {
      if (this.clients.get(clientId) !== client) return;
      this.send(client, { type: "session_snapshot", snapshot: { ...snapshot, controller: this.controllerFor(clientId) } });
      client.snapshotPending = false;
      const buffered = client.bufferedPayloads;
      client.bufferedPayloads = [];
      for (const payload of buffered) this.send(client, payload);
      this.broadcastControllerUpdate();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.unsubscribe();
    this.unsubscribeQuestion();
    for (const client of this.clients.values()) client.socket.close(1001, "session disposed");
    this.clients.clear();
    await this.deps.runner.disposeSession(this.sessionId);
  }

  private controllerFor(currentClientId: string): ControllerInfo {
    return {
      clientId: this.controllerId,
      connectedClients: this.clients.size,
      currentClientId,
      isController: this.controllerId === currentClientId,
    };
  }

  getBroadcastMetrics(): BroadcastMetricsSnapshot {
    return { ...this.broadcastMetrics };
  }

  private send(client: SocketClient, payload: ServerMessage): number {
    const data = JSON.stringify(envelope(client.seq++, payload));
    client.socket.send(data);
    return Buffer.byteLength(data, "utf8");
  }

  private sendOrBuffer(client: SocketClient, payload: ServerMessage): { sentBytes: number; payloadBytes: number; buffered: boolean } {
    if (client.snapshotPending) {
      client.bufferedPayloads.push(payload);
      return { sentBytes: 0, payloadBytes: 0, buffered: true };
    }
    const payloadBytes = this.send(client, payload);
    return { sentBytes: payloadBytes, payloadBytes, buffered: false };
  }

  private rememberActiveToolExecution(event: NormalizedAgentEvent): void {
    if (event.type === "tool_execution_end") {
      const toolCallId = activeToolCallId(event.data);
      if (toolCallId) this.activeToolExecutions.delete(toolCallId);
      return;
    }
    const snapshot = activeToolSnapshotFromEvent(event, activeToolCallId(event.data) ? this.activeToolExecutions.get(activeToolCallId(event.data)!) : undefined);
    if (snapshot) this.activeToolExecutions.set(snapshot.toolCallId, snapshot);
  }

  private grantControl(requesterId: string): void {
    if (!this.clients.has(requesterId)) return;
    this.controllerId = requesterId;
    this.broadcastControllerUpdate();
  }

  private broadcast(payload: ServerMessage): void {
    const startedAt = performance.now();
    let sentMessages = 0;
    let bufferedMessages = 0;
    let sentBytes = 0;
    let maxPayloadBytes = 0;
    let maxBufferedPayloads = 0;
    for (const client of this.clients.values()) {
      const result = this.sendOrBuffer(client, payload);
      if (result.buffered) bufferedMessages += 1;
      else sentMessages += 1;
      sentBytes += result.sentBytes;
      maxPayloadBytes = Math.max(maxPayloadBytes, result.payloadBytes);
      maxBufferedPayloads = Math.max(maxBufferedPayloads, client.bufferedPayloads.length);
    }
    this.recordBroadcastMetrics(payload.type, { clientCount: this.clients.size, sentMessages, bufferedMessages, sentBytes, maxPayloadBytes, maxBufferedPayloads, elapsedMs: performance.now() - startedAt });
  }

  private recordBroadcastMetrics(payloadType: ServerMessage["type"], sample: { clientCount: number; sentMessages: number; bufferedMessages: number; sentBytes: number; maxPayloadBytes: number; maxBufferedPayloads: number; elapsedMs: number }): void {
    this.broadcastMetrics.broadcasts += 1;
    this.broadcastMetrics.sentMessages += sample.sentMessages;
    this.broadcastMetrics.bufferedMessages += sample.bufferedMessages;
    this.broadcastMetrics.sentBytes += sample.sentBytes;
    this.broadcastMetrics.maxPayloadBytes = Math.max(this.broadcastMetrics.maxPayloadBytes, sample.maxPayloadBytes);
    this.broadcastMetrics.maxBufferedPayloads = Math.max(this.broadcastMetrics.maxBufferedPayloads, sample.maxBufferedPayloads);
    this.broadcastMetrics.maxClients = Math.max(this.broadcastMetrics.maxClients, sample.clientCount);
    this.broadcastMetrics.slowestBroadcastMs = Math.max(this.broadcastMetrics.slowestBroadcastMs, Math.round(sample.elapsedMs));
    this.broadcastMetrics.lastPayloadType = payloadType;
    if (process.env.PI_WEB_BROADCAST_METRICS === "1" && (sample.bufferedMessages > 0 || sample.maxPayloadBytes > 64_000 || sample.elapsedMs > 25)) {
      console.warn("[session-hub:broadcast]", JSON.stringify({ sessionId: this.sessionId, payloadType, ...sample, elapsedMs: Math.round(sample.elapsedMs) }));
    }
  }

  broadcastMetadataUpdate(session: WebSession): void {
    this.broadcast({ type: "session_metadata_update", session });
  }

  private broadcastControllerUpdate(): void {
    const startedAt = performance.now();
    let sentMessages = 0;
    let bufferedMessages = 0;
    let sentBytes = 0;
    let maxPayloadBytes = 0;
    let maxBufferedPayloads = 0;
    for (const client of this.clients.values()) {
      const result = this.sendOrBuffer(client, { type: "controller_update", controller: this.controllerFor(client.clientId) });
      if (result.buffered) bufferedMessages += 1;
      else sentMessages += 1;
      sentBytes += result.sentBytes;
      maxPayloadBytes = Math.max(maxPayloadBytes, result.payloadBytes);
      maxBufferedPayloads = Math.max(maxBufferedPayloads, client.bufferedPayloads.length);
    }
    this.recordBroadcastMetrics("controller_update", { clientCount: this.clients.size, sentMessages, bufferedMessages, sentBytes, maxPayloadBytes, maxBufferedPayloads, elapsedMs: performance.now() - startedAt });
  }

  private async broadcastSettingsUpdate(): Promise<void> {
    if (!this.handle) return;
    const settings = await this.handle.getSettings();
    this.broadcast({ type: "settings_update", settings });
  }

  private async runBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
    const handle = this.requireHandle();
    const webSession = this.deps.store.getSession(this.sessionId);
    if (!webSession) throw new Error("session not found");
    const snapshot = await handle.snapshot(webSession);
    if (snapshot.status !== "idle") throw new Error("Bash commands are available when the session is idle.");

    const id = `bash:${crypto.randomUUID()}`;
    let chunkCount = 0;
    let outputBytes = 0;
    let maxChunkBytes = 0;
    this.broadcast({
      type: "agent_event",
      event: {
        type: "bash_execution_start",
        time: new Date().toISOString(),
        data: { type: "bash_execution_start", id, command, excludeFromContext: excludeFromContext ?? false },
      },
    });
    try {
      const result = await handle.executeBash(command, (chunk) => {
        const outputOffsetBytes = outputBytes;
        chunkCount += 1;
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        outputBytes += chunkBytes;
        maxChunkBytes = Math.max(maxChunkBytes, chunkBytes);
        this.broadcast({
          type: "agent_event",
          event: {
            type: "bash_execution_update",
            time: new Date().toISOString(),
            data: { type: "bash_execution_update", id, command, outputDelta: chunk, outputOffsetBytes, outputBytes, chunkCount, excludeFromContext: excludeFromContext ?? false },
          },
        });
      }, excludeFromContext === undefined ? undefined : { excludeFromContext });
      this.broadcast({
        type: "agent_event",
        event: {
          type: "bash_execution_end",
          time: new Date().toISOString(),
          data: { type: "bash_execution_end", id, command, result, stream: { chunkCount, outputBytes, maxChunkBytes }, excludeFromContext: excludeFromContext ?? false },
        },
      });
      await this.broadcastSettingsUpdate();
    } catch (error) {
      this.broadcast({
        type: "agent_event",
        event: {
          type: "bash_execution_end",
          time: new Date().toISOString(),
          data: { type: "bash_execution_end", id, command, result: { output: error instanceof Error ? error.message : String(error), cancelled: false, truncated: false }, isError: true, excludeFromContext: excludeFromContext ?? false },
        },
      });
      throw error;
    }
  }

  private async snapshotWithWebCommands(webSession: WebSession): Promise<SessionSnapshot> {
    if (!this.handle) {
      const commandRecords = this.deps.store.listWebCommandResults(webSession.id);
      const submittedPrompts = this.deps.store.listUnreconciledSubmittedPrompts(webSession.id);
      return {
        session: webSession,
        status: "idle",
        messages: mergeSnapshotMessagesWithWebCommands([], commandRecords, submittedPrompts),
        pendingQuestion: null,
      };
    }
    const snapshot = await this.handle.snapshot(webSession);
    this.reconcileSubmittedPromptsFromMessages(snapshot.messages);
    const commandRecords = this.deps.store.listWebCommandResults(webSession.id);
    const submittedPrompts = this.deps.store.listUnreconciledSubmittedPrompts(webSession.id);
    const activeToolExecutions = [...this.activeToolExecutions.values()];
    return {
      ...snapshot,
      messages: mergeSnapshotMessagesWithWebCommands(snapshot.messages, commandRecords, submittedPrompts),
      ...(activeToolExecutions.length > 0 ? { activeToolExecutions } : {}),
    };
  }

  private submitPromptReceipt(kind: "prompt" | "ask", text: string): SubmittedPromptRecord {
    return this.deps.store.addSubmittedPrompt(this.sessionId, { kind, text });
  }

  private markPromptReceiptError(record: SubmittedPromptRecord, error: unknown): void {
    this.deps.store.markSubmittedPromptError(this.sessionId, record.id, error instanceof Error ? error.message : String(error));
  }

  private async promptWithReceipt(handle: SessionHandle, kind: "prompt" | "ask", receiptText: string, promptText: string, images?: ImageContent[]): Promise<void> {
    const receipt = this.submitPromptReceipt(kind, receiptText);
    try {
      await handle.prompt(promptText, images);
    } catch (error) {
      this.markPromptReceiptError(receipt, error);
      throw error;
    }
  }

  private commandServices() {
    return {
      getSessionCwd: () => this.handle?.cwd ?? process.cwd(),
      hasCommand: (name: string) => this.handle ? this.handle.getCommands().some((command) => command.name === name) : false,
      generateSessionDetails: async (options: Parameters<typeof generateAndApplySessionDetails>[2]) => {
        const webSession = this.deps.store.getSession(this.sessionId);
        if (!webSession) throw new Error("session not found");
        return await generateAndApplySessionDetails(webSession, {
          config: this.deps.config,
          store: this.deps.store,
          runner: this.deps.runner,
          getBroadcaster: (sessionId) => sessionId === this.sessionId ? this : undefined,
        }, options);
      },
    };
  }

  private async emitCommandResult(title: string, body: string, isError = false, data?: unknown): Promise<void> {
    const record = this.deps.store.addWebCommandResult(this.sessionId, { title, body, isError, ...(data !== undefined ? { data } : {}) });
    this.broadcast({
      type: "agent_event",
      event: {
        type: "web_command_result",
        time: record.timestamp,
        data: { type: "web_command_result", id: record.id, title: record.title, body: record.body, isError: record.isError, ...(record.data !== undefined ? { data: record.data } : {}) },
      },
    });
    await this.broadcastSettingsUpdate();
  }

  private async runBundledCommandText(text: string, images?: ImageContent[]): Promise<boolean> {
    const parsed = parseSlashCommand(text);
    if (!parsed) return false;
    const result = await runBundledExtensionCommand(parsed.name, parsed.args, this.commandServices());
    if (!result) return false;
    if (result.kind === "launchPrompt") {
      const webSession = this.deps.store.getSession(this.sessionId);
      if (webSession && !webSession.title) {
        const updated = this.deps.store.updateSession(webSession.id, { title: result.title ?? "Workflow", titleSource: "first_prompt" });
        if (updated) this.broadcastMetadataUpdate(updated);
      }
      const handle = await this.ensureHandle();
      await this.promptWithReceipt(handle, "prompt", result.prompt, result.prompt, images);
      await this.broadcastSettingsUpdate();
      return true;
    }
    await this.emitCommandResult(result.title ?? `/${parsed.name}`, result.body ?? "", result.isError ?? false, result.card ? { kind: "extension_card", card: result.card } : result.data);
    return true;
  }

  private async runWebCommandText(text: string, images?: ImageContent[]): Promise<boolean> {
    const parsed = parseSlashCommand(text);
    if (!parsed) return false;
    if (await this.runBundledCommandText(text, images)) return true;

    const handle = await this.ensureHandle();
    const result = await handle.runBuiltinCommand(text);
    if (!result.handled) return false;
    if (result.launchPrompt) {
      const webSession = this.deps.store.getSession(this.sessionId);
      if (webSession && !webSession.title) {
        const updated = this.deps.store.updateSession(webSession.id, { title: result.title ?? "Workflow", titleSource: "first_prompt" });
        if (updated) this.broadcastMetadataUpdate(updated);
      }
      await this.promptWithReceipt(handle, "prompt", result.launchPrompt, result.launchPrompt, images);
      await this.broadcastSettingsUpdate();
      return true;
    }
    await this.emitCommandResult(result.title ?? `/${parsed.name}`, result.body ?? "", result.isError ?? false, result.data);
    return true;
  }

  private async queueCommandUntilIdle(text: string): Promise<void> {
    this.pendingCommands.push(text);
    await this.emitCommandResult("Queued command", `${text.trim()} will run after the active turn finishes.`);
  }

  private async flushPendingCommands(): Promise<void> {
    if (this.flushingPendingCommands || this.pendingCommands.length === 0) return;
    if (!this.handle) return;
    const webSession = this.deps.store.getSession(this.sessionId);
    if (!webSession) return;
    const snapshot = await this.handle.snapshot(webSession);
    if (snapshot.status !== "idle") return;
    this.flushingPendingCommands = true;
    try {
      while (this.pendingCommands.length > 0) {
        const command = this.pendingCommands.shift();
        if (command) await this.runWebCommandText(command);
      }
    } finally {
      this.flushingPendingCommands = false;
    }
  }

  private scheduleDispose(): void {
    if (this.disposeTimer) return;
    this.disposeTimer = setTimeout(() => {
      void (async () => {
        if (this.clients.size > 0) return;
        const webSession = this.deps.store.getSession(this.sessionId);
        const status = webSession && this.handle ? (await this.handle.snapshot(webSession)).status : "idle";
        if (status === "running" && this.deps.config.sessionLifecycle.disconnectedRunningPolicy === "let-finish") {
          this.disposeTimer = undefined;
          return;
        }
        if (status === "running" && this.handle) await this.handle.abort();
        this.deps.removeHub(this.sessionId);
        await this.dispose();
      })();
    }, this.deps.config.sessionLifecycle.disconnectedIdleTimeoutMs);
  }

  private async handleMessage(client: SocketClient, raw: Buffer | string): Promise<void> {
    const text = typeof raw === "string" ? raw : raw.toString();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.send(client, { type: "error", code: "bad_json", message: "Invalid JSON" });
      return;
    }

    const parsed = clientMessageSchema.safeParse(data);
    if (!parsed.success) {
      this.send(client, { type: "error", code: "bad_message", message: "Invalid client message" });
      return;
    }
    if (parsed.data.type === "hello_ack") return;
    if (parsed.data.type === "take_control") {
      this.grantControl(client.clientId);
      return;
    }
    if (this.controllerId !== client.clientId) {
      this.send(client, { type: "error", code: "not_controller", message: "Another browser tab controls this session. Take control to send commands." });
      return;
    }

    try {
      if (parsed.data.type === "bash") {
        this.requireHandle();
        await this.runBashCommand(parsed.data.command, parsed.data.excludeFromContext);
      } else if (parsed.data.type === "command") {
        const handle = await this.ensureHandle();
        const webSession = this.deps.store.getSession(this.sessionId);
        const status = webSession ? (await handle.snapshot(webSession)).status : "idle";
        if (status === "idle") await this.runWebCommandText(parsed.data.text);
        else await this.queueCommandUntilIdle(parsed.data.text);
      } else if (parsed.data.type === "ask") {
        const handle = await this.ensureHandle();
        const webSession = this.deps.store.getSession(this.sessionId);
        if (webSession && !webSession.title) {
          const title = firstPromptTitle(parsed.data.text);
          if (title) {
            const updated = this.deps.store.updateSession(webSession.id, { title, titleSource: "first_prompt" });
            if (updated) this.broadcastMetadataUpdate(updated);
          }
        }
        await this.promptWithReceipt(handle, "ask", parsed.data.text, askPrompt(parsed.data.text), parsed.data.images?.map(dataUrlToImageContent));
        await this.broadcastSettingsUpdate();
      } else if (parsed.data.type === "prompt") {
        const nameCommand = parseNameCommand(parsed.data.text);
        if (nameCommand.matched) {
          const webSession = this.deps.store.getSession(this.sessionId);
          if (!webSession) throw new Error("session not found");
          let body: string;
          if (nameCommand.clear) {
            const updated = this.deps.store.updateSession(webSession.id, { title: null, titleSource: "unset" });
            if (updated) this.broadcastMetadataUpdate(updated);
            body = "Session title cleared. Click ✨ to generate a new title/summary suggestion when enough context is available.";
          } else if (nameCommand.title) {
            this.handle?.setSessionName(nameCommand.title);
            const updated = this.deps.store.updateSession(webSession.id, { title: nameCommand.title, titleSource: "manual" });
            if (updated) this.broadcastMetadataUpdate(updated);
            body = `Session title set to: ${nameCommand.title}`;
          } else {
            body = `Current title: ${webSession.title ?? "(unset)"}\nSource: ${webSession.titleSource}\nUsage: /name <title> or /name --clear`;
          }
          await this.emitCommandResult("/name", body);
          return;
        }
        const handle = await this.ensureHandle();
        if (await this.runBundledCommandText(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent))) return;
        const builtinResult = await handle.runBuiltinCommand(parsed.data.text);
        if (builtinResult.handled) {
          if (builtinResult.launchPrompt) {
            const webSession = this.deps.store.getSession(this.sessionId);
            if (webSession && !webSession.title) {
              const updated = this.deps.store.updateSession(webSession.id, { title: builtinResult.title ?? "Workflow", titleSource: "first_prompt" });
              if (updated) this.broadcastMetadataUpdate(updated);
            }
            await this.promptWithReceipt(handle, "prompt", builtinResult.launchPrompt, builtinResult.launchPrompt, parsed.data.images?.map(dataUrlToImageContent));
            await this.broadcastSettingsUpdate();
            return;
          }
          await this.emitCommandResult(builtinResult.title ?? "Slash command", builtinResult.body ?? "", builtinResult.isError ?? false, builtinResult.data);
          return;
        }
        const webSession = this.deps.store.getSession(this.sessionId);
        if (webSession && !webSession.title) {
          const title = firstPromptTitle(parsed.data.text);
          if (title) {
            const updated = this.deps.store.updateSession(webSession.id, { title, titleSource: "first_prompt" });
            if (updated) this.broadcastMetadataUpdate(updated);
          }
        }
        await this.promptWithReceipt(handle, "prompt", parsed.data.text, parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
        await this.broadcastSettingsUpdate();
      } else if (parsed.data.type === "steer") await this.requireHandle().steer(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
      else if (parsed.data.type === "follow_up") await this.requireHandle().followUp(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
      else if (parsed.data.type === "cancel_queued_message") {
        const queued = await this.requireHandle().cancelQueuedMessage(parsed.data.queue, parsed.data.index, parsed.data.text);
        this.broadcast({
          type: "agent_event",
          event: {
            type: "queue_update",
            time: new Date().toISOString(),
            data: { type: "queue_update", ...queued },
          },
        });
      } else if (parsed.data.type === "answer_question") {
        const payload = parsed.data.payload;
        const handle = this.requireHandle();
        if (payload.answer && !payload.cancelled && handle.isCheckpointQuestion(payload.questionId)) {
          await this.promptWithReceipt(handle, "prompt", payload.answer.trim(), payload.answer.trim(), []);
        } else {
          handle.answerQuestion(payload);
        }
      }
      else if (parsed.data.type === "abort") await this.requireHandle().abort();
      else if (parsed.data.type === "set_model") {
        if (!this.handle) {
          if (this.deps.config.modelPolicy.allowedModels && !this.deps.config.modelPolicy.allowedModels.includes(parsed.data.model)) throw new Error(`Model not allowed: ${parsed.data.model}`);
          this.pendingModel = parsed.data.model;
        } else {
          await this.handle.setModel(parsed.data.model);
          await this.broadcastSettingsUpdate();
        }
      } else if (parsed.data.type === "set_thinking") {
        if (!this.handle) {
          if (!this.deps.config.modelPolicy.allowedThinkingLevels.includes(parsed.data.level)) throw new Error(`Thinking level not allowed: ${parsed.data.level}`);
          this.pendingThinkingLevel = parsed.data.level;
        } else {
          await this.handle.setThinkingLevel(parsed.data.level);
          await this.broadcastSettingsUpdate();
        }
      }
    } catch (error) {
      this.send(client, { type: "error", code: "agent_error", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function createSessionHubRegistry(deps: Omit<SessionHubDeps, "removeHub">): SessionHubRegistry {
  const sessionHubs = new Map<string, SessionHub>();
  const hubDeps: SessionHubDeps = {
    ...deps,
    removeHub: (sessionId) => {
      sessionHubs.delete(sessionId);
    },
  };

  return {
    getBroadcaster: (sessionId) => sessionHubs.get(sessionId),
    disposeHub: async (sessionId) => {
      const hub = sessionHubs.get(sessionId);
      if (!hub) return false;
      sessionHubs.delete(sessionId);
      await hub.dispose();
      return true;
    },
    disposeAll: async () => {
      for (const [id, hub] of sessionHubs) {
        sessionHubs.delete(id);
        await hub.dispose();
      }
    },
    registerRoutes: (app) => {
      app.get<{ Params: { id: string } }>("/api/sessions/:id/ws", { websocket: true }, async (socket, request) => {
        const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
        if (!isBrowserOriginAllowed({
          origin,
          requestHost: request.headers.host,
          authRequired: deps.config.authRequired,
          allowedOrigins: deps.config.allowedOrigins,
        })) {
          socket.close(1008, "browser origin is not allowed");
          return;
        }
        const existingSession = deps.store.getSession(request.params.id);
        if (!existingSession) {
          socket.close(1008, "session not found");
          return;
        }
        deps.store.touchSession(existingSession.id);
        const webSession = deps.store.getSession(existingSession.id) ?? existingSession;

        let hub = sessionHubs.get(webSession.id);
        if (!hub) {
          try {
            // Drafts spawn lazily on first prompt. Existing workspace/chat-only sessions spawn eagerly on connect.
            if (webSession.kind === "draft") {
              hub = new SessionHub(webSession.id, null, hubDeps);
            } else {
              const handle = await deps.runner.createSession({
                id: webSession.id,
                cwd: webSession.cwd,
                piSessionFile: webSession.piSessionFile,
                mode: webSession.kind === "chat_only" ? "chat_only" : "workspace",
              });
              hub = new SessionHub(webSession.id, handle, hubDeps);
            }
            sessionHubs.set(webSession.id, hub);
          } catch (error) {
            socket.close(1011, error instanceof Error ? error.message : String(error));
            return;
          }
        }

        const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
        hub.add(socket, url.searchParams.get("clientId") ?? undefined);
      });
    },
  };
}
