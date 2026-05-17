import { dirname } from "node:path";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PLAN_ACTIONS_MARKER, type AnswerQuestionPayload, type CommandInfo, type ModelPolicy, type NormalizedAgentEvent, type PendingQuestion, type SessionRuntimeSettings, type SessionSnapshot, type WebSession } from "@pi-web-agent/protocol";
import { loadConfig } from "./config.js";
import type { BuiltinCommandResult, CreateSessionOptions, ImageContent, PiSessionRunner, SessionHandle } from "./pi-runner.js";
import { getBakeryExtensionCommands, reloadConfiguredBakeryExtensions, runBundledExtensionCommand } from "./extensions.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (event: NormalizedAgentEvent, raw: AgentSessionEvent) => void;
type FakeChatMessage = { id: string; role: "user" | "assistant"; timestamp: string; content: string | ({ type: "text"; text: string } | ImageContent)[] };
type FakeBashMessage = { id: string; role: "bashExecution"; timestamp: string; command: string; output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; excludeFromContext?: boolean };
type FakeMessage = FakeChatMessage | FakeBashMessage;

function normalize(event: Record<string, unknown>): NormalizedAgentEvent {
  return { type: String(event.type ?? "event"), time: new Date().toISOString(), data: event };
}

function fakeSettings(modelPolicy: ModelPolicy): SessionRuntimeSettings {
  const availableModels = [
    { id: "fake/fast", provider: "fake", name: "Fake Fast" },
    { id: "fake/slow", provider: "fake", name: "Fake Slow" },
  ].filter((model) => !modelPolicy.allowedModels || modelPolicy.allowedModels.includes(model.id));
  const defaultModel = availableModels.find((model) => model.id === modelPolicy.defaultModel) ?? availableModels[0] ?? null;
  return {
    model: defaultModel,
    availableModels,
    thinkingLevel: modelPolicy.defaultThinkingLevel,
    availableThinkingLevels: modelPolicy.allowedThinkingLevels,
    contextUsage: {
      tokens: 4_200,
      contextWindow: 200_000,
      percent: 2.1,
    },
  };
}

const fakePreviewPng = "iVBORw0KGgoAAAANSUhEUgAAAWgAAACgCAYAAAAhKfa4AAADUElEQVR42u3d0QnCMBiF0W4gFaRQRBDcoDt1GmdxiS7UDeICVaE25m88D+fVC0n4Hm0z3lMCIJ7GIQAINAACDSDQAAg0gEADINAArA50118ByECgAQQaAIEGEGiBBhBoAIEWaACBBkCgAQQaAIEGEGiBBhBoAAQaQKABEGgAgRZoAIEGEGiBBhBoAAQaQKABEGgAgRZoAIEGQKABBBoAgQYQaIEGEGgAgRZoAIEGQKABBBoAgQYQaIEGEGgABBrgfwJ9PJ3fOrTdVz79vn379u3Xui/Q9u3bt19roB2wffv27efZF2j79u3bF2gXZN++ffsCbd++ffsCLdD27du3L9AeiH379gVaoO3bt29foF2Qffv27Qu0ffv27Qu0C7Jv3759gfZA7Nu3L9BBA/2YJ4DsBFqgAYEWaACBFmhAoAUaQKAD/WH/0kFehhvAaktd8UUVgQYEWqABBFqgAYEWaIEGBFqgAYEWaIEGBFqgAQRaoAGBFmgAgRZoQKAFWqABgRZoQKAFWqABgRZoAIEWaECgSwc62h/2e2DA1oH2RRWBBgRaoAEEWqABgRZogQYEWqABgRZogQYEWqABBFqgAYEWaACBFmhAoAVaoAGBFmhAoAVaoAGBFmgAgRZoQKBLB9of9gO1B9oXVQQaEGiBBhBogQYEWqAFGhBogQYEWqAFGhBogQYQaIEGBFqgAQRaoAGBFmiBBgRaoAGBFmiBBgRaoAEEWqABgS4daH/YD9QeaF9UEWhAoAUaQKAFGhBogRZoQKCDBxpgawIt0IBACzSAQAs0INACDSDQgQL9iwOyb9++fYF2Qfbt27cv0Pbt27cv0C7Ivn379gXavn379gVaoO3bt29/H4F2wPbt27fviyoeiH379gVaoO3bt29foF2Qffv27Qu0ffv27Qu0C7Jv3759gfZA7Nu3L9ACbd++ffsC7YLs27dvX6Dt27dvX6BdkH379u0LtH379u0LtEDbt2/fvkB7IPbt2xdogbZv3759gXZB9u3bt5830A7Yvn379n1RxQOxb9++QAu0ffv27Qu0C7Jv3759gbZv3759gXZB9u3bty/QHoh9+/YFWqDt27dvf2+BBqAMgQYQaAAEGkCgARBoAIEGQKABeOkJWSAfL9rB/N8AAAAASUVORK5CYII=";

