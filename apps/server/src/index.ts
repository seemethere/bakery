import { mkdirSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  commandQuerySchema,
  createSessionRequestSchema,
  fileCompleteQuerySchema,
  fileRawQuerySchema,
  fileSearchQuerySchema,
  forkSessionRequestSchema,
  navigateTreeRequestSchema,
  updateSessionRequestSchema,
  type ControllerInfo,
  type HelloMessage,
  type ServerEnvelope,
  type ServerMessage,
  type SessionTreeNode,
  type WebSession,
} from "@pi-web-agent/protocol";
import { SessionManager, type SessionEntry } from "@mariozechner/pi-coding-agent";
import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { MetadataStore } from "./metadata-store.js";
import { completeFiles, searchFiles } from "./file-search.js";
import { FakePiSessionRunner } from "./fake-runner.js";
import { InProcessPiSessionRunner, type ImageContent } from "./pi-runner.js";
import { assertAllowedCwd, resolveWorkspaceRoots, toWorkspaces } from "./workspaces.js";

const config = loadConfig();
const workspaceRoots = await resolveWorkspaceRoots(config.workspaceRoots);
mkdirSync(config.sessionDir, { recursive: true });

const store = new MetadataStore(config.metadataDbPath);
const runner = config.fakeAgent ? new FakePiSessionRunner(config.modelPolicy) : new InProcessPiSessionRunner(config.modelPolicy);
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
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

type PiSessionTreeNode = ReturnType<SessionManager["getTree"]>[number];

function flattenTree(nodes: PiSessionTreeNode[]): PiSessionTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")
    .filter(Boolean)
    .join(" ");
}

async function enrichSession(session: WebSession): Promise<WebSession> {
  const handle = runner.getSession(session.id);
  let status: WebSession["status"] | undefined;
  if (handle) status = (await handle.snapshot(session)).status;

  try {
    const manager = handle?.session.sessionManager ?? SessionManager.open(session.piSessionFile, config.sessionDir, session.cwd);
    const entries = flattenTree(manager.getTree())
      .map((node) => node.entry)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const last = entries.at(-1);
    const lastUser = [...entries].reverse().find((entry: SessionEntry) => {
      if (entry.type !== "message") return false;
      const message = entry.message as { role?: string };
      return message.role === "user";
    });
    const lastUserPrompt = lastUser?.type === "message" ? messageText((lastUser.message as { content?: unknown }).content).replace(/\s+/g, " ").trim().slice(0, 160) : undefined;
    return {
      ...session,
      lastActivityAt: last?.timestamp ?? session.lastOpenedAt,
      lastUserPrompt: lastUserPrompt || undefined,
      status: status ?? "idle",
    };
  } catch {
    return { ...session, lastActivityAt: session.lastOpenedAt, status: status ?? "idle" };
  }
}

app.get("/api/sessions", async () => Promise.all(store.listSessions().map(enrichSession)));

function entryTitle(entry: SessionEntry): { title: string; role?: string } {
  if (entry.type === "message") {
    const message = entry.message as { role?: string; content?: unknown };
    const role = String(message.role ?? "message");
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : "").join(" ")
        : "";
    return { role, title: `${role}: ${text.replace(/\s+/g, " ").trim().slice(0, 80) || "(empty)"}` };
  }
  if (entry.type === "compaction") return { title: `compaction: ${entry.summary.slice(0, 80)}` };
  if (entry.type === "branch_summary") return { title: `branch summary: ${entry.summary.slice(0, 80)}` };
  if (entry.type === "model_change") return { title: `model: ${entry.provider}/${entry.modelId}` };
  if (entry.type === "thinking_level_change") return { title: `thinking: ${entry.thinkingLevel}` };
  if (entry.type === "session_info") return { title: `name: ${entry.name ?? "unnamed"}` };
  if (entry.type === "label") return { title: `label: ${entry.label ?? "cleared"}` };
  return { title: entry.type };
}

