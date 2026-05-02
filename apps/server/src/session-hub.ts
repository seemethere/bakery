import type { FastifyInstance } from "fastify";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  type ControllerInfo,
  type HelloMessage,
  type ServerEnvelope,
  type ServerMessage,
  type WebSession,
} from "@pi-web-agent/protocol";
import type { ServerConfig } from "./config.js";
import { parseSlashCommand, runBundledExtensionCommand } from "./extensions.js";
import { cleanMetadataText, firstPromptTitle, generateAndApplySessionDetails } from "./metadata-routes.js";
import type { MetadataStore } from "./metadata-store.js";
import type { ImageContent, PiSessionRunner, SessionHandle } from "./pi-runner.js";

function envelope(seq: number, payload: ServerMessage): ServerEnvelope {
  return { seq, time: new Date().toISOString(), payload };
}

export function dataUrlToImageContent(value: string): ImageContent {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) throw new Error("Images must be png, jpeg, gif, or webp data URLs");
  return { type: "image", mimeType: match[1]!.toLowerCase(), data: match[2]!.replace(/\s/g, "") };
}

export function parseNameCommand(text: string): { matched: boolean; clear?: boolean; title?: string } {
  const trimmed = text.trim();
  if (!/^\/name(?:\s|$)/.test(trimmed)) return { matched: false };
  const args = trimmed.replace(/^\/name(?:\s+)?/, "").trim();
  if (args === "--clear") return { matched: true, clear: true };
  if (!args) return { matched: true };
  return { matched: true, title: cleanMetadataText(args, 120) };
}

type SocketClient = {
  clientId: string;
  seq: number;
  socket: { send(data: string): void; close(code?: number, reason?: string): void; on(event: string, listener: (...args: never[]) => void): void };
};

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

class SessionHub {
  private readonly clients = new Map<string, SocketClient>();
  private controllerId: string | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingCommands: string[] = [];
  private flushingPendingCommands = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeQuestion: () => void;