function responseFor(text: string, cwd = ""): string {
  const includesImage = /(?:image|screenshot|picture)/i.test(text);
  const bakeryArtifactPath = /\.bakery\/artifacts\/[^\s`'"\])]+\.(?:png|jpe?g|gif|webp|svg)/i.exec(text)?.[0];
  const includesArtifactPath = /(?:artifact path|screenshot path|local image path)/i.test(text);
  const includesRemoteArtifactUpload = /(?:uploaded remote screenshot|remote screenshot upload|remote artifact upload)/i.test(text);
  const includesRemoteArtifactPath = /(?:remote screenshot|remote artifact|remote image artifact)/i.test(text);
  const includesArtifactFormatVariants = /(?:artifact format variants|inline fenced long artifact)/i.test(text);
  const includesMobileOverflowProbe = /(?:mobile overflow|overflow transcript|unbroken markdown)/i.test(text);
  const requestedLength = /(?:long|stream|perf|performance)/i.test(text) ? 18000 : includesImage ? 3200 : 1400;
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const remoteFixturePath = `${normalizedCwd}/screenshots/fixture.png`;
  const imageBlock = bakeryArtifactPath
    ? `\nUploaded browser screenshot artifact:\n\n- ${bakeryArtifactPath}\n\nThis path was uploaded through Bakery's artifact endpoint and should render as a transcript image preview.\n`
    : includesRemoteArtifactUpload
      ? "\nUploaded remote screenshot artifacts:\n\n- /remote/agent/workspace/screenshots/uploaded.png\n- ![Uploaded remote Markdown screenshot](file:///remote/agent/workspace/screenshots/uploaded.png)\n\nBoth references require a pre-uploaded Bakery artifact because they are outside the local session workspace.\n"
      : includesRemoteArtifactPath
      ? `\nRemote screenshot artifacts:\n\n- ${remoteFixturePath}\n- ![Remote Markdown screenshot](file://${remoteFixturePath})\n\nBoth references point inside the session workspace and should render through the safe raw-file endpoint, not directly as file:// browser URLs.\n`
      : includesArtifactFormatVariants
      ? "\nRelevant screenshot artifact format variants:\n\nInline code: `screenshots/inline.png`\n\nFenced code:\n\n```text\nscreenshots/fenced.png\n```\n\nLong generated path: `test-results/ui-harness/sample-run/final.png`\n\nAll three workspace-relative paths should render safe local image previews.\n"
      : includesArtifactPath
        ? "\nRelevant screenshot artifacts:\n\n- `screenshots/fixture.png`\n- screenshots/fixture.png\n\nThe UI should render a safe local image preview for that workspace-relative path.\n"
        : includesImage
          ? `\n![Fake UI validation preview](data:image/png;base64,${fakePreviewPng})\n\nThe image above is an inline base64 PNG rendered from assistant Markdown.\n`
          : "";
  const overflowBlock = includesMobileOverflowProbe
    ? `\n\nMobile overflow probe: ${"unbroken-mobile-markdown-token-".repeat(12)}\n\n\`inline-${"code-token-".repeat(16)}\`\n\n\`\`\`text\n${"fenced-code-token-".repeat(18)}\n\`\`\`\n\n`
    : "";
  const seed = [
    "# Synthetic streaming response",
    "",
    "This response is generated by the pi-web fake agent runner for browser automation. It intentionally streams a lot of text so the UI can be tested without calling a real model.",
    imageBlock,
    overflowBlock,
    "",
    "The stream deliberately includes Markdown that arrives mid-token, partial code fences, event bursts, and delayed tool updates so browser automation can catch UI regressions that a perfectly regular fake stream would miss.",
    "",
    "```ts",
    "export function example(value: string) {",
    "  return value.toUpperCase();",
    "}",
    "```",
    "",
  ].join("\n");
  const paragraph = [
    "The quick brown fox checks whether prompt typing, header controls, transcript selection, and auto-scroll remain responsive while the assistant message grows.",
    "Every few sentences the fake runner crosses **Markdown emphasis**, `inline code`, list boundaries, and fenced code blocks in awkwardly sized chunks.",
    "\n\n- streamed bullet one\n- streamed bullet two with a [local link](./README.md)\n\n```ts\nconst partialFence = true;\nconsole.log({ partialFence });\n```\n\n",
  ].join(" ");
  return (seed + paragraph.repeat(Math.ceil(requestedLength / paragraph.length))).slice(0, requestedLength);
}

function streamChunkSize(index: number): number {
  const sizes = [34, 147, 9, 216, 61, 88, 19, 132, 44, 305, 72, 118];
  return sizes[index % sizes.length] ?? 90;
}

function streamDelayMs(index: number): number {
  // Deterministic uneven cadence: short bursts, normal token cadence, and occasional stalls.
  if (index % 17 === 0 || index % 17 === 1 || index % 17 === 2) return 0;
  if (index % 29 === 0) return 95;
  if (index % 11 === 0) return 42;
  const delays = [8, 14, 23, 6, 31, 18, 12, 27];
  return delays[index % delays.length] ?? 16;
}

class FakeSessionHandle implements SessionHandle {
  readonly session: any;
  private readonly sessionManager: SessionManager;
  private readonly listeners = new Set<Listener>();
  private readonly messages: FakeMessage[] = [];
  private aborted = false;
  private currentModel = "fake/fast";
  private currentThinking: string;
  private steeringQueue: Array<{ text: string; images: ImageContent[] | undefined }> = [];
  private followUpQueue: Array<{ text: string; images: ImageContent[] | undefined }> = [];
  private pendingQuestion: PendingQuestion | null = null;
  private questionResolver: ((answer: Required<Pick<AnswerQuestionPayload, "cancelled">> & Omit<AnswerQuestionPayload, "cancelled">) => void) | null = null;
  private readonly questionListeners = new Set<(question: PendingQuestion | null) => void>();

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly sessionFile: string,
    private readonly modelPolicy: ModelPolicy,
  ) {
    this.currentModel = fakeSettings(modelPolicy).model?.id ?? this.currentModel;
    this.currentThinking = modelPolicy.defaultThinkingLevel;
    this.sessionManager = SessionManager.open(sessionFile, dirname(sessionFile), cwd);
    this.session = {
      isStreaming: false,
      isBashRunning: false,
      state: { messages: this.messages },
      sessionManager: this.sessionManager,
      navigateTree: (entryId: string) => this.navigateTree(entryId),
    };
    this.restoreMessagesFromSession();
  }

  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    const now = new Date().toISOString();
    const userContent = images?.length ? [{ type: "text" as const, text }, ...images] : text;
    const user: FakeChatMessage = { id: crypto.randomUUID(), role: "user", timestamp: now, content: userContent };
    this.messages.push(user);
    this.sessionManager.appendMessage({ role: "user", content: userContent } as never);
    this.emit({ type: "message_end", message: user });

    if (this.pendingQuestion) {
      this.pendingQuestion = null;
      this.questionResolver = null;
      this.emitQuestionUpdate();
    }

    const shouldAskQuestion = /(?:question-answer|ask_question|ask question|clarif)/i.test(text);
    const shouldEmitToolImageHeavyTranscript = /(?:tool[/-]?image-heavy|tool image heavy|image-heavy transcript|long tool image)/i.test(text);
    const shouldEmitSubagentCard = /(?:subagent[ -]?card|fake subagent|subagent renderer)/i.test(text);
    const shouldRunTool = /tool/i.test(text) && !shouldAskQuestion && !shouldEmitToolImageHeavyTranscript && !shouldEmitSubagentCard;
    const toolRunCount = /(?:multiple|many|group)\s+tools/i.test(text) ? 4 : 1;

    this.aborted = false;
    this.session.isStreaming = true;
    this.emit({ type: "agent_start" });

    if (shouldEmitToolImageHeavyTranscript) {
      await this.emitToolImageHeavyTranscript();
      this.session.isStreaming = false;
      this.steeringQueue = [];
      this.followUpQueue = [];
      this.emit({ type: "agent_end" });
      this.emitQueueUpdate();
      return;
    }

    if (shouldEmitSubagentCard) {
      const slowSubagentCard = /(?:slow fake subagent card|subagent card reconnect)/i.test(text);
      await this.emitFakeSubagentRun(slowSubagentCard ? { runningDelayMs: 4_000 } : {});
      this.session.isStreaming = false;
      this.steeringQueue = [];
      this.followUpQueue = [];
      this.emit({ type: "agent_end" });
      this.emitQueueUpdate();
      return;
    }

    if (shouldAskQuestion) {
      const isPlanWorkflow = /^Run the bundled `plan` workflow skill for this coding session\./m.test(text);
      await this.emitFakeQuestionRun(!isPlanWorkflow && /cancel/i.test(text), isPlanWorkflow, /(?:many mobile question options|many question options)/i.test(text));
      this.session.isStreaming = false;
      this.steeringQueue = [];
      this.followUpQueue = [];
      this.emit({ type: "agent_end" });
      this.emitQueueUpdate();
      return;
    }

    const assistant: FakeChatMessage = { id: crypto.randomUUID(), role: "assistant", timestamp: new Date().toISOString(), content: "" };
    this.messages.push(assistant);
    this.emit({ type: "message_start", message: assistant });

    const full = responseFor(text, this.cwd);
    const toolAtOffset = shouldRunTool ? Math.min(Math.max(450, Math.floor(full.length * 0.22)), full.length - 1) : Infinity;
    const shouldConsumeFollowUpBeforeTranscript = /consume queued follow-?up before transcript/i.test(text);
    let emittedTool = false;
    let emittedConsumedFollowUp = false;
    for (let offset = 0, chunkIndex = 0; offset < full.length && !this.aborted; chunkIndex++) {
      const nextOffset = Math.min(full.length, offset + streamChunkSize(chunkIndex));
      assistant.content = full.slice(0, nextOffset);
      this.emit({ type: "message_update", message: { ...assistant } });
      offset = nextOffset;

      if (!emittedTool && offset >= toolAtOffset) {
        emittedTool = true;
        const shouldEmitFailedTool = /failed tools?|tool failures?|alignment/i.test(text);
        for (let toolIndex = 0; toolIndex < toolRunCount; toolIndex++) {
          await this.emitFakeToolRun(/(?:long|narrow)/i.test(text), toolIndex + 1, shouldEmitFailedTool && toolIndex === 2);
        }
      }

      if (shouldConsumeFollowUpBeforeTranscript && !emittedConsumedFollowUp && offset >= 700 && this.followUpQueue.length > 0) {
        emittedConsumedFollowUp = true;
        const [followUp] = this.followUpQueue.splice(0, 1);
        this.emitQueueUpdate();
        await sleep(350);
        if (followUp && !this.aborted) this.emitQueuedUserMessage(followUp.text, followUp.images);
      }

      const delay = streamDelayMs(chunkIndex);
      if (delay > 0) await sleep(delay);
    }
    if (this.aborted) assistant.content += "\n\n[aborted]";
    else assistant.content = full;
    this.sessionManager.appendMessage({ role: "assistant", content: assistant.content } as never);
    this.emit({ type: "message_end", message: { ...assistant } });
    this.session.isStreaming = false;
    this.steeringQueue = [];
    this.followUpQueue = [];
    this.emit({ type: "agent_end" });
    this.emitQueueUpdate();
  }

  async steer(text: string, images?: ImageContent[]): Promise<void> {
    this.steeringQueue.push({ text, images });
    this.emitQueueUpdate();
  }

  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    this.followUpQueue.push({ text, images });
    this.emitQueueUpdate();
  }

  async executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string }> {
    this.session.isBashRunning = true;
    const output = [`fake bash: ${command}`, options?.excludeFromContext ? "excluded from context" : "included in context"].join("\n") + "\n";
    for (const chunk of output.match(/.{1,24}/gs) ?? []) {
      onChunk?.(chunk);
      await sleep(10);
    }
    const result = { output, exitCode: 0, cancelled: false, truncated: false };
    const bashMessage: FakeBashMessage = {
      id: crypto.randomUUID(),
      role: "bashExecution",
      timestamp: new Date().toISOString(),
      command,
      output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      ...(options?.excludeFromContext ? { excludeFromContext: true } : {}),
    };
    this.messages.push(bashMessage);
    this.sessionManager.appendMessage(bashMessage as never);
    this.session.isBashRunning = false;
    return result;
  }

  async cancelQueuedMessage(queue: "steering" | "followUp", index: number, text?: string): Promise<{ steering: string[]; followUp: string[] }> {
    const target = queue === "steering" ? this.steeringQueue : this.followUpQueue;
    if (index >= target.length) throw new Error("Queued message no longer exists.");
    if (text !== undefined && target[index]?.text !== text) throw new Error("Queued message changed before it could be canceled.");
    target.splice(index, 1);
    this.emitQueueUpdate();
    return { steering: this.steeringQueue.map((message) => message.text), followUp: this.followUpQueue.map((message) => message.text) };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.cancelPendingQuestion();
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  isCheckpointQuestion(questionId: string): boolean {
    return Boolean(this.pendingQuestion && this.pendingQuestion.id === questionId && !this.questionResolver);
  }

  answerQuestion(payload: AnswerQuestionPayload): void {
    if (!this.pendingQuestion || payload.questionId !== this.pendingQuestion.id || !this.questionResolver) return;
    const resolver = this.questionResolver;
    this.pendingQuestion = null;
    this.questionResolver = null;
    this.emitQuestionUpdate();
    resolver({
      questionId: payload.questionId,
      answer: payload.cancelled ? undefined : payload.answer,
      selectedIndex: payload.selectedIndex ?? null,
      wasCustom: payload.wasCustom ?? false,
      cancelled: payload.cancelled ?? false,
    });
  }

  subscribeQuestion(listener: (question: PendingQuestion | null) => void): () => void {
    this.questionListeners.add(listener);
    return () => this.questionListeners.delete(listener);
  }

  async setModel(model: string): Promise<void> {
    this.currentModel = model;
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.currentThinking = level;
  }

  setSessionName(_name: string): void {
    // Fake runner keeps the canonical web title in metadata only.
  }

  async getSettings(): Promise<SessionRuntimeSettings> {
    const settings = fakeSettings(this.modelPolicy);
    const tokens = 4_200 + this.messages.reduce((sum, message) => {
      const text = message.role === "bashExecution" ? `${message.command}\n${message.output}` : typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return sum + text.length;
    }, 0) / 4;
    const contextWindow = 200_000;
    return {
      ...settings,
      model: settings.availableModels.find((model) => model.id === this.currentModel) ?? settings.model,
      thinkingLevel: this.currentThinking,
      contextUsage: {
        tokens: Math.round(tokens),
        contextWindow,
        percent: (tokens / contextWindow) * 100,
      },
    };
  }

  getCommands(): CommandInfo[] {
    return [
      { name: "new", description: "Start a new web session in the same workspace", source: "builtin" },
      ...getBakeryExtensionCommands(),
      { name: "session", description: "Show session info", source: "builtin" },
      { name: "reload", description: "Reload fake resources", source: "builtin" },
    ];
  }

  async runBuiltinCommand(text: string): Promise<BuiltinCommandResult> {
    const trimmed = text.trim();
    if (trimmed === "/session") return { handled: true, title: "/session", body: `Fake session ${this.id}\nMessages: ${this.messages.length}` };
    if (trimmed === "/reload") {
      const registry = await reloadConfiguredBakeryExtensions(loadConfig());
      const issueText = registry.issues.length > 0 ? `\n\nExtension issues:\n${registry.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}` : "";
      return { handled: true, title: "/reload", body: `Reloaded fake resources and Bakery extensions. Bakery extensions loaded: ${registry.extensions.length}.${issueText}`, isError: registry.issues.length > 0 };
    }
    const workflowMatch = /^\/([\w:-]+(?:-[\w:-]+)*)(?:\s+([\s\S]*))?$/.exec(trimmed);
    const commandName = workflowMatch?.[1] ?? "";
    const bundledExtensionResult = commandName ? await runBundledExtensionCommand(commandName, workflowMatch?.[2]?.trim() ?? "") : undefined;
    if (bundledExtensionResult?.kind === "launchPrompt") {
      return {
        handled: true,
        title: bundledExtensionResult.title ?? `/${commandName}`,
        launchPrompt: bundledExtensionResult.prompt,
      };
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
    return { handled: false };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(webSession: WebSession): Promise<SessionSnapshot> {
    return {
      session: webSession,
      status: this.session.isStreaming ? "running" : "idle",
      messages: this.messages,
      settings: await this.getSettings(),
      pendingQuestion: this.pendingQuestion,
      queuedMessages: {
        steering: this.steeringQueue.map((message) => message.text),
        followUp: this.followUpQueue.map((message) => message.text),
      },
    };
  }

  dispose(): void {
    this.aborted = true;
    this.cancelPendingQuestion();
    this.listeners.clear();
    this.questionListeners.clear();
  }

  private emit(event: Record<string, unknown>): void {
    const normalized = normalize(event);
    for (const listener of this.listeners) listener(normalized, event as AgentSessionEvent);
  }

  private emitQueuedUserMessage(text: string, images?: ImageContent[]): void {
    const content = images?.length ? [{ type: "text" as const, text }, ...images] : text;
    const user: FakeChatMessage = { id: crypto.randomUUID(), role: "user", timestamp: new Date().toISOString(), content };
    this.messages.push(user);
    this.sessionManager.appendMessage({ role: "user", content } as never);
    this.emit({ type: "message_end", message: user });
  }

  private emitQueueUpdate(): void {
    this.emit({ type: "queue_update", steering: this.steeringQueue.map((message) => message.text), followUp: this.followUpQueue.map((message) => message.text) });
  }

  private emitQuestionUpdate(): void {
    for (const listener of this.questionListeners) listener(this.pendingQuestion);
  }

  private cancelPendingQuestion(): void {
    if (!this.pendingQuestion || !this.questionResolver) return;
    this.answerQuestion({ questionId: this.pendingQuestion.id, cancelled: true, selectedIndex: null, wasCustom: false });
  }

  private restoreMessagesFromSession(): void {
    this.messages.splice(0, this.messages.length);
    for (const entry of this.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as unknown as Record<string, unknown>;
      if (message.role === "bashExecution") {
        this.messages.push({
          id: entry.id,
          role: "bashExecution",
          timestamp: entry.timestamp,
          command: String(message.command ?? ""),
          output: String(message.output ?? ""),
          exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined,
          cancelled: Boolean(message.cancelled),
          truncated: Boolean(message.truncated),
          ...(message.excludeFromContext ? { excludeFromContext: true } : {}),
        });
        continue;
      }
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
      if (!role) continue;
      this.messages.push({
        id: entry.id,
        role,
        timestamp: entry.timestamp,
        content: message.content as FakeChatMessage["content"],
      });
    }
  }

  private async navigateTree(entryId: string): Promise<{ cancelled: false; editorText?: string }> {
    const entry = this.sessionManager.getEntry(entryId);
    if (!entry) throw new Error(`Entry not found: ${entryId}`);
    this.sessionManager.branch(entryId);
    this.restoreMessagesFromSession();
    const message = entry.type === "message" ? entry.message as unknown as Record<string, unknown> : null;
    const editorText = message?.role === "user" && typeof message.content === "string" ? String(message.content) : undefined;
    return editorText === undefined ? { cancelled: false } : { cancelled: false, editorText };
  }

  private async emitFakeQuestionRun(expectCancel = false, isPlanWorkflow = false, manyOptions = false): Promise<void> {
    const toolCallId = crypto.randomUUID();
    const args = {
      title: expectCancel ? "Cancel path" : "Today's work",
      question: expectCancel ? "Should this question be cancelled?" : "What are you working on today?",
      recommendation: expectCancel ? "Cancel this prompt to verify the cancellation path." : "New feature — start with the smallest vertical slice that proves the UI lifecycle.",
      options: manyOptions
        ? Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index + 1}`, description: `Long mobile answer option ${index + 1} that should scroll inside the compact question card instead of pushing the composer away.` }))
        : [
          { label: "New feature", description: "Adding new functionality to the project" },
          { label: "Bug fix", description: "Tracking down and fixing an issue" },
          { label: "Refactoring", description: "Improving existing code structure" },
        ],
      recommendedOptionIndex: expectCancel ? undefined : 0,
      allowCustomAnswer: true,
    };
    this.emit({ type: "tool_execution_start", toolCallId, toolName: "ask_question", args });
    this.pendingQuestion = { id: crypto.randomUUID(), ...args, createdAt: new Date().toISOString() };
    this.emitQuestionUpdate();
    const result = { content: [{ type: "text", text: "Question checkpoint shown to the operator. The operator will continue in chat." }], details: { questionId: this.pendingQuestion.id, question: args.question, options: args.options, recommendedOptionIndex: args.recommendedOptionIndex ?? null, terminalCheckpoint: true, cancelled: false } };
    this.emit({ type: "tool_execution_end", toolCallId, toolName: "ask_question", result, isError: false });
    if (!isPlanWorkflow) return;
    const planSummary = [
      "## Plan summary",
      "",
      "Recommendation: start with the smallest vertical slice that proves the UI lifecycle.",
      "",
      "## Smallest next slice",
      "",
      "Add the focused Bakery UI behavior, keep shared contracts in packages/protocol if needed, and validate with the selected focused harness command.",
      "",
      "## Key files likely to change",
      "",
      "- apps/web/src/main.ts",
      "- apps/web/src/transcript.ts",
      "- apps/web/src/styles/transcript.css",
      "- targeted tests",
      "",
      "## Validation plan",
      "",
      "Run `bun run report:iteration --recommend <changed files>`, then `bun run check` and the focused harness scenario selected by the report.",
      "",
      "## Full plan",
      "",
      "Start with the smallest slice because it proves the transcript card, details view, and composer prefill without broad extension loading changes.",
      "",
      PLAN_ACTIONS_MARKER,
    ].join("\n");
    const assistant: FakeChatMessage = { id: crypto.randomUUID(), role: "assistant", timestamp: new Date().toISOString(), content: planSummary };
    this.messages.push(assistant);
    this.sessionManager.appendMessage({ role: "assistant", content: assistant.content } as never);
    this.emit({ type: "message_end", message: assistant });
  }

  private async emitToolImageHeavyTranscript(): Promise<void> {
    const rows = 96;
    for (let index = 1; index <= rows && !this.aborted; index++) {
      const assistant: FakeChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        timestamp: new Date().toISOString(),
        content: [
          `### Tool/image-heavy sample ${index}`,
          "",
          "This synthetic row exists to measure transcript rendering with many image references and completed tool cards.",
          "",
          `- Workspace screenshot path: screenshots/fixture.png`,
          `- Repeated note ${index}: image preview cards should stay stable while the transcript grows.`,
        ].join("\n"),
      };
      this.messages.push(assistant);
      this.sessionManager.appendMessage({ role: "assistant", content: assistant.content } as never);
      this.emit({ type: "message_end", message: assistant });

      const toolCallId = crypto.randomUUID();
      const args = { command: `printf 'render image-heavy transcript row ${index}'` };
      const outputLines = Array.from({ length: 24 }, (_, lineIndex) => `[row ${String(index).padStart(2, "0")}] synthetic tool output line ${String(lineIndex + 1).padStart(2, "0")} with enough text to exercise wrapping and summary generation`).join("\n");
      const text = `${outputLines}\n\nGenerated screenshot artifact: screenshots/fixture.png\n`;
      this.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args });
      this.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        result: {
          content: [{ type: "text", text }],
          details: { stdout: `${text}\n`, stderr: "", exitCode: 0 },
        },
      });
      if (index % 4 === 0) await sleep(0);
    }
  }

  private async emitFakeSubagentRun(options: { runningDelayMs?: number } = {}): Promise<void> {
    const toolCallId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 120).toISOString();
    const args = { agent: "reviewer", task: "Review the current Bakery subagent card implementation", context: "fork" };
    this.emit({ type: "tool_execution_start", toolCallId, toolName: "subagent", args, startedAt });
    await sleep(80);
    this.emit({
      type: "tool_execution_update",
      toolCallId,
      toolName: "subagent",
      args,
      startedAt,
      partialResult: {
        content: [{ type: "text", text: "Reviewer is inspecting transcript rendering..." }],
        details: {
          mode: "single",
          runId: "fake-subagent-run",
          context: "fork",
          progressSummary: { toolCount: 1, tokens: 980, durationMs: 1_200 },
          progress: [{ index: 0, agent: "reviewer", status: "running", task: args.task, currentTool: "read", currentPath: "apps/web/src/transcript.ts", recentTools: [], toolCount: 1, tokens: 980, durationMs: 1_200 }],
          results: [],
        },
      },
    });
    // Keep the live progress state observable long enough for focused UI harness layout assertions.
    await sleep(options.runningDelayMs ?? 750);
    const endedAt = new Date().toISOString();
    this.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: "subagent",
      args,
      startedAt,
      endedAt,
      result: {
        content: [{ type: "text", text: "Reviewer approved the subagent card slice and recommended focused UI coverage." }],
        details: {
          mode: "single",
          runId: "fake-subagent-run",
          context: "fork",
          progressSummary: { toolCount: 2, tokens: 1_640, durationMs: 2_400 },
          results: [{
            agent: "reviewer",
            task: args.task,
            exitCode: 0,
            usage: { input: 1200, output: 440, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
            model: "fake/subagent-reviewer",
            finalOutput: "Reviewer approved the subagent card slice and recommended focused UI coverage.",
            sessionFile: "/tmp/fake-subagent-session.jsonl",
            savedOutputPath: "/tmp/fake-subagent-output.md",
          }],
        },
      },
    });
  }

  private async emitFakeToolRun(longOutput = false, runIndex = 1, fail = false): Promise<void> {
    const toolCallId = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 40).toISOString();
    if (!longOutput && runIndex === 2) {
      const args = { path: "screenshots/fixture.png" };
      this.emit({ type: "tool_execution_start", toolCallId, toolName: "read", args, startedAt });
      await sleep(45);
      const endedAt = new Date().toISOString();
      this.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "read",
        args,
        startedAt,
        endedAt,
        result: { content: [{ type: "image", mimeType: "image/png", data: fakePreviewPng }] },
      });
      return;
    }

    const args = { command: longOutput ? "for i in {1..80}; do echo fake tool line $i; done" : `echo fake tool ${runIndex}` };
    const outputLines = longOutput
      ? Array.from({ length: 80 }, (_, index) => `[server] fake tool line ${String(index + 1).padStart(2, "0")} {\"level\":30,\"msg\":\"synthetic streaming terminal output\"}`).join("\n")
      : `fake tool ${runIndex} output\nstdout: first line\nstderr: delayed diagnostic`;
    this.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args, startedAt });
    await sleep(35);
    this.emit({ type: "tool_execution_update", toolCallId, toolName: "bash", args, startedAt, partialResult: { content: [{ type: "text", text: "running fake tool...\n" }] } });
    // Burst two updates together to exercise tool-card patching under clustered events.
    this.emit({ type: "tool_execution_update", toolCallId, toolName: "bash", args, startedAt, partialResult: { content: [{ type: "text", text: `running fake tool...\n${longOutput ? outputLines.split("\n").slice(0, 18).join("\n") + "\n" : "stdout: first line\n"}` }] } });
    await sleep(120);
    this.emit({ type: "tool_execution_update", toolCallId, toolName: "bash", args, startedAt, partialResult: { content: [{ type: "text", text: longOutput ? `running fake tool...\n${outputLines}\n` : "running fake tool...\nstdout: first line\nstderr: delayed diagnostic\n" }] } });
    await sleep(25);
    const endedAt = new Date().toISOString();
    this.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName: "bash",
      args,
      startedAt,
      endedAt,
      isError: fail,
      result: {
        content: [{ type: "text", text: fail ? `${outputLines}\nsynthetic failure` : outputLines }],
        details: { stdout: `${outputLines}\n`, stderr: fail ? "synthetic failure\n" : longOutput ? "" : "delayed diagnostic\n", exitCode: fail ? 1 : 0 },
      },
    });
  }
}

export class FakePiSessionRunner implements PiSessionRunner {
  private readonly handles = new Map<string, SessionHandle>();

  constructor(private readonly modelPolicy: ModelPolicy) {}

  async createSession(options: CreateSessionOptions): Promise<SessionHandle> {
    const existing = this.handles.get(options.id);
    if (existing) return existing;
    const modelPolicy = { ...this.modelPolicy, ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}) };
    const handle = new FakeSessionHandle(options.id, options.cwd ?? process.cwd(), options.piSessionFile, modelPolicy);
    this.handles.set(options.id, handle);
    return handle;
  }

  getSession(id: string): SessionHandle | undefined {
    return this.handles.get(id);
  }

  async disposeSession(id: string): Promise<void> {
    this.handles.get(id)?.dispose();
    this.handles.delete(id);
  }
}
