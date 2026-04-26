import { marked } from "marked";
import { PROTOCOL_VERSION, type CommandInfo, type CommandResponse, type ControllerInfo, type FileCompleteResponse, type FileMatch, type FileSearchResponse, type HelloMessage, type ServerEnvelope, type SessionRuntimeSettings, type SessionSnapshot, type WebSession, type Workspace } from "@pi-web-agent/protocol";
import "./styles.css";

type AgentStatus = SessionSnapshot["status"] | "disconnected" | "connecting";
type TranscriptKind = "user" | "assistant" | "tool" | "system" | "error";
type TranscriptSegment =
  | { kind: "markdown"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; label: string }
  | { kind: "image"; label: string }
  | { kind: "pre"; text: string };

type TranscriptItem = {
  id: string;
  kind: TranscriptKind;
  title: string;
  body: string;
  segments?: TranscriptSegment[];
  status?: "running" | "done" | "error";
};

type FileAutocompleteState = {
  active: boolean;
  token: string;
  start: number;
  end: number;
  files: FileMatch[];
  selectedIndex: number;
  loading: boolean;
};

type CommandAutocompleteState = {
  active: boolean;
  token: string;
  start: number;
  end: number;
  commands: CommandInfo[];
  selectedIndex: number;
  loading: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }) => escapeHtml(text);
markdownRenderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  const safeHref = sanitizeUrl(href);
  if (!safeHref) return label;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noreferrer noopener">${label}</a>`;
};
markdownRenderer.image = function ({ href, title, text }) {
  const safeHref = sanitizeUrl(href);
  if (!safeHref) return escapeHtml(text || "image");
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" />`;
};

function sanitizeUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.href);
    if (["http:", "https:", "mailto:", "file:"].includes(url.protocol)) return value;
  } catch {
    if (value.startsWith("#") || value.startsWith("/")) return value;
  }
  return null;
}

function renderMarkdown(value: string): string {
  return marked.parse(value, { async: false, gfm: true, breaks: false, renderer: markdownRenderer });
}

function formatToolCall(part: Record<string, unknown>): string {
  const name = String(part.name ?? part.toolName ?? "tool");
  const args = isRecord(part.arguments) ? part.arguments : isRecord(part.args) ? part.args : {};
  if (name === "read" && args.path) return `↳ read ${String(args.path)}${args.offset ? `:${String(args.offset)}` : ""}${args.limit ? `-${String(args.limit)}` : ""}`;
  if (name === "bash" && args.command) return `↳ bash ${String(args.command)}`;
  if ((name === "edit" || name === "write") && args.path) return `↳ ${name} ${String(args.path)}`;
  return `↳ ${name}`;
}

function formatToolTitle(name: unknown, args: unknown): string {
  const toolName = String(name ?? "tool");
  const toolArgs = isRecord(args) ? args : {};
  if (toolName === "bash" && toolArgs.command) return `$ ${String(toolArgs.command)}`;
  if (toolName === "read" && toolArgs.path) return `read ${String(toolArgs.path)}${toolArgs.offset ? `:${String(toolArgs.offset)}` : ""}${toolArgs.limit ? `-${String(toolArgs.limit)}` : ""}`;
  if ((toolName === "edit" || toolName === "write") && toolArgs.path) return `${toolName} ${String(toolArgs.path)}`;
  if (toolName === "grep" && toolArgs.pattern) return `grep ${String(toolArgs.pattern)}`;
  if (toolName === "find" && toolArgs.pattern) return `find ${String(toolArgs.pattern)}`;
  return toolName;
}

function toolContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((part) => {
      if (!isRecord(part)) return stringify(part);
      if (part.type === "text") return String(part.text ?? "");
      if (part.type === "image") return `[image${part.mimeType ? `: ${String(part.mimeType)}` : ""}]`;
      return stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultToText(result: unknown): string {
  if (!isRecord(result)) return stringify(result);
  const parts: string[] = [];
  if ("content" in result) parts.push(toolContentToText(result.content));
  if (isRecord(result.details)) {
    if (result.details.diff) parts.push(String(result.details.diff));
    if (result.details.stdout) parts.push(String(result.details.stdout));
    if (result.details.stderr) parts.push(String(result.details.stderr));
    if (result.details.exitCode !== undefined) parts.push(`exit code: ${String(result.details.exitCode)}`);
  }
  const text = parts.filter(Boolean).join("\n\n").trim();
  return text || stringify(result);
}

function toolArgsToText(args: unknown): string {
  if (!isRecord(args)) return stringify(args);
  if (Object.keys(args).length === 0) return "";
  return stringify(args);
}

function contentToSegments(content: unknown): TranscriptSegment[] {
  if (typeof content === "string") return [{ kind: "markdown", text: content }];
  if (!Array.isArray(content)) return [{ kind: "pre", text: stringify(content) }];

  return content.flatMap((part): TranscriptSegment[] => {
    if (!isRecord(part)) return [{ kind: "pre", text: stringify(part) }];
    if (part.type === "text" && String(part.text ?? "").trim()) return [{ kind: "markdown", text: String(part.text) }];
    if (part.type === "thinking" && String(part.thinking ?? "").trim()) return [{ kind: "thinking", text: String(part.thinking) }];
    if (part.type === "toolCall") return [{ kind: "toolCall", label: formatToolCall(part) }];
    if (part.type === "image") return [{ kind: "image", label: "[image]" }];
    return [];
  });
}

function contentToText(content: unknown): string {
  return contentToSegments(content)
    .map((segment) => "text" in segment ? segment.text : segment.label)
    .filter(Boolean)
    .join("\n\n");
}

function messageKey(message: Record<string, unknown>, fallback: string): string {
  const role = String(message.role ?? "message");
  const timestamp = message.timestamp ?? message.id;
  return timestamp ? `${role}:${String(timestamp)}` : fallback;
}

function messageToTranscriptItem(message: unknown, fallbackId: string): TranscriptItem {
  if (!isRecord(message)) {
    return { id: fallbackId, kind: "system", title: "Event", body: stringify(message) };
  }

  const role = String(message.role ?? "message");
  const segments = contentToSegments(message.content);
  const body = contentToText(message.content);
  if (role === "user") return { id: messageKey(message, fallbackId), kind: "user", title: "You", body, segments };
  if (role === "assistant") return { id: messageKey(message, fallbackId), kind: "assistant", title: "Pi", body, segments };
  if (role === "toolResult") {
    const details = isRecord(message.details) && message.details.diff ? `\n\n${String(message.details.diff)}` : "";
    return {
      id: messageKey(message, fallbackId),
      kind: "tool",
      title: `Tool result${message.toolName ? `: ${String(message.toolName)}` : ""}`,
      body: `${body}${details}`,
      status: message.isError ? "error" : "done",
    };
  }
  return { id: messageKey(message, fallbackId), kind: "system", title: role, body: body || stringify(message) };
}

class PiWebAgentApp extends HTMLElement {
  private token = localStorage.getItem("piWebAuthToken") ?? "";
  private apiBase = localStorage.getItem("piWebApiBase") ?? "http://127.0.0.1:3141";
  private sessions: WebSession[] = [];
  private workspaces: Workspace[] = [];
  private selectedSession: WebSession | null = null;
  private ws: WebSocket | null = null;
  private transcript: TranscriptItem[] = [];
  private status: AgentStatus = "disconnected";
  private notice = "";
  private controller: ControllerInfo | null = null;
  private settings: SessionRuntimeSettings | null = null;
  private lastSelectedSessionId = localStorage.getItem("piWebLastSessionId") ?? "";
  private autoScroll = localStorage.getItem("piWebAutoScroll") !== "false";
  private showThinking = localStorage.getItem("piWebShowThinking") === "true";
  private transcriptScrollTop = 0;
  private promptDraft = "";
  private fileAutocomplete: FileAutocompleteState = { active: false, token: "", start: 0, end: 0, files: [], selectedIndex: 0, loading: false };
  private fileAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private fileAutocompleteRequest = 0;
  private commandAutocomplete: CommandAutocompleteState = { active: false, token: "", start: 0, end: 0, commands: [], selectedIndex: 0, loading: false };
  private commandAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private commandAutocompleteRequest = 0;

  connectedCallback(): void {
    this.render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.ws?.close();
  }

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private upsertTranscript(item: TranscriptItem): void {
    const index = this.transcript.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) this.transcript.push(item);
    else this.transcript[index] = { ...this.transcript[index], ...item };
  }

  private async refresh(): Promise<void> {
    try {
      const [workspaces, sessions] = await Promise.all([
        this.api<Workspace[]>("/api/workspaces"),
        this.api<WebSession[]>("/api/sessions"),
      ]);
      this.workspaces = workspaces;
      this.sessions = sessions;
      this.notice = "";
      if (!this.selectedSession && this.lastSelectedSessionId) {
        const session = sessions.find((candidate) => candidate.id === this.lastSelectedSessionId);
        if (session) {
          this.openSession(session);
          return;
        }
      }
      this.render();
    } catch (error) {
      this.notice = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async createSession(): Promise<void> {
    const select = this.querySelector<HTMLSelectElement>("#workspace");
    const cwd = select?.value || this.workspaces[0]?.path;
    if (!cwd) return;
    try {
      const session = await this.api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session);
    } catch (error) {
      this.notice = `Create session failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private openSession(session: WebSession): void {
    this.selectedSession = session;
    this.lastSelectedSessionId = session.id;
    localStorage.setItem("piWebLastSessionId", session.id);
    this.transcript = [{ id: "opened", kind: "system", title: "Session", body: `Opened ${session.cwd}` }];
    this.status = "connecting";
    this.notice = "";
    this.controller = null;
    this.settings = null;
    this.transcriptScrollTop = 0;
    this.ws?.close();

    const url = new URL(`${this.apiBase}/api/sessions/${session.id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    const rememberedClientId = localStorage.getItem(`piWebClientId:${session.id}`);
    if (rememberedClientId) url.searchParams.set("clientId", rememberedClientId);

    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => {
      this.status = "connecting";
      this.render();
    });
    this.ws.addEventListener("message", (event) => this.handleSocketMessage(event.data as string));
    this.ws.addEventListener("close", () => {
      this.status = "disconnected";
      this.upsertTranscript({ id: `closed:${Date.now()}`, kind: "system", title: "Connection", body: "WebSocket closed" });
      this.render();
    });
    this.ws.addEventListener("error", () => {
      this.notice = "WebSocket error";
      this.render();
    });
    this.render();
  }

  private handleSocketMessage(raw: string): void {
    const data = JSON.parse(raw) as ServerEnvelope | HelloMessage;
    if (!("payload" in data)) {
      if (data.type === "hello") {
        localStorage.setItem(`piWebClientId:${data.sessionId}`, data.clientId);
        this.controller = { clientId: null, connectedClients: 1, currentClientId: data.clientId, isController: false };
        this.ws?.send(JSON.stringify({ type: "hello_ack", protocolVersion: PROTOCOL_VERSION, clientId: data.clientId }));
        this.render();
      }
      return;
    }

    const { payload } = data;
    if (payload.type === "session_snapshot") {
      this.status = payload.snapshot.status;
      this.controller = payload.snapshot.controller ?? this.controller;
      this.settings = payload.snapshot.settings ?? this.settings;
      this.transcript = payload.snapshot.messages.map((message, index) => messageToTranscriptItem(message, `snapshot:${index}`));
      if (this.transcript.length === 0) this.transcript.push({ id: "empty", kind: "system", title: "Session", body: "No messages yet." });
    } else if (payload.type === "agent_event") {
      this.applyAgentEvent(payload.event.data ?? payload.event);
    } else if (payload.type === "controller_update") {
      this.controller = payload.controller;
    } else if (payload.type === "settings_update") {
      this.settings = payload.settings;
    } else if (payload.type === "error") {
      this.upsertTranscript({ id: `error:${Date.now()}`, kind: "error", title: payload.code, body: payload.message });
    }
    this.render();
  }

  private applyAgentEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const type = String(event.type ?? "event");

    if (type === "agent_start" || type === "turn_start") this.status = "running";
    if (type === "agent_end" || type === "turn_end") this.status = "idle";

    if (type === "web_command_result") {
      this.upsertTranscript({
        id: String(event.id ?? `command:${Date.now()}`),
        kind: event.isError ? "error" : "system",
        title: String(event.title ?? "Slash command"),
        body: String(event.body ?? ""),
      });
      return;
    }

    if ((type === "message_start" || type === "message_update" || type === "message_end") && isRecord(event.message)) {
      const fallback = type === "message_update" ? "assistant:live" : `${type}:${Date.now()}`;
      const item = messageToTranscriptItem(event.message, fallback);
      item.status = type === "message_update" ? "running" : "done";
      this.upsertTranscript(item);
      return;
    }

    if (type === "tool_execution_start") {
      this.upsertTranscript({
        id: `tool:${String(event.toolCallId ?? Date.now())}`,
        kind: "tool",
        title: formatToolTitle(event.toolName, event.args),
        body: toolArgsToText(event.args ?? {}),
        status: "running",
      });
      return;
    }

    if (type === "tool_execution_update") {
      const partialText = toolResultToText(event.partialResult ?? {});
      this.upsertTranscript({
        id: `tool:${String(event.toolCallId ?? Date.now())}`,
        kind: "tool",
        title: formatToolTitle(event.toolName, event.args),
        body: partialText || toolArgsToText(event.args ?? {}),
        status: "running",
      });
      return;
    }

    if (type === "tool_execution_end") {
      const id = `tool:${String(event.toolCallId ?? Date.now())}`;
      const existing = this.transcript.find((item) => item.id === id);
      this.upsertTranscript({
        id,
        kind: "tool",
        title: existing?.title ?? formatToolTitle(event.toolName, {}),
        body: toolResultToText(event.result ?? {}),
        status: event.isError ? "error" : "done",
      });
      return;
    }

    if (type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
      this.upsertTranscript({ id: "queue", kind: "system", title: "Queue", body: `${steering} steer / ${followUp} follow-up queued` });
    }
  }

  private sendClientMessage(type: "prompt" | "steer" | "follow_up"): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim();
    if (!input || !text || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, text }));
    this.promptDraft = "";
    this.closeFileAutocomplete();
    this.closeCommandAutocomplete();
    input.value = "";
  }

  private sendFromInput(followUp = false): void {
    if (this.status === "running") this.sendClientMessage(followUp ? "follow_up" : "steer");
    else this.sendClientMessage("prompt");
  }

  private abort(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "abort" }));
  }

  private takeControl(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "take_control" }));
  }

  private getFileToken(input: HTMLTextAreaElement): { token: string; start: number; end: number } | null {
    const end = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, end);
    const match = /(^|\s)@([^\s]*)$/.exec(beforeCursor);
    if (!match) return null;
    return { token: match[2] ?? "", start: end - (match[2]?.length ?? 0) - 1, end };
  }

  private getCommandToken(input: HTMLTextAreaElement): { token: string; start: number; end: number } | null {
    const end = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, end);
    const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
    const line = beforeCursor.slice(lineStart);
    const match = /^\/([^\s]*)$/.exec(line);
    if (!match) return null;
    return { token: match[1] ?? "", start: lineStart, end };
  }

  private updatePromptDraft(input: HTMLTextAreaElement): void {
    this.promptDraft = input.value;
    this.updateCommandAutocomplete(input);
    this.updateFileAutocomplete(input);
  }

  private updateFileAutocomplete(input: HTMLTextAreaElement): void {
    const token = this.getFileToken(input);
    if (!token || !this.selectedSession) {
      const wasActive = this.fileAutocomplete.active;
      this.closeFileAutocomplete();
      if (wasActive) this.render();
      return;
    }

    if (this.commandAutocomplete.active) this.closeCommandAutocomplete();
    this.fileAutocomplete = { ...this.fileAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    this.render();
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    const requestId = ++this.fileAutocompleteRequest;
    this.fileAutocompleteTimer = setTimeout(() => void this.fetchFileAutocomplete(token, requestId), 120);
  }

  private async fetchFileAutocomplete(token: { token: string; start: number; end: number }, requestId: number): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const pathLike = token.token.includes("/") || token.token.startsWith(".");
      const response = pathLike
        ? await this.api<FileCompleteResponse>(`/api/sessions/${this.selectedSession.id}/files/complete?prefix=${encoded}&limit=20`)
        : await this.api<FileSearchResponse>(`/api/sessions/${this.selectedSession.id}/files/search?q=${encoded}&limit=20`);
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        files: response.files,
        selectedIndex: 0,
        loading: false,
      };
      this.render();
    } catch (error) {
      if (requestId !== this.fileAutocompleteRequest) return;
      this.fileAutocomplete = { ...this.fileAutocomplete, loading: false, files: [] };
      this.notice = `File autocomplete failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private closeFileAutocomplete(): void {
    if (this.fileAutocompleteTimer) clearTimeout(this.fileAutocompleteTimer);
    this.fileAutocompleteRequest++;
    this.fileAutocomplete = { active: false, token: "", start: 0, end: 0, files: [], selectedIndex: 0, loading: false };
  }

  private updateCommandAutocomplete(input: HTMLTextAreaElement): void {
    const token = this.getCommandToken(input);
    if (!token || !this.selectedSession) {
      const wasActive = this.commandAutocomplete.active;
      this.closeCommandAutocomplete();
      if (wasActive) this.render();
      return;
    }

    if (this.fileAutocomplete.active) this.closeFileAutocomplete();
    this.commandAutocomplete = { ...this.commandAutocomplete, active: true, token: token.token, start: token.start, end: token.end, loading: true };
    this.render();
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    const requestId = ++this.commandAutocompleteRequest;
    this.commandAutocompleteTimer = setTimeout(() => void this.fetchCommandAutocomplete(token, requestId), 120);
  }

  private async fetchCommandAutocomplete(token: { token: string; start: number; end: number }, requestId: number): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const encoded = encodeURIComponent(token.token);
      const response = await this.api<CommandResponse>(`/api/sessions/${this.selectedSession.id}/commands?q=${encoded}&limit=20`);
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = {
        active: true,
        token: token.token,
        start: token.start,
        end: token.end,
        commands: response.commands,
        selectedIndex: 0,
        loading: false,
      };
      this.render();
    } catch (error) {
      if (requestId !== this.commandAutocompleteRequest) return;
      this.commandAutocomplete = { ...this.commandAutocomplete, loading: false, commands: [] };
      this.notice = `Command autocomplete failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private closeCommandAutocomplete(): void {
    if (this.commandAutocompleteTimer) clearTimeout(this.commandAutocompleteTimer);
    this.commandAutocompleteRequest++;
    this.commandAutocomplete = { active: false, token: "", start: 0, end: 0, commands: [], selectedIndex: 0, loading: false };
  }

  private chooseCommandAutocomplete(index = this.commandAutocomplete.selectedIndex): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.commandAutocomplete.commands[index];
    if (!input || !choice) return;
    const inserted = `/${choice.name}`;
    const before = this.promptDraft.slice(0, this.commandAutocomplete.start);
    const after = this.promptDraft.slice(this.commandAutocomplete.end);
    this.promptDraft = `${before}${inserted} ${after}`;
    input.value = this.promptDraft;
    const cursor = before.length + inserted.length + 1;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    this.closeCommandAutocomplete();
    this.render();
  }

  private chooseFileAutocomplete(index = this.fileAutocomplete.selectedIndex): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const choice = this.fileAutocomplete.files[index];
    if (!input || !choice) return;
    const suffix = choice.type === "directory" ? "/" : "";
    const inserted = `@${choice.path}${suffix}`;
    const spacer = choice.type === "directory" ? "" : " ";
    const before = this.promptDraft.slice(0, this.fileAutocomplete.start);
    const after = this.promptDraft.slice(this.fileAutocomplete.end);
    this.promptDraft = `${before}${inserted}${spacer}${after}`;
    input.value = this.promptDraft;
    const cursor = before.length + inserted.length + spacer.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (choice.type === "directory") this.updateFileAutocomplete(input);
    else {
      this.closeFileAutocomplete();
      this.render();
    }
  }

  private setModel(model: string): void {
    if (model && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_model", model }));
  }

  private setThinking(level: string): void {
    if (level && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "set_thinking", level }));
  }

  private bindEvents(): void {
    this.querySelector<HTMLButtonElement>("#saveSettings")?.addEventListener("click", () => {
      const apiBase = this.querySelector<HTMLInputElement>("#apiBase")?.value.trim();
      const token = this.querySelector<HTMLInputElement>("#token")?.value.trim() ?? "";
      if (apiBase) {
        this.apiBase = apiBase;
        localStorage.setItem("piWebApiBase", apiBase);
      }
      this.token = token;
      localStorage.setItem("piWebAuthToken", token);
      void this.refresh();
    });
    this.querySelector<HTMLButtonElement>("#newSession")?.addEventListener("click", () => void this.createSession());
    this.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", () => this.sendFromInput(false));
    this.querySelector<HTMLButtonElement>("#followUp")?.addEventListener("click", () => this.sendFromInput(true));
    this.querySelector<HTMLButtonElement>("#abort")?.addEventListener("click", () => this.abort());
    this.querySelector<HTMLButtonElement>("#takeControl")?.addEventListener("click", () => this.takeControl());
    this.querySelector<HTMLInputElement>("#autoScroll")?.addEventListener("change", (event) => {
      this.autoScroll = (event.currentTarget as HTMLInputElement).checked;
      localStorage.setItem("piWebAutoScroll", String(this.autoScroll));
      if (this.autoScroll) this.scrollTranscriptToBottom();
    });
    this.querySelector<HTMLInputElement>("#showThinking")?.addEventListener("change", (event) => {
      this.showThinking = (event.currentTarget as HTMLInputElement).checked;
      localStorage.setItem("piWebShowThinking", String(this.showThinking));
      this.render();
    });
    this.querySelector<HTMLSelectElement>("#model")?.addEventListener("change", (event) => this.setModel((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLSelectElement>("#thinking")?.addEventListener("change", (event) => this.setThinking((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => this.updatePromptDraft(event.currentTarget as HTMLTextAreaElement));
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("blur", () => {
      window.setTimeout(() => {
        const focused = this.querySelector(":focus");
        if (focused?.id === "prompt" || focused?.closest(".file-autocomplete") || focused?.closest(".command-autocomplete")) return;
        this.closeFileAutocomplete();
        this.closeCommandAutocomplete();
        this.render();
      }, 120);
    });
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("keydown", (event) => {
      if (this.commandAutocomplete.active) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const count = Math.max(1, this.commandAutocomplete.commands.length);
          this.commandAutocomplete.selectedIndex = (this.commandAutocomplete.selectedIndex + direction + count) % count;
          this.render();
          return;
        }
        if ((event.key === "Tab" || event.key === "Enter") && this.commandAutocomplete.commands.length > 0) {
          event.preventDefault();
          this.chooseCommandAutocomplete();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeCommandAutocomplete();
          this.render();
          return;
        }
      }
      if (this.fileAutocomplete.active) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          const count = Math.max(1, this.fileAutocomplete.files.length);
          this.fileAutocomplete.selectedIndex = (this.fileAutocomplete.selectedIndex + direction + count) % count;
          this.render();
          return;
        }
        if ((event.key === "Tab" || event.key === "Enter") && this.fileAutocomplete.files.length > 0) {
          event.preventDefault();
          this.chooseFileAutocomplete();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          this.closeFileAutocomplete();
          this.render();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.sendFromInput(event.altKey);
      }
    });
    this.querySelector<HTMLElement>(".transcript")?.addEventListener("scroll", (event) => {
      this.transcriptScrollTop = (event.currentTarget as HTMLElement).scrollTop;
    });
    this.querySelectorAll<HTMLButtonElement>("[data-session-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const session = this.sessions.find((candidate) => candidate.id === button.dataset.sessionId);
        if (session) this.openSession(session);
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-file-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseFileAutocomplete(Number(button.dataset.fileIndex ?? "0")));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-command-index]").forEach((button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.chooseCommandAutocomplete(Number(button.dataset.commandIndex ?? "0")));
    });
  }

  private renderSegments(item: TranscriptItem): string {
    const segments = item.segments?.length ? item.segments : [{ kind: item.kind === "tool" || item.kind === "system" || item.kind === "error" ? "pre" : "markdown", text: item.body } satisfies TranscriptSegment];
    return segments
      .map((segment) => {
        if (segment.kind === "markdown") return `<div class="markdown-body">${renderMarkdown(segment.text)}</div>`;
        if (segment.kind === "thinking") {
          const content = this.showThinking ? renderMarkdown(segment.text) : "<p>Thinking...</p>";
          return `<div class="markdown-body thinking-trace">${content}</div>`;
        }
        if (segment.kind === "toolCall") return `<div class="inline-tool-call">${escapeHtml(segment.label)}</div>`;
        if (segment.kind === "image") return `<div class="inline-image">${escapeHtml(segment.label)}</div>`;
        return `<pre>${escapeHtml(segment.text)}</pre>`;
      })
      .join("");
  }

  private renderCommandAutocomplete(): string {
    if (!this.commandAutocomplete.active) return "";
    const title = this.commandAutocomplete.loading
      ? "Loading commands..."
      : this.commandAutocomplete.commands.length === 0
        ? "No command matches"
        : "Slash commands";
    return `
      <div class="command-autocomplete" role="listbox" aria-label="Slash command autocomplete">
        <div class="file-autocomplete-title">${escapeHtml(title)} <kbd>Tab</kbd>/<kbd>Enter</kbd> to insert</div>
        ${this.commandAutocomplete.commands.map((command, index) => `
          <button type="button" role="option" data-command-index="${index}" class="${index === this.commandAutocomplete.selectedIndex ? "selected" : ""}">
            <span class="command-name">/${escapeHtml(command.name)}</span>
            <span class="command-meta">
              <strong>${escapeHtml(command.source)}${command.unsupported ? " · UI-only/unsupported" : ""}</strong>
              ${command.argumentHint ? `<em>${escapeHtml(command.argumentHint)}</em>` : ""}
              ${command.description ? `<small>${escapeHtml(command.description)}</small>` : ""}
            </span>
          </button>`).join("")}
      </div>`;
  }

  private renderFileAutocomplete(): string {
    if (!this.fileAutocomplete.active) return "";
    const title = this.fileAutocomplete.loading
      ? "Searching files..."
      : this.fileAutocomplete.files.length === 0
        ? "No file matches"
        : "File matches";
    return `
      <div class="file-autocomplete" role="listbox" aria-label="File autocomplete">
        <div class="file-autocomplete-title">${escapeHtml(title)} <kbd>Tab</kbd>/<kbd>Enter</kbd> to insert</div>
        ${this.fileAutocomplete.files.map((file, index) => `
          <button type="button" role="option" data-file-index="${index}" class="${index === this.fileAutocomplete.selectedIndex ? "selected" : ""}">
            <span>${file.type === "directory" ? "📁" : "📄"}</span>
            <strong>${escapeHtml(file.path)}${file.type === "directory" ? "/" : ""}</strong>
          </button>`).join("")}
      </div>`;
  }

  private renderTranscript(): string {
    return this.transcript
      .map((item) => {
        const status = item.status ? `<span>${escapeHtml(item.status)}</span>` : "";
        const isCollapsible = item.kind === "tool" || item.kind === "system";
        const isOpen = item.status === "running" || item.status === "error";
        if (isCollapsible) {
          return `
            <details class="message ${item.kind} ${item.status ?? ""}" ${isOpen ? "open" : ""}>
              <summary class="message-header"><strong>${escapeHtml(item.title)}</strong>${status}</summary>
              ${this.renderSegments(item)}
            </details>`;
        }
        return `
          <article class="message ${item.kind} ${item.status ?? ""}">
            <div class="message-header"><strong>${escapeHtml(item.title)}</strong>${status}</div>
            ${this.renderSegments(item)}
          </article>`;
      })
      .join("");
  }

  private scrollTranscriptToBottom(): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    this.transcriptScrollTop = transcript.scrollTop;
  }

  private scheduleTranscriptFollow(): void {
    this.scrollTranscriptToBottom();
    requestAnimationFrame(() => {
      this.scrollTranscriptToBottom();
      requestAnimationFrame(() => this.scrollTranscriptToBottom());
    });
    window.setTimeout(() => this.scrollTranscriptToBottom(), 50);
  }

  private syncTranscriptScroll(): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    if (!this.autoScroll) {
      transcript.scrollTop = this.transcriptScrollTop;
      return;
    }

    this.scheduleTranscriptFollow();
  }

  private syncAutocompleteScroll(): void {
    const selector = this.commandAutocomplete.active ? ".command-autocomplete" : this.fileAutocomplete.active ? ".file-autocomplete" : null;
    if (!selector) return;
    const container = this.querySelector<HTMLElement>(selector);
    const selected = container?.querySelector<HTMLElement>("button.selected");
    if (!container || !selected) return;

    const selectedTop = selected.offsetTop;
    const selectedBottom = selectedTop + selected.offsetHeight;
    const visibleTop = container.scrollTop;
    const visibleBottom = visibleTop + container.clientHeight;
    if (selectedTop < visibleTop) container.scrollTop = selectedTop;
    else if (selectedBottom > visibleBottom) container.scrollTop = selectedBottom - container.clientHeight;
  }

  private render(): void {
    const existingTranscript = this.querySelector<HTMLElement>(".transcript");
    if (existingTranscript) this.transcriptScrollTop = existingTranscript.scrollTop;
    const prompt = this.querySelector<HTMLTextAreaElement>("#prompt");
    const restorePromptFocus = document.activeElement === prompt;
    const promptSelectionStart = prompt?.selectionStart ?? this.promptDraft.length;
    const promptSelectionEnd = prompt?.selectionEnd ?? promptSelectionStart;
    const isRunning = this.status === "running";
    const isController = this.controller?.isController ?? true;
    const controllerLabel = this.controller
      ? `${this.controller.isController ? "controller" : "viewer"} · ${this.controller.connectedClients} client${this.controller.connectedClients === 1 ? "" : "s"}`
      : "";
    const currentModelId = this.settings?.model?.id ?? "";
    this.innerHTML = `
      <aside>
        <h1>Pi Web Agent</h1>
        <label>API <input id="apiBase" value="${escapeHtml(this.apiBase)}" /></label>
        <label>Token <input id="token" type="password" value="${escapeHtml(this.token)}" /></label>
        <button id="saveSettings">Save / Refresh</button>
        ${this.notice ? `<p class="notice">${escapeHtml(this.notice)}</p>` : ""}
        <hr />
        <label>Workspace
          <select id="workspace">
            ${this.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
          </select>
        </label>
        <button id="newSession">New session</button>
        <h2>Sessions</h2>
        <div class="sessions">
          ${this.sessions.map((session) => `<button data-session-id="${escapeHtml(session.id)}" class="${session.id === this.selectedSession?.id ? "active" : ""}">${escapeHtml(session.title ?? session.cwd)}<small>${escapeHtml(session.id)}</small></button>`).join("")}
        </div>
      </aside>
      <main>
        <header>
          <strong>${this.selectedSession ? escapeHtml(this.selectedSession.cwd) : "Create or open a session"}</strong>
          <div class="header-status">
            ${controllerLabel ? `<span class="controller ${isController ? "" : "viewer"}">${escapeHtml(controllerLabel)}</span>` : ""}
            ${!isController ? `<button id="takeControl">Take control</button>` : ""}
            <label class="inline-control autoscroll"><input id="autoScroll" type="checkbox" ${this.autoScroll ? "checked" : ""} /> Auto-scroll</label>
            <label class="inline-control"><input id="showThinking" type="checkbox" ${this.showThinking ? "checked" : ""} /> Show thinking</label>
            ${this.settings ? `<label class="inline-control">Model
              <select id="model" ${isController ? "" : "disabled"}>
                ${this.settings.availableModels.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === currentModelId ? "selected" : ""}>${escapeHtml(model.name ?? model.id)} [${escapeHtml(model.provider)}]</option>`).join("")}
              </select>
            </label>
            <label class="inline-control">Thinking
              <select id="thinking" ${isController ? "" : "disabled"}>
                ${this.settings.availableThinkingLevels.map((level) => `<option value="${escapeHtml(level)}" ${level === this.settings?.thinkingLevel ? "selected" : ""}>${escapeHtml(level)}</option>`).join("")}
              </select>
            </label>` : ""}
            <span class="status ${escapeHtml(this.status)}">${escapeHtml(this.status)}</span>
          </div>
        </header>
        <section class="transcript">${this.renderTranscript()}</section>
        <footer>
          <div class="prompt-shell">
            <textarea id="prompt" ${isController ? "" : "disabled"} placeholder="${isController ? (isRunning ? "Steer pi... (Alt+Enter for follow-up). Type / for commands or @ for files." : "Prompt pi... Type / for commands or @ for files.") : "Viewer mode — take control to send"}">${escapeHtml(this.promptDraft)}</textarea>
            ${this.renderCommandAutocomplete()}
            ${this.renderFileAutocomplete()}
          </div>
          <div class="controls">
            <button id="send" ${isController ? "" : "disabled"}>${isRunning ? "Steer" : "Send"}</button>
            <button id="followUp" class="${isRunning ? "" : "hidden"}" ${isController ? "" : "disabled"}>Follow-up</button>
            <button id="abort" class="${isRunning ? "danger" : "hidden"}" ${isController ? "" : "disabled"}>Abort</button>
          </div>
        </footer>
      </main>
    `;
    this.bindEvents();
    if (restorePromptFocus) {
      const nextPrompt = this.querySelector<HTMLTextAreaElement>("#prompt");
      nextPrompt?.focus();
      const max = nextPrompt?.value.length ?? 0;
      nextPrompt?.setSelectionRange(Math.min(promptSelectionStart, max), Math.min(promptSelectionEnd, max));
    }
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
  }
}

customElements.define("pi-web-agent", PiWebAgentApp);