  constructor(private readonly handle: SessionHandle, private readonly deps: SessionHubDeps) {
    this.unsubscribe = handle.subscribe((event, raw) => {
      this.broadcast({ type: "agent_event", event, raw });
      if (event.type === "agent_end" || event.type === "turn_end") {
        void this.broadcastSettingsUpdate();
        void this.flushPendingCommands();
      }
      const webSession = deps.store.getSession(handle.id);
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

  add(socket: SocketClient["socket"], requestedClientId?: string): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = undefined;

    const clientId = requestedClientId && !this.clients.has(requestedClientId) ? requestedClientId : crypto.randomUUID();
    const client: SocketClient = { clientId, seq: 0, socket };
    this.clients.set(clientId, client);
    if (!this.controllerId) this.controllerId = clientId;

    const webSession = this.deps.store.getSession(this.handle.id);
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
    void this.handle.snapshot(webSession).then((snapshot) => {
      this.send(client, { type: "session_snapshot", snapshot: { ...snapshot, controller: this.controllerFor(clientId) } });
      this.broadcastControllerUpdate();
    });

    socket.on("message", (...args: never[]) => {
      const [raw] = args as unknown as [Buffer | string];
      void this.handleMessage(client, raw);
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      if (this.controllerId === clientId) {
        this.controllerId = this.clients.keys().next().value ?? null;
      }
      this.broadcastControllerUpdate();
      if (this.clients.size === 0) this.scheduleDispose();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.unsubscribe();
    this.unsubscribeQuestion();
    for (const client of this.clients.values()) client.socket.close(1001, "session disposed");
    this.clients.clear();
    await this.deps.runner.disposeSession(this.handle.id);
  }

  private controllerFor(currentClientId: string): ControllerInfo {
    return {
      clientId: this.controllerId,
      connectedClients: this.clients.size,
      currentClientId,
      isController: this.controllerId === currentClientId,
    };
  }

  private send(client: SocketClient, payload: ServerMessage): void {
    client.socket.send(JSON.stringify(envelope(client.seq++, payload)));
  }

  private grantControl(requesterId: string): void {
    if (!this.clients.has(requesterId)) return;
    this.controllerId = requesterId;
    this.broadcastControllerUpdate();
  }

  private broadcast(payload: ServerMessage): void {
    for (const client of this.clients.values()) this.send(client, payload);
  }

  broadcastMetadataUpdate(session: WebSession): void {
    this.broadcast({ type: "session_metadata_update", session });
  }

  private broadcastControllerUpdate(): void {
    for (const client of this.clients.values()) this.send(client, { type: "controller_update", controller: this.controllerFor(client.clientId) });
  }

  private async broadcastSettingsUpdate(): Promise<void> {
    const settings = await this.handle.getSettings();
    this.broadcast({ type: "settings_update", settings });
  }

  private async runBashCommand(command: string, excludeFromContext?: boolean): Promise<void> {
    const webSession = this.deps.store.getSession(this.handle.id);
    if (!webSession) throw new Error("session not found");
    const snapshot = await this.handle.snapshot(webSession);
    if (snapshot.status !== "idle") throw new Error("Bash commands are available when the session is idle.");

    const id = `bash:${crypto.randomUUID()}`;
    let output = "";
    this.broadcast({
      type: "agent_event",
      event: {
        type: "bash_execution_start",
        time: new Date().toISOString(),
        data: { type: "bash_execution_start", id, command, excludeFromContext: excludeFromContext ?? false },
      },
    });
    try {
      const result = await this.handle.executeBash(command, (chunk) => {
        output += chunk;
        this.broadcast({
          type: "agent_event",
          event: {
            type: "bash_execution_update",
            time: new Date().toISOString(),
            data: { type: "bash_execution_update", id, command, output, excludeFromContext: excludeFromContext ?? false },
          },
        });
      }, excludeFromContext === undefined ? undefined : { excludeFromContext });
      this.broadcast({
        type: "agent_event",
        event: {
          type: "bash_execution_end",
          time: new Date().toISOString(),
          data: { type: "bash_execution_end", id, command, result, excludeFromContext: excludeFromContext ?? false },
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

  private commandServices() {
    return {
      generateSessionDetails: async (options: Parameters<typeof generateAndApplySessionDetails>[2]) => {
        const webSession = this.deps.store.getSession(this.handle.id);
        if (!webSession) throw new Error("session not found");
        return await generateAndApplySessionDetails(webSession, {
          config: this.deps.config,
          store: this.deps.store,
          runner: this.deps.runner,
          getBroadcaster: (sessionId) => sessionId === this.handle.id ? this : undefined,
        }, options);
      },
    };
  }

  private async emitCommandResult(title: string, body: string, isError = false, data?: unknown): Promise<void> {
    this.broadcast({
      type: "agent_event",
      event: {
        type: "web_command_result",
        time: new Date().toISOString(),
        data: { type: "web_command_result", id: `command:${Date.now()}`, title, body, isError, ...(data !== undefined ? { data } : {}) },
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
      const webSession = this.deps.store.getSession(this.handle.id);
      if (webSession && !webSession.title) {
        const updated = this.deps.store.updateSession(webSession.id, { title: result.title ?? "Workflow", titleSource: "first_prompt" });
        if (updated) this.broadcastMetadataUpdate(updated);
      }
      await this.handle.prompt(result.prompt, images);
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
    const webSession = this.deps.store.getSession(this.handle.id);
    if (!webSession) return;
    const snapshot = await this.handle.snapshot(webSession);
    if (snapshot.status !== "idle") return;
    this.flushingPendingCommands = true;
    try {
      while (this.pendingCommands.length > 0) {
        const command = this.pendingCommands.shift();
        if (command) await this.runBundledCommandText(command);
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
        const webSession = this.deps.store.getSession(this.handle.id);
        const status = webSession ? (await this.handle.snapshot(webSession)).status : "idle";
        if (status === "running" && this.deps.config.sessionLifecycle.disconnectedRunningPolicy === "let-finish") {
          this.disposeTimer = undefined;
          return;
        }
        if (status === "running") await this.handle.abort();
        this.deps.removeHub(this.handle.id);
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
        await this.runBashCommand(parsed.data.command, parsed.data.excludeFromContext);
      } else if (parsed.data.type === "command") {
        const webSession = this.deps.store.getSession(this.handle.id);
        const status = webSession ? (await this.handle.snapshot(webSession)).status : "idle";
        if (status === "idle") await this.runBundledCommandText(parsed.data.text);
        else await this.queueCommandUntilIdle(parsed.data.text);
      } else if (parsed.data.type === "prompt") {
        const nameCommand = parseNameCommand(parsed.data.text);
        if (nameCommand.matched) {
          const webSession = this.deps.store.getSession(this.handle.id);
          if (!webSession) throw new Error("session not found");
          let body: string;
          if (nameCommand.clear) {
            const updated = this.deps.store.updateSession(webSession.id, { title: null, titleSource: "unset" });
            if (updated) this.broadcastMetadataUpdate(updated);
            body = "Session title cleared. Click ✨ to generate a new title/summary suggestion when enough context is available.";
          } else if (nameCommand.title) {
            this.handle.setSessionName(nameCommand.title);
            const updated = this.deps.store.updateSession(webSession.id, { title: nameCommand.title, titleSource: "manual" });
            if (updated) this.broadcastMetadataUpdate(updated);
            body = `Session title set to: ${nameCommand.title}`;
          } else {
            body = `Current title: ${webSession.title ?? "(unset)"}\nSource: ${webSession.titleSource}\nUsage: /name <title> or /name --clear`;
          }
          this.broadcast({
            type: "agent_event",
            event: {
              type: "web_command_result",
              time: new Date().toISOString(),
              data: { type: "web_command_result", id: `command:${Date.now()}`, title: "/name", body },
            },
          });
          return;
        }
        if (await this.runBundledCommandText(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent))) return;
        const builtinResult = await this.handle.runBuiltinCommand(parsed.data.text);
        if (builtinResult.handled) {
          if (builtinResult.launchPrompt) {
            const webSession = this.deps.store.getSession(this.handle.id);
            if (webSession && !webSession.title) {
              const updated = this.deps.store.updateSession(webSession.id, { title: builtinResult.title ?? "Workflow", titleSource: "first_prompt" });
              if (updated) this.broadcastMetadataUpdate(updated);
            }
            await this.handle.prompt(builtinResult.launchPrompt, parsed.data.images?.map(dataUrlToImageContent));
            await this.broadcastSettingsUpdate();
            return;
          }
          this.broadcast({
            type: "agent_event",
            event: {
              type: "web_command_result",
              time: new Date().toISOString(),
              data: {
                type: "web_command_result",
                id: `command:${Date.now()}`,
                title: builtinResult.title ?? "Slash command",
                body: builtinResult.body ?? "",
                isError: builtinResult.isError ?? false,
              },
            },
          });
          await this.broadcastSettingsUpdate();
          return;
        }
        const webSession = this.deps.store.getSession(this.handle.id);
        if (webSession && !webSession.title) {
          const title = firstPromptTitle(parsed.data.text);
          if (title) {
            const updated = this.deps.store.updateSession(webSession.id, { title, titleSource: "first_prompt" });
            if (updated) this.broadcastMetadataUpdate(updated);
          }
        }
        await this.handle.prompt(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
        await this.broadcastSettingsUpdate();
      } else if (parsed.data.type === "steer") await this.handle.steer(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
      else if (parsed.data.type === "follow_up") await this.handle.followUp(parsed.data.text, parsed.data.images?.map(dataUrlToImageContent));
      else if (parsed.data.type === "cancel_queued_message") {
        const queued = await this.handle.cancelQueuedMessage(parsed.data.queue, parsed.data.index, parsed.data.text);
        this.broadcast({
          type: "agent_event",
          event: {
            type: "queue_update",
            time: new Date().toISOString(),
            data: { type: "queue_update", ...queued },
          },
        });
      } else if (parsed.data.type === "answer_question") this.handle.answerQuestion(parsed.data.payload);
      else if (parsed.data.type === "abort") await this.handle.abort();
      else if (parsed.data.type === "set_model") {
        await this.handle.setModel(parsed.data.model);
        await this.broadcastSettingsUpdate();
      } else if (parsed.data.type === "set_thinking") {
        await this.handle.setThinkingLevel(parsed.data.level);
        await this.broadcastSettingsUpdate();
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
            const handle = await deps.runner.createSession({
              id: webSession.id,
              cwd: webSession.cwd,
              piSessionFile: webSession.piSessionFile,
            });
            hub = new SessionHub(handle, hubDeps);
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
