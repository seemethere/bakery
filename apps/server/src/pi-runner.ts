import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { CommandInfo, ModelInfo, ModelPolicy, NormalizedAgentEvent, SessionRuntimeSettings, SessionSnapshot, WebSession } from "@pi-web-agent/protocol";

export type ImageContent = { type: "image"; data: string; mimeType: string };

export type CreateSessionOptions = {
  id: string;
  cwd: string;
  piSessionFile: string;
};

export type BuiltinCommandResult = {
  handled: boolean;
  title?: string;
  body?: string;
  isError?: boolean;
};

export type SessionHandle = {
  id: string;
  cwd: string;
  sessionFile: string;
  session: AgentSession;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getSettings(): Promise<SessionRuntimeSettings>;
  getCommands(): CommandInfo[];
  runBuiltinCommand(text: string): Promise<BuiltinCommandResult>;
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

const piPackageEntry = fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const piChangelogPath = resolve(dirname(piPackageEntry), "../CHANGELOG.md");

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "settings", description: "Open settings menu", source: "builtin", unsupported: true },
  { name: "model", description: "Select model (use the web Model selector instead)", source: "builtin", unsupported: true },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", source: "builtin", unsupported: true },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", source: "builtin" },
  { name: "import", description: "Import and resume a session from a JSONL file", source: "builtin", unsupported: true },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Show last agent message text", source: "builtin" },
  { name: "name", description: "Set session display name", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin", unsupported: true },
  { name: "fork", description: "Create a new fork from a previous user message", source: "builtin", unsupported: true },
  { name: "clone", description: "Duplicate the current session at the current position", source: "builtin", unsupported: true },
  { name: "tree", description: "Open the web session tree", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin", unsupported: true },
  { name: "logout", description: "Remove provider authentication", source: "builtin", unsupported: true },
  { name: "new", description: "Start a new session", source: "builtin", unsupported: true },
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin", unsupported: true },
  { name: "reload", description: "Reload extensions, skills, prompts, and other resources", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin", unsupported: true },
];

const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));

function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", args: match[2]?.trim() ?? "" };
}

function formatSessionStats(stats: ReturnType<AgentSession["getSessionStats"]>): string {
  return [
    `Session: ${stats.sessionId}`,
    `File: ${stats.sessionFile ?? "none"}`,
    `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant, ${stats.toolCalls} tool calls, ${stats.toolResults} tool results)`,
    `Tokens: ${stats.tokens.total} (${stats.tokens.input} input, ${stats.tokens.output} output, ${stats.tokens.cacheRead} cache read, ${stats.tokens.cacheWrite} cache write)`,
    `Cost: $${stats.cost.toFixed(6)}`,
  ].join("\n");
}

async function readChangelog(): Promise<string> {
  const changelog = await readFile(piChangelogPath, "utf8");
  const lines = changelog.split("\n");
  const nextHeading = lines.findIndex((line, index) => index > 0 && /^##\s+/.test(line));
  return lines.slice(0, nextHeading === -1 ? Math.min(lines.length, 160) : nextHeading).join("\n").trim();
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

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    await this.session.prompt(text, images?.length ? { images } : undefined);
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

  getCommands(): CommandInfo[] {
    const extensionCommands = this.session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
      sourceInfo: command.sourceInfo,
    }));
    const promptCommands = this.session.promptTemplates.map((template) => ({
      name: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      source: "prompt" as const,
      sourceInfo: template.sourceInfo,
    }));
    const skillCommands = this.session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      sourceInfo: skill.sourceInfo,
    }));
    return [...BUILTIN_COMMANDS, ...extensionCommands, ...promptCommands, ...skillCommands];
  }

  async runBuiltinCommand(text: string): Promise<BuiltinCommandResult> {
    const parsed = parseSlashCommand(text);
    if (!parsed || !BUILTIN_COMMAND_NAMES.has(parsed.name)) return { handled: false };

    const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === parsed.name);
    if (command?.unsupported) {
      return {
        handled: true,
        title: `/${parsed.name}`,
        body: `/${parsed.name} is a terminal-only command in pi and is not supported in the web UI yet.`,
        isError: true,
      };
    }

    if (parsed.name === "reload") {
      await this.session.reload();
      return { handled: true, title: "/reload", body: "Reloaded extensions, skills, prompt templates, and context resources." };
    }
    if (parsed.name === "compact") {
      const result = await this.session.compact(parsed.args || undefined);
      return { handled: true, title: "/compact", body: `Compaction complete.\n\n${JSON.stringify(result, null, 2)}` };
    }
    if (parsed.name === "session") {
      return { handled: true, title: "/session", body: formatSessionStats(this.session.getSessionStats()) };
    }
    if (parsed.name === "name") {
      if (!parsed.args) return { handled: true, title: "/name", body: "Usage: /name <session name>", isError: true };
      this.session.setSessionName(parsed.args);
      return { handled: true, title: "/name", body: `Session name set to: ${parsed.args}` };
    }
    if (parsed.name === "copy") {
      return { handled: true, title: "/copy", body: this.session.getLastAssistantText() || "No assistant message to copy yet." };
    }
    if (parsed.name === "changelog") {
      return { handled: true, title: "/changelog", body: await readChangelog() };
    }
    if (parsed.name === "tree") {
      return { handled: true, title: "/tree", body: "Open the Tree tab or type /tree in the web prompt to show the wide session tree." };
    }

    return {
      handled: true,
      title: `/${parsed.name}`,
      body: `/${parsed.name} is recognized but does not have a web implementation yet.`,
      isError: true,
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
