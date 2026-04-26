import { dirname } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ModelInfo, ModelPolicy, NormalizedAgentEvent, SessionRuntimeSettings, SessionSnapshot, WebSession } from "@pi-web-agent/protocol";

export type CreateSessionOptions = {
  id: string;
  cwd: string;
  piSessionFile: string;
};

export type SessionHandle = {
  id: string;
  cwd: string;
  sessionFile: string;
  session: AgentSession;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getSettings(): Promise<SessionRuntimeSettings>;
  subscribe(listener: (event: NormalizedAgentEvent, raw: AgentSessionEvent) => void): () => void;
  snapshot(webSession: WebSession): Promise<SessionSnapshot>;
  dispose(): void;
};

export interface PiSessionRunner {
  createSession(options: CreateSessionOptions): Promise<SessionHandle>;
  getSession(id: string): SessionHandle | undefined;
  disposeSession(id: string): Promise<void>;
}

function normalizeEvent(event: AgentSessionEvent): NormalizedAgentEvent {
  return {
    type: event.type,
    time: new Date().toISOString(),
    data: event,
  };
}

function getStatus(session: AgentSession): SessionSnapshot["status"] {
  return session.isStreaming ? "running" : "idle";
}

function toModelInfo(model: { id: string; provider: string; name?: string; reasoning?: boolean } | undefined): ModelInfo | null {
  if (!model) return null;
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    name: model.name ?? model.id,
    reasoning: model.reasoning,
  };
}

class InProcessSessionHandle implements SessionHandle {
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly sessionFile: string,
    readonly session: AgentSession,
    private readonly modelPolicy: ModelPolicy,
  ) {}

  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async setModel(modelId: string): Promise<void> {
    if (this.modelPolicy.allowedModels && !this.modelPolicy.allowedModels.includes(modelId)) throw new Error(`Model not allowed: ${modelId}`);
    const [provider, ...idParts] = modelId.split("/");
    const id = idParts.join("/");
    if (!provider || !id) throw new Error("Model must be formatted as provider/model");
    const models = await this.session.modelRegistry.getAvailable();
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
    if (!model) throw new Error(`Model not available: ${modelId}`);
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.modelPolicy.allowedThinkingLevels.includes(level)) throw new Error(`Thinking level not allowed: ${level}`);
    this.session.setThinkingLevel(level as never);
  }

  async getSettings(): Promise<SessionRuntimeSettings> {
    const availableModels = (await this.session.modelRegistry.getAvailable())
      .map((model) => toModelInfo(model))
      .filter((model): model is ModelInfo => Boolean(model))
      .filter((model) => !this.modelPolicy.allowedModels || this.modelPolicy.allowedModels.includes(model.id));
    const availableThinkingLevels = this.session.getAvailableThinkingLevels().filter((level) => this.modelPolicy.allowedThinkingLevels.includes(level));
    return {
      model: toModelInfo(this.session.model),
      availableModels,
      thinkingLevel: this.session.thinkingLevel,
      availableThinkingLevels,
    };
  }

  subscribe(listener: (event: NormalizedAgentEvent, raw: AgentSessionEvent) => void): () => void {
    return this.session.subscribe((event) => listener(normalizeEvent(event), event));
  }

  async snapshot(webSession: WebSession): Promise<SessionSnapshot> {
    return {
      session: webSession,
      status: getStatus(this.session),
      messages: this.session.state.messages,
      settings: await this.getSettings(),
    };
  }

  dispose(): void {
    this.session.dispose();
  }
}

export class InProcessPiSessionRunner implements PiSessionRunner {
  private readonly handles = new Map<string, SessionHandle>();

  constructor(private readonly modelPolicy: ModelPolicy) {}

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    const existing = this.handles.get(options.id);
    if (existing) return existing;

    const sessionManager = SessionManager.open(options.piSessionFile, dirname(options.piSessionFile), options.cwd);
    const { session } = await createAgentSession({ cwd: options.cwd, sessionManager, thinkingLevel: this.modelPolicy.defaultThinkingLevel as never });
    const handle = new InProcessSessionHandle(options.id, options.cwd, options.piSessionFile, session, this.modelPolicy);
    this.handles.set(options.id, handle);
    return handle;
  }

  getSession(id: string): SessionHandle | undefined {
    return this.handles.get(id);
  }

  async disposeSession(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    handle.dispose();
    this.handles.delete(id);
  }
}
