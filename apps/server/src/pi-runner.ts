import { dirname } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { NormalizedAgentEvent, SessionSnapshot, WebSession } from "@pi-web-agent/protocol";

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
  subscribe(listener: (event: NormalizedAgentEvent, raw: AgentSessionEvent) => void): () => void;
  snapshot(webSession: WebSession): SessionSnapshot;
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

class InProcessSessionHandle implements SessionHandle {
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly sessionFile: string,
    readonly session: AgentSession,
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

  subscribe(listener: (event: NormalizedAgentEvent, raw: AgentSessionEvent) => void): () => void {
    return this.session.subscribe((event) => listener(normalizeEvent(event), event));
  }

  snapshot(webSession: WebSession): SessionSnapshot {
    return {
      session: webSession,
      status: getStatus(this.session),
      messages: this.session.state.messages,
    };
  }

  dispose(): void {
    this.session.dispose();
  }
}

export class InProcessPiSessionRunner implements PiSessionRunner {
  private readonly handles = new Map<string, SessionHandle>();

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    const existing = this.handles.get(options.id);
    if (existing) return existing;

    const sessionManager = SessionManager.open(options.piSessionFile, dirname(options.piSessionFile), options.cwd);
    const { session } = await createAgentSession({ cwd: options.cwd, sessionManager });
    const handle = new InProcessSessionHandle(options.id, options.cwd, options.piSessionFile, session);
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
