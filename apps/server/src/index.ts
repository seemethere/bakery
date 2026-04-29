import { mkdirSync } from "node:fs";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  updateAppSettingsRequestSchema,
  type ControllerInfo,
  type HelloMessage,
  type ServerEnvelope,
  type ServerMessage,
  type WebSession,
} from "@pi-web-agent/protocol";
import Fastify from "fastify";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { cleanMetadataText, firstPromptTitle, registerMetadataRoutes } from "./metadata-routes.js";
import { registerSearchRoutes } from "./search-routes.js";
import { registerSessionRoutes } from "./session-routes.js";
import { loadConfig } from "./config.js";
import { MetadataStore } from "./metadata-store.js";
import { FakePiSessionRunner } from "./fake-runner.js";
import { InProcessPiSessionRunner, type ImageContent } from "./pi-runner.js";
import { resolveWorkspaceRoots, toWorkspaces } from "./workspaces.js";

const config = loadConfig();
const workspaceRoots = await resolveWorkspaceRoots(config.workspaceRoots);
mkdirSync(config.sessionDir, { recursive: true });
mkdirSync(config.artifactDir, { recursive: true });
mkdirSync(config.worktreeDir, { recursive: true });

const store = new MetadataStore(config.metadataDbPath);
const runner = config.fakeAgent ? new FakePiSessionRunner(config.modelPolicy) : new InProcessPiSessionRunner(config.modelPolicy);
const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"] });
await app.register(websocket);

function isLocalhost(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function dataUrlToImageContent(value: string): ImageContent {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) throw new Error("Images must be png, jpeg, gif, or webp data URLs");
  return { type: "image", mimeType: match[1]!.toLowerCase(), data: match[2]!.replace(/\s/g, "") };
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/healthz") return;

  if (config.authToken) {
    const header = request.headers.authorization;
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const queryToken = url.searchParams.get("token");
    if (header !== `Bearer ${config.authToken}` && queryToken !== config.authToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return;
  }

  if (!isLocalhost(request.ip)) {
    return reply.code(403).send({ error: "unauthenticated access is only allowed from localhost" });
  }
});

app.get("/healthz", async () => ({ ok: true, time: new Date().toISOString() }));

app.get("/api/config", async () => ({
  host: config.host,
  port: config.port,
  authRequired: config.authRequired,
  workspaceRoots,
  toolPermissionPolicy: config.toolPermissionPolicy,
  modelPolicy: config.modelPolicy,
  resourcePolicy: config.resourcePolicy,
  sessionLifecycle: config.sessionLifecycle,
}));

app.get("/api/workspaces", async () => toWorkspaces(workspaceRoots));

app.get("/api/models", async () => ({
  defaultModel: config.modelPolicy.defaultModel ?? null,
  models: config.modelPolicy.allowedModels ?? [],
  thinking: {
    default: config.modelPolicy.defaultThinkingLevel,
    levels: config.modelPolicy.allowedThinkingLevels,
  },
}));

app.get("/api/settings", async () => store.getSettings());

app.patch("/api/settings", async (request, reply) => {
  const parsed = updateAppSettingsRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return store.updateSettings(parsed.data);
});

registerArtifactRoutes(app, { artifactDir: config.artifactDir, authToken: config.authToken, store });



function envelope(seq: number, payload: ServerMessage): ServerEnvelope {
  return { seq, time: new Date().toISOString(), payload };
}