function mapTreeNode(node: PiSessionTreeNode, leafId: string | null): SessionTreeNode {
  const formatted = entryTitle(node.entry);
  return {
    id: node.entry.id,
    parentId: node.entry.parentId,
    type: node.entry.type,
    timestamp: node.entry.timestamp,
    role: formatted.role,
    title: node.label ? `${formatted.title} · ${node.label}` : formatted.title,
    label: node.label,
    current: node.entry.id === leafId,
    children: node.children.map((child) => mapTreeNode(child, leafId)),
  };
}

async function createForkFile(sourceFile: string, cwd: string, entryId: string): Promise<string> {
  const manager = SessionManager.open(sourceFile, config.sessionDir, cwd);
  const branch = manager.getBranch(entryId);
  if (branch.length === 0) throw new Error(`Entry not found: ${entryId}`);
  const timestamp = new Date().toISOString();
  const piSessionId = crypto.randomUUID();
  const targetFile = resolve(config.sessionDir, `${piSessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: piSessionId,
    timestamp,
    cwd,
    parentSession: sourceFile,
  };
  const lines = [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(targetFile, lines, "utf8");
  return targetFile;
}

app.post("/api/sessions", async (request, reply) => {
  const parsed = createSessionRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  try {
    const cwd = await assertAllowedCwd(parsed.data.cwd, workspaceRoots);
    const id = crypto.randomUUID();
    const piSessionFile = resolve(config.sessionDir, `${id}.jsonl`);
    const session = store.createSession({ id, cwd, piSessionFile, title: parsed.data.title ?? null });
    return reply.code(201).send(session);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  store.touchSession(session.id);
  return session;
});

app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const parsed = updateSessionRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const existing = store.getSession(request.params.id);
  if (!existing) return reply.code(404).send({ error: "session not found" });

  if (Object.hasOwn(parsed.data, "title")) store.updateSession(existing.id, { title: parsed.data.title ?? null });
  store.updatePreferences(existing.id, {
    ...(parsed.data.toolPermissionMode ? { toolPermissionMode: parsed.data.toolPermissionMode } : {}),
    ...(parsed.data.uiStateJson ? { uiStateJson: parsed.data.uiStateJson } : {}),
  });
  return store.getSession(existing.id);
});

app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  if (!store.deleteSession(request.params.id)) return reply.code(404).send({ error: "session not found" });
  const hub = sessionHubs.get(request.params.id);
  if (hub) {
    sessionHubs.delete(request.params.id);
    await hub.dispose();
  } else {
    await runner.disposeSession(request.params.id);
  }
  return reply.code(204).send();
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/tree", async (request, reply) => {
  const webSession = store.getSession(request.params.id);
  if (!webSession) return reply.code(404).send({ error: "session not found" });
  try {
    const handle = runner.getSession(webSession.id);
    const manager = handle?.session.sessionManager ?? SessionManager.open(webSession.piSessionFile, config.sessionDir, webSession.cwd);
    const leafId = manager.getLeafId();
    return { sessionId: webSession.id, leafId, tree: manager.getTree().map((node) => mapTreeNode(node, leafId)) };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/tree/navigate", async (request, reply) => {
  const parsed = navigateTreeRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const webSession = store.getSession(request.params.id);
  if (!webSession) return reply.code(404).send({ error: "session not found" });
  try {
    const handle = await runner.createSession({
      id: webSession.id,
      cwd: webSession.cwd,
      piSessionFile: webSession.piSessionFile,
    });
    if (handle.session.isStreaming) return reply.code(409).send({ error: "cannot navigate while agent is running" });
    const result = await handle.session.navigateTree(parsed.data.entryId, { summarize: parsed.data.summarize });
    if (result.cancelled) return reply.code(409).send({ error: "navigation cancelled" });
    const snapshot = await handle.snapshot(webSession);
    return { snapshot, editorText: result.editorText };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/fork", async (request, reply) => {
  const parsed = forkSessionRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const source = store.getSession(request.params.id);
  if (!source) return reply.code(404).send({ error: "session not found" });
  try {
    const id = crypto.randomUUID();
    const piSessionFile = await createForkFile(source.piSessionFile, source.cwd, parsed.data.entryId);
    const title = parsed.data.title ?? `Fork of ${source.title ?? source.cwd}`;
    const session = store.createSession({ id, cwd: source.cwd, piSessionFile, title });
    return reply.code(201).send(session);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string | number } }>("/api/sessions/:id/commands", async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const parsed = commandQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  try {
    const handle = await runner.createSession({
      id: session.id,
      cwd: session.cwd,
      piSessionFile: session.piSessionFile,
    });
    const query = parsed.data.q.toLowerCase();
    const commands = handle.getCommands()
      .filter((command) => !query || command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query))
      .sort((a, b) => {
        const aStarts = query && a.name.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = query && b.name.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, parsed.data.limit);
    return { query: parsed.data.q, commands };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string | number } }>("/api/sessions/:id/files/search", async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const parsed = fileSearchQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const files = await searchFiles(session.cwd, parsed.data.q, parsed.data.limit);
  return { query: parsed.data.q, files };
});

app.get<{ Params: { id: string }; Querystring: { prefix?: string; limit?: string | number } }>("/api/sessions/:id/files/complete", async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const parsed = fileCompleteQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const files = await completeFiles(session.cwd, parsed.data.prefix, parsed.data.limit);
  return { prefix: parsed.data.prefix, files };
});

const imageMimeTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

async function resolveSessionFile(cwd: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0")) throw new Error("invalid path");
  const cwdReal = await realpath(cwd);
  const candidate = await realpath(resolve(cwdReal, relativePath));
  const rel = relative(cwdReal, candidate);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || resolve(rel) === rel) throw new Error("path is outside session workspace");
  return candidate;
}

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files/raw", async (request, reply) => {
  const session = store.getSession(request.params.id);
  if (!session) return reply.code(404).send({ error: "session not found" });
  const parsed = fileRawQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const mime = imageMimeTypes.get(extensionOf(parsed.data.path));
  if (!mime) return reply.code(415).send({ error: "only image previews are supported" });
  try {
    const file = await resolveSessionFile(session.cwd, parsed.data.path);
    const info = await stat(file);
    if (!info.isFile()) return reply.code(404).send({ error: "file not found" });
    if (info.size > 20 * 1024 * 1024) return reply.code(413).send({ error: "file too large to preview" });
    reply.header("Cache-Control", "private, max-age=30");
    return reply.type(mime).send(await readFile(file));
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

function envelope(seq: number, payload: ServerMessage): ServerEnvelope {
  return { seq, time: new Date().toISOString(), payload };
}

type SocketClient = {
  clientId: string;
  seq: number;
  socket: { send(data: string): void; close(code?: number, reason?: string): void; on(event: string, listener: (...args: never[]) => void): void };
};

class SessionHub {
  private readonly clients = new Map<string, SocketClient>();
  private controllerId: string | null = null;
  private pendingTakeover: { requesterId: string; expiresAt: number } | null = null;
  private takeoverTimer: ReturnType<typeof setTimeout> | undefined;
  private disposeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly handle: Awaited<ReturnType<typeof runner.createSession>>) {
    this.unsubscribe = handle.subscribe((event, raw) => {
      this.broadcast({ type: "agent_event", event, raw });
      if (event.type === "agent_end" || event.type === "turn_end") void this.broadcastSettingsUpdate();
      const webSession = store.getSession(handle.id);
      if (this.clients.size === 0 && webSession) {
        void handle.snapshot(webSession).then((snapshot) => {
          if (snapshot.status === "idle") this.scheduleDispose();
        });
      }
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
      if (this.pendingTakeover?.requesterId === clientId) this.clearPendingTakeover();
      if (this.controllerId === clientId) {
        const pending = this.activePendingTakeover();
        this.controllerId = pending && this.clients.has(pending.requesterId) ? pending.requesterId : this.clients.keys().next().value ?? null;
        this.clearPendingTakeover();
      }
      this.broadcastControllerUpdate();
      if (this.clients.size === 0) this.scheduleDispose();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
    this.unsubscribe();
    for (const client of this.clients.values()) client.socket.close(1001, "session disposed");
    this.clients.clear();
    await runner.disposeSession(this.handle.id);
  }

  private controllerFor(currentClientId: string): ControllerInfo {
    const pending = this.activePendingTakeover();
    const takeoverRequest = pending && (currentClientId === this.controllerId || currentClientId === pending.requesterId)
      ? {
          state: currentClientId === pending.requesterId ? ("requested" as const) : ("incoming" as const),
          requesterClientId: pending.requesterId,
          expiresAt: new Date(pending.expiresAt).toISOString(),
        }
      : undefined;
    return {
      clientId: this.controllerId,
      connectedClients: this.clients.size,
      currentClientId,
      isController: this.controllerId === currentClientId,
      takeoverRequest,
    };
  }

  private send(client: SocketClient, payload: ServerMessage): void {
    client.socket.send(JSON.stringify(envelope(client.seq++, payload)));
  }

  private activePendingTakeover(): { requesterId: string; expiresAt: number } | null {
    if (!this.pendingTakeover) return null;
    if (this.pendingTakeover.expiresAt <= Date.now() || !this.clients.has(this.pendingTakeover.requesterId)) {
      this.clearPendingTakeover();
      return null;
    }
    return this.pendingTakeover;
  }

  private clearPendingTakeover(): void {
    this.pendingTakeover = null;
    if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
    this.takeoverTimer = undefined;
  }

  private grantControl(requesterId: string): void {
    if (!this.clients.has(requesterId)) return;
    this.controllerId = requesterId;
    this.clearPendingTakeover();
    this.broadcastControllerUpdate();
  }

  private broadcast(payload: ServerMessage): void {
    for (const client of this.clients.values()) this.send(client, payload);
  }

  private broadcastControllerUpdate(): void {
    for (const client of this.clients.values()) this.send(client, { type: "controller_update", controller: this.controllerFor(client.clientId) });
  }

  private async broadcastSettingsUpdate(): Promise<void> {
    const settings = await this.handle.getSettings();
    this.broadcast({ type: "settings_update", settings });
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
      if (this.controllerId === client.clientId || !this.controllerId || !this.clients.has(this.controllerId)) {
        this.grantControl(client.clientId);
        return;
      }
      const timeoutMs = Math.max(1, config.controllerTakeoverTimeoutMs);
      const expiresAt = Date.now() + timeoutMs;
      this.pendingTakeover = { requesterId: client.clientId, expiresAt };
      if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
      this.takeoverTimer = setTimeout(() => {
        if (this.pendingTakeover?.requesterId === client.clientId) {
          const requester = this.clients.get(client.clientId);
          if (requester) this.send(requester, { type: "error", code: "control_request_expired", message: "Control request expired." });
          this.clearPendingTakeover();
          this.broadcastControllerUpdate();
        }
      }, timeoutMs);
      this.broadcastControllerUpdate();
      return;
    }
    if (parsed.data.type === "approve_control" || parsed.data.type === "deny_control") {
      if (this.controllerId !== client.clientId) {
        this.send(client, { type: "error", code: "not_controller", message: "Only the current controller can approve control requests." });
        return;
      }
      const pending = this.activePendingTakeover();
      if (!pending || pending.requesterId !== parsed.data.requesterClientId) {
        this.send(client, { type: "error", code: "no_control_request", message: "No matching control request is pending." });
        return;
      }
      if (parsed.data.type === "approve_control") this.grantControl(pending.requesterId);
      else {
        const requester = this.clients.get(pending.requesterId);
        if (requester) this.send(requester, { type: "error", code: "control_request_denied", message: "The current controller denied your control request." });
        this.clearPendingTakeover();
        this.broadcastControllerUpdate();
      }
      return;
    }
    if (this.controllerId !== client.clientId) {
      this.send(client, { type: "error", code: "not_controller", message: "Another browser tab controls this session. Take control to send commands." });
      return;
    }

    try {
      if (parsed.data.type === "prompt") {
        const builtinResult = await this.handle.runBuiltinCommand(parsed.data.text);
        if (builtinResult.handled) {
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
        if (webSession && !webSession.title) store.updateSession(webSession.id, { title: parsed.data.text.slice(0, 60) });
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
      } else if (parsed.data.type === "abort") await this.handle.abort();
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

app.get<{ Params: { id: string } }>("/api/sessions/:id/ws", { websocket: true }, async (socket, request) => {
  const webSession = store.getSession(request.params.id);
  if (!webSession) {
    socket.close(1008, "session not found");
    return;
  }

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
