import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AnswerQuestionPayload, CommandInfo, ModelInfo, ModelPolicy, NormalizedAgentEvent, PendingQuestion, SessionRuntimeSettings, SessionSnapshot, WebSession } from "@pi-web-agent/protocol";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import { getBakeryExtensionCommands, isBundledExtensionCommand, reloadConfiguredBakeryExtensions, runBundledExtensionCommand } from "./extensions.js";

export type ImageContent = { type: "image"; data: string; mimeType: string };
export type BashResult = { output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string };

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
  data?: unknown;
  launchPrompt?: string;
};

export type SessionHandle = {
  id: string;
  cwd: string;
  sessionFile: string;
  session: AgentSession;
  prompt(text: string, images?: ImageContent[]): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<BashResult>;
  cancelQueuedMessage(queue: "steering" | "followUp", index: number, text?: string): Promise<{ steering: string[]; followUp: string[] }>;
  abort(): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setSessionName(name: string): void;
  getPendingQuestion(): PendingQuestion | null;
  answerQuestion(payload: AnswerQuestionPayload): void;
  subscribeQuestion(listener: (question: PendingQuestion | null) => void): () => void;
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
  return session.isStreaming || session.isBashRunning ? "running" : "idle";
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
  { name: "login", description: "Configure provider authentication", source: "builtin", unsupported: true },
  { name: "logout", description: "Remove provider authentication", source: "builtin", unsupported: true },
  { name: "new", description: "Start a new web session in the same workspace", source: "builtin" },
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin", unsupported: true },
  { name: "reload", description: "Reload extensions, skills, prompts, and other resources", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin", unsupported: true },
];

const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));
function isWebCommandName(name: string): boolean {
  return BUILTIN_COMMAND_NAMES.has(name) || isBundledExtensionCommand(name);
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([\w:-]+(?:-[\w:-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
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

type QuestionAnswer = Required<Pick<AnswerQuestionPayload, "cancelled">> & Omit<AnswerQuestionPayload, "cancelled">;

class QuestionBroker {
  private pending: PendingQuestion | null = null;
  private resolver: ((answer: QuestionAnswer) => void) | null = null;
  private readonly listeners = new Set<(question: PendingQuestion | null) => void>();

  getPendingQuestion(): PendingQuestion | null {
    return this.pending;
  }

  subscribe(listener: (question: PendingQuestion | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  answer(payload: AnswerQuestionPayload): void {
    if (!this.pending || payload.questionId !== this.pending.id || !this.resolver) return;
    const resolver = this.resolver;
    this.pending = null;
    this.resolver = null;
    this.notify();
    resolver({
      questionId: payload.questionId,
      answer: payload.cancelled ? undefined : payload.answer,
      selectedIndex: payload.selectedIndex ?? null,
      wasCustom: payload.wasCustom ?? false,
      cancelled: payload.cancelled ?? false,
    });
  }

  cancel(): void {
    if (!this.pending || !this.resolver) return;
    this.answer({ questionId: this.pending.id, cancelled: true, selectedIndex: null, wasCustom: false });
  }

  async ask(input: { title?: string; question: string; recommendation?: string; options?: Array<{ label: string; description?: string }>; recommendedOptionIndex?: number; allowCustomAnswer?: boolean }, signal?: AbortSignal): Promise<QuestionAnswer> {
    if (this.pending) throw new Error("A question is already pending for this session.");
    const question: PendingQuestion = {
      id: crypto.randomUUID(),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      question: input.question,
      ...(input.recommendation?.trim() ? { recommendation: input.recommendation.trim() } : {}),
      options: input.options ?? [],
      ...(typeof input.recommendedOptionIndex === "number" && input.recommendedOptionIndex >= 0 && input.recommendedOptionIndex < (input.options?.length ?? 0) ? { recommendedOptionIndex: input.recommendedOptionIndex } : {}),
      allowCustomAnswer: input.allowCustomAnswer ?? true,
      createdAt: new Date().toISOString(),
    };
    this.pending = question;
    this.notify();
    return await new Promise<QuestionAnswer>((resolve) => {
      this.resolver = resolve;
      const onAbort = () => this.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.pending);
  }
}

function createAskQuestionTool(broker: QuestionBroker) {
  return defineTool({
    name: "ask_question",
    label: "Question",
    description: "Ask the user one concise question in the web UI when you need clarification, confirmation, or a decision before continuing. Ask one question at a time. Include your recommended answer when useful.",
    promptSnippet: "Ask the user one interactive question in the web UI and wait for their answer.",
    promptGuidelines: [
      "Use ask_question when you need clarification, confirmation, or a user decision before continuing instead of writing a plain-text question.",
      "Ask one question at a time with ask_question. For design/planning interviews or when the user asks to be grilled, include a recommended answer.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short label for the question card." })),
      question: Type.String({ description: "The single question to ask the user." }),
      recommendation: Type.Optional(Type.String({ description: "Your recommended answer, shown display-only to the user." })),
      options: Type.Optional(Type.Array(Type.Object({
        label: Type.String({ description: "Option label." }),
        description: Type.Optional(Type.String({ description: "Optional short explanation for this option." })),
      }), { description: "Selectable answer options." })),
      recommendedOptionIndex: Type.Optional(Type.Number({ description: "Zero-based index of the recommended option when options are provided. The UI highlights and initially focuses this option." })),
      allowCustomAnswer: Type.Optional(Type.Boolean({ description: "Whether the user may type a custom answer. Defaults to true." })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const answer = await broker.ask(params, signal);
        if (answer.cancelled) {
          return {
            content: [{ type: "text" as const, text: "User cancelled the question." }],
            details: { questionId: answer.questionId, question: params.question, answer: null, selectedIndex: null, wasCustom: false, cancelled: true } as Record<string, unknown>,
          };
        }
        const selected = typeof answer.selectedIndex === "number" ? params.options?.[answer.selectedIndex] : undefined;
        const prefix = answer.wasCustom ? "User wrote" : selected ? `User selected option ${answer.selectedIndex! + 1}` : "User answered";
        return {
          content: [{ type: "text" as const, text: `${prefix}: ${answer.answer ?? ""}` }],
          details: {
            questionId: answer.questionId,
            question: params.question,
            answer: answer.answer ?? null,
            selectedIndex: answer.selectedIndex ?? null,
            optionLabel: selected?.label,
            wasCustom: answer.wasCustom ?? false,
            cancelled: false,
          } as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Question failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { question: params.question, answer: null, selectedIndex: null, wasCustom: false, cancelled: true } as Record<string, unknown>,
        };
      }
    },
  });
}

class InProcessSessionHandle implements SessionHandle {
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly sessionFile: string,
    readonly session: AgentSession,
    private readonly modelPolicy: ModelPolicy,
    private readonly questionBroker: QuestionBroker,
  ) {}

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    await this.session.prompt(text, images?.length ? { images } : undefined);
  }

  private readonly queuedMessages: { steering: Array<{ text: string; images: ImageContent[] | undefined }>; followUp: Array<{ text: string; images: ImageContent[] | undefined }> } = { steering: [], followUp: [] };

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    this.queuedMessages.steering.push({ text, images });
    await this.session.steer(text, images);
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    this.queuedMessages.followUp.push({ text, images });
    await this.session.followUp(text, images);
  }

  async executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<BashResult> {
    return await this.session.executeBash(command, onChunk, options);
  }

  async cancelQueuedMessage(queue: "steering" | "followUp", index: number, text?: string): Promise<{ steering: string[]; followUp: string[] }> {
    const sdkQueued = {
      steering: [...this.session.getSteeringMessages()],
      followUp: [...this.session.getFollowUpMessages()],
    };
    const current = sdkQueued[queue];
    if (index >= current.length) throw new Error("Queued message no longer exists.");
    if (text !== undefined && current[index] !== text) throw new Error("Queued message changed before it could be canceled.");
    const queued = {
      steering: this.queuedMessages.steering.length === sdkQueued.steering.length ? [...this.queuedMessages.steering] : sdkQueued.steering.map((message) => ({ text: message, images: undefined })),
      followUp: this.queuedMessages.followUp.length === sdkQueued.followUp.length ? [...this.queuedMessages.followUp] : sdkQueued.followUp.map((message) => ({ text: message, images: undefined })),
    };
    queued[queue].splice(index, 1);
    this.session.clearQueue();
    this.queuedMessages.steering = [];
    this.queuedMessages.followUp = [];
    for (const steering of queued.steering) await this.steer(steering.text, steering.images);
    for (const followUp of queued.followUp) await this.followUp(followUp.text, followUp.images);
    return { steering: queued.steering.map((message) => message.text), followUp: queued.followUp.map((message) => message.text) };
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

  setSessionName(name: string): void {
    this.session.setSessionName(name);
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.questionBroker.getPendingQuestion();
  }

  answerQuestion(payload: AnswerQuestionPayload): void {
    this.questionBroker.answer(payload);
  }

  subscribeQuestion(listener: (question: PendingQuestion | null) => void): () => void {
    return this.questionBroker.subscribe(listener);
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
      contextUsage: this.session.getContextUsage(),
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
    return [...BUILTIN_COMMANDS, ...getBakeryExtensionCommands(), ...extensionCommands, ...promptCommands, ...skillCommands];
  }

  async runBuiltinCommand(text: string): Promise<BuiltinCommandResult> {
    const parsed = parseSlashCommand(text);
    if (!parsed || !isWebCommandName(parsed.name)) return { handled: false };

    const bundledExtensionResult = await runBundledExtensionCommand(parsed.name, parsed.args);
    if (bundledExtensionResult?.kind === "launchPrompt") {
      return { handled: true, title: bundledExtensionResult.title ?? `/${parsed.name}`, launchPrompt: bundledExtensionResult.prompt };
    }
    if (bundledExtensionResult?.kind === "handled") {
      return {
        handled: true,
        ...(bundledExtensionResult.title ? { title: bundledExtensionResult.title } : {}),
        ...(bundledExtensionResult.body ? { body: bundledExtensionResult.body } : {}),
        ...(typeof bundledExtensionResult.isError === "boolean" ? { isError: bundledExtensionResult.isError } : {}),
        ...(bundledExtensionResult.card ? { data: { kind: "extension_card", card: bundledExtensionResult.card } } : bundledExtensionResult.data !== undefined ? { data: bundledExtensionResult.data } : {}),
      };
    }

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
      const registry = await reloadConfiguredBakeryExtensions(loadConfig());
      const issueText = registry.issues.length > 0 ? `\n\nExtension issues:\n${registry.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}` : "";
      return { handled: true, title: "/reload", body: `Reloaded extensions, skills, prompt templates, and context resources. Bakery extensions loaded: ${registry.extensions.length}.${issueText}`, isError: registry.issues.length > 0 };
    }
    if (parsed.name === "compact") {
      const result = await this.session.compact(parsed.args || undefined);
      return { handled: true, title: "/compact", body: `Compaction complete.\n\n${JSON.stringify(result, null, 2)}` };
    }
    if (parsed.name === "session") {
      return { handled: true, title: "/session", body: formatSessionStats(this.session.getSessionStats()) };
    }
    if (parsed.name === "name") return { handled: false };
    if (parsed.name === "copy") {
      return { handled: true, title: "/copy", body: this.session.getLastAssistantText() || "No assistant message to copy yet." };
    }
    if (parsed.name === "changelog") {
      return { handled: true, title: "/changelog", body: await readChangelog() };
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
      pendingQuestion: this.getPendingQuestion(),
    };
  }

  dispose(): void {
    this.questionBroker.cancel();
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
    const questionBroker = new QuestionBroker();
    const { session } = await createAgentSession({ cwd: options.cwd, sessionManager, thinkingLevel: this.modelPolicy.defaultThinkingLevel as never, customTools: [createAskQuestionTool(questionBroker)] });
    const handle = new InProcessSessionHandle(options.id, options.cwd, options.piSessionFile, session, this.modelPolicy, questionBroker);
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