function parseNameCommand(text: string): { matched: boolean; clear?: boolean; title?: string } {
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

class SessionHub {
  private readonly clients = new Map<string, SocketClient>();
  private controllerId: string | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeQuestion: () => void;

  constructor(private readonly handle: Awaited<ReturnType<typeof runner.createSession>>) {
    this.unsubscribe = handle.subscribe((event, raw) => {
      this.broadcast({ type: "agent_event", event, raw });
      if (event.type === "agent_end" || event.type === "turn_end") {
        void this.broadcastSettingsUpdate();
      }
      const webSession = store.getSession(handle.id);
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

    const webSession = store.getSession(this.handle.id);
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
    await runner.disposeSession(this.handle.id);
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
    const webSession = store.getSession(this.handle.id);
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

  private scheduleDispose(): void {
    if (this.disposeTimer) return;
    this.disposeTimer = setTimeout(() => {
      void (async () => {
        if (this.clients.size > 0) return;
        const webSession = store.getSession(this.handle.id);
        const status = webSession ? (await this.handle.snapshot(webSession)).status : "idle";
        if (status === "running" && config.sessionLifecycle.disconnectedRunningPolicy === "let-finish") {
          this.disposeTimer = undefined;
          return;
        }
        if (status === "running") await this.handle.abort();
        sessionHubs.delete(this.handle.id);
        await this.dispose();
      })();
    }, config.sessionLifecycle.disconnectedIdleTimeoutMs);
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
      } else if (parsed.data.type === "prompt") {
        const nameCommand = parseNameCommand(parsed.data.text);
        if (nameCommand.matched) {
          const webSession = store.getSession(this.handle.id);
          if (!webSession) throw new Error("session not found");
          let body: string;
          if (nameCommand.clear) {
            const updated = store.updateSession(webSession.id, { title: null, titleSource: "unset" });
            if (updated) this.broadcastMetadataUpdate(updated);
            body = "Session title cleared. Click ✨ to generate a new title/summary suggestion when enough context is available.";
          } else if (nameCommand.title) {
            this.handle.setSessionName(nameCommand.title);
            const updated = store.updateSession(webSession.id, { title: nameCommand.title, titleSource: "manual" });
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
        const builtinResult = await this.handle.runBuiltinCommand(parsed.data.text);
        if (builtinResult.handled) {
          if (builtinResult.launchPrompt) {
            const webSession = store.getSession(this.handle.id);
            if (webSession && !webSession.title) {
              const updated = store.updateSession(webSession.id, { title: builtinResult.title ?? "Workflow", titleSource: "first_prompt" });
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
        const webSession = store.getSession(this.handle.id);
        if (webSession && !webSession.title) {
          const title = firstPromptTitle(parsed.data.text);
          if (title) {
            const updated = store.updateSession(webSession.id, { title, titleSource: "first_prompt" });
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

const sessionHubs = new Map<string, SessionHub>();

registerMetadataRoutes(app, {
  config,
  store,
  runner,
  getBroadcaster: (sessionId) => sessionHubs.get(sessionId),
});
registerSearchRoutes(app, { store, runner });
registerSessionRoutes(app, {
  config,
  workspaceRoots,
  store,
  runner,
  disposeHub: async (sessionId) => {
    const hub = sessionHubs.get(sessionId);
    if (!hub) return false;
    sessionHubs.delete(sessionId);
    await hub.dispose();
    return true;
  },
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/ws", { websocket: true }, async (socket, request) => {
  const existingSession = store.getSession(request.params.id);
  if (!existingSession) {
    socket.close(1008, "session not found");
    return;
  }
  store.touchSession(existingSession.id);
  const webSession = store.getSession(existingSession.id) ?? existingSession;

  let hub = sessionHubs.get(webSession.id);
  if (!hub) {
    try {
      const handle = await runner.createSession({
        id: webSession.id,
        cwd: webSession.cwd,
        piSessionFile: webSession.piSessionFile,
      });
      hub = new SessionHub(handle);
      sessionHubs.set(webSession.id, hub);
    } catch (error) {
      socket.close(1011, error instanceof Error ? error.message : String(error));
      return;
    }
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  hub.add(socket, url.searchParams.get("clientId") ?? undefined);
});

const close = async () => {
  app.log.info("shutting down");
  for (const [id, hub] of sessionHubs) {
    sessionHubs.delete(id);
    await hub.dispose();
  }
  for (const session of store.listSessions()) await runner.disposeSession(session.id);
  store.close();
  await app.close();
};
process.on("SIGINT", () => void close().finally(() => process.exit(0)));
process.on("SIGTERM", () => void close().finally(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
