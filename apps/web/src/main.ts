import { marked } from "marked";
import { PROTOCOL_VERSION, type AppSettings, type CommandInfo, type CommandResponse, type ContextUsage, type ControllerInfo, type FileCompleteResponse, type FileMatch, type FileSearchResponse, type HelloMessage, type NavigateTreeResponse, type ServerEnvelope, type SessionMetadataSuggestion, type SessionRuntimeSettings, type SessionSnapshot, type SessionTreeNode, type SessionTreeResponse, type WebSession, type Workspace } from "@pi-web-agent/protocol";
import "./styles.css";

type AgentStatus = SessionSnapshot["status"] | "disconnected" | "connecting";
type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected" | "retry_failed";
type TranscriptKind = "user" | "assistant" | "tool" | "system" | "error";
type TranscriptSegment =
  | { kind: "markdown"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; label: string }
  | { kind: "image"; label: string; src?: string }
  | { kind: "pre"; text: string };

type TranscriptItem = {
  id: string;
  kind: TranscriptKind;
  title: string;
  body: string;
  segments?: TranscriptSegment[];
  status?: "running" | "done" | "error";
  raw?: unknown;
};

type RenderContext = {
  cache?: Map<string, string> | undefined;
  localImageUrl?: ((path: string) => string | null) | undefined;
  suppressLocalImageArtifactPaths?: Set<string> | undefined;
};

type RightPanelTab = "details" | "preview" | "tree";
type TranscriptRowAction = "copy" | "details" | "preview" | "fork";
type ToolGroupPosition = "single" | "start" | "middle" | "end";

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

type PromptImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};

type RunningQueueItem = {
  text: string;
  imageCount: number | undefined;
};

type RunningQueueState = {
  steering: RunningQueueItem[];
  followUp: RunningQueueItem[];
};

type BrowserPerfMetrics = {
  renderCount: number;
  renderMs: number[];
  patchCount: number;
  patchMs: number[];
  rowUpdateCount: number;
  rowUpdateMs: number[];
};

declare global {
  interface Window {
    __piWebPerf?: BrowserPerfMetrics;
  }
}

function recordPerfSample(kind: "render" | "patch" | "rowUpdate", ms: number): void {
  const perf = window.__piWebPerf ??= { renderCount: 0, renderMs: [], patchCount: 0, patchMs: [], rowUpdateCount: 0, rowUpdateMs: [] };
  perf.rowUpdateCount ??= 0;
  perf.rowUpdateMs ??= [];
  if (kind === "render") {
    perf.renderCount++;
    perf.renderMs.push(ms);
    if (perf.renderMs.length > 500) perf.renderMs.shift();
  } else if (kind === "patch") {
    perf.patchCount++;
    perf.patchMs.push(ms);
    if (perf.patchMs.length > 500) perf.patchMs.shift();
  } else {
    perf.rowUpdateCount++;
    perf.rowUpdateMs.push(ms);
    if (perf.rowUpdateMs.length > 500) perf.rowUpdateMs.shift();
  }
}

function cleanTitleInput(value: string): string {
  return value.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function isGenericSessionPrompt(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:ok(?:ay)?|sure|sounds good|let'?s do it|go on|continue|what'?s next|what next|next|next up|next thing|okay next thing|alright what'?s next|nice what'?s next)(?: please)?$/.test(normalized);
}

function provisionalTitleFromPrompt(value: string): string | null {
  const cleaned = cleanTitleInput(value);
  return cleaned && !isGenericSessionPrompt(cleaned) && cleaned.length >= 8 ? cleaned : null;
}

const supportedPromptImageTypes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);
const maxPromptImages = 4;
const maxPromptImageBytes = 8 * 1024 * 1024;

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

function relativeTime(value: string | undefined): string {
  if (!value) return "never";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

function pathBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function pathParent(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : path;
}

function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function contextUsageLabel(usage: ContextUsage): string {
  const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(usage.percent >= 10 ? 0 : 1)}%`;
  return `${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} (${percent})`;
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
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) return value.replace(/\s/g, "");
  try {
    const url = new URL(value, window.location.href);
    if (["http:", "https:", "mailto:", "file:"].includes(url.protocol)) return value;
  } catch {
    if (value.startsWith("#") || value.startsWith("/")) return value;
  }
  return null;
}

function imagePartToSegment(part: Record<string, unknown>): TranscriptSegment {
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : typeof part.mediaType === "string" ? part.mediaType : "image/png";
  const label = `[image${mimeType ? `: ${mimeType}` : ""}]`;
  const rawUrl = typeof part.url === "string" ? part.url : typeof part.src === "string" ? part.src : undefined;
  const rawData = typeof part.data === "string" ? part.data : typeof part.base64 === "string" ? part.base64 : undefined;
  const candidate = rawUrl ?? (rawData ? `data:${mimeType};base64,${rawData}` : undefined);
  const src = candidate ? sanitizeUrl(candidate) : null;
  return src ? { kind: "image", label, src } : { kind: "image", label };
}

function renderMarkdown(value: string): string {
  return marked.parse(value, { async: false, gfm: true, breaks: false, renderer: markdownRenderer });
}

const localImagePathPattern = /(?:^|[\s([{"'`])((?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.(?:png|jpe?g|gif|webp|svg))(?![\w.-])/gi;

function localImageArtifacts(text: string, localImageUrl?: RenderContext["localImageUrl"], suppressedPaths = new Set<string>()): Array<{ path: string; url: string }> {
  if (!localImageUrl) return [];
  const seen = new Set<string>();
  const artifacts: Array<{ path: string; url: string }> = [];
  for (const match of text.matchAll(localImagePathPattern)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path || path.includes("...") || path.includes("…") || seen.has(path) || suppressedPaths.has(path)) continue;
    const url = localImageUrl(path);
    if (!url) continue;
    seen.add(path);
    artifacts.push({ path, url });
    if (artifacts.length >= 12) break;
  }
  return artifacts;
}

function renderLocalImageArtifacts(text: string, localImageUrl?: RenderContext["localImageUrl"], suppressedPaths?: Set<string>): string {
  const artifacts = localImageArtifacts(text, localImageUrl, suppressedPaths);
  if (artifacts.length === 0) return "";
  return `<div class="artifact-image-grid">${artifacts.map((artifact) => `
    <figure class="artifact-image">
      <img src="${escapeHtml(artifact.url)}" alt="${escapeHtml(artifact.path)}" loading="lazy" onerror="this.closest('figure')?.remove()" />
      <figcaption title="${escapeHtml(artifact.path)}">${escapeHtml(artifact.path)}</figcaption>
    </figure>`).join("")}</div>`;
}

function looksLikeHtml(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<body[\s>]|<article[\s>]|<section[\s>]|<div[\s>])/i.test(value);
}

function looksLikeSvg(value: string): boolean {
  return /^\s*<svg[\s>]/i.test(value);
}

function looksLikeMarkdown(value: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s+|(^|\n)\s*[-*+]\s+|(^|\n)\s*```|\[[^\]]+\]\([^)]+\)/.test(value);
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

function toolTextToSegment(text: string): TranscriptSegment {
  return /!\[[^\]]*\]\((?:data:image\/|https?:\/\/|file:|\/)[^)]+\)/i.test(text)
    ? { kind: "markdown", text }
    : { kind: "pre", text };
}

function toolResultToSegments(result: unknown): TranscriptSegment[] {
  if (!isRecord(result) || !("content" in result)) return [];
  const content = result.content;
  if (typeof content === "string") return [toolTextToSegment(content)];
  if (!Array.isArray(content)) return [{ kind: "pre", text: stringify(content) }];
  return content.flatMap((part): TranscriptSegment[] => {
    if (!isRecord(part)) return [{ kind: "pre", text: stringify(part) }];
    if (part.type === "text" && String(part.text ?? "").trim()) return [toolTextToSegment(String(part.text))];
    if (part.type === "image") return [imagePartToSegment(part)];
    return [];
  });
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
    if (part.type === "image") return [imagePartToSegment(part)];
    return [];
  });
}

function contentToText(content: unknown): string {
  return contentToSegments(content)
    .map((segment) => "text" in segment ? segment.text : segment.label)
    .filter(Boolean)
    .join("\n\n");
}

function itemHasRenderedImage(item: TranscriptItem): boolean {
  return Boolean(item.segments?.some((segment) => segment.kind === "image" && segment.src));
}

function itemHasLocalImageArtifacts(item: TranscriptItem, localImageUrl?: RenderContext["localImageUrl"], suppressedPaths?: Set<string>): boolean {
  if (!localImageUrl) return false;
  return Boolean((item.segments?.length ? item.segments : [{ kind: "pre", text: item.body } satisfies TranscriptSegment])
    .some((segment) => "text" in segment && localImageArtifacts(segment.text, localImageUrl, suppressedPaths).length > 0));
}

function isToolCallOnlyAssistant(item: TranscriptItem): boolean {
  const segments = item.segments;
  return item.kind === "assistant" && segments !== undefined && segments.length > 0 && segments.every((segment) => segment.kind === "toolCall" || segment.kind === "thinking");
}

function toolCallTitlesForItem(item: TranscriptItem): string[] {
  return (item.segments ?? [])
    .filter((segment): segment is Extract<TranscriptSegment, { kind: "toolCall" }> => segment.kind === "toolCall")
    .map((segment) => toolCallLabelToTitle(segment.label));
}

function toolCallLabelToTitle(label: string): string {
  const clean = label.replace(/^↳\s*/, "").trim();
  const bash = clean.match(/^bash\s+(.+)$/s);
  if (bash) return `$ ${bash[1]?.trim() ?? "bash"}`;
  return clean || label;
}

function shouldPreferPendingToolTitle(item: TranscriptItem): boolean {
  return item.kind === "tool" && /^(?:tool result(?::|$)|tool$)/i.test(item.title.trim());
}

function compactSnapshotTranscript(items: TranscriptItem[]): TranscriptItem[] {
  const compacted: TranscriptItem[] = [];
  const pendingToolCallTitles: string[] = [];
  for (const item of items) {
    if (isToolCallOnlyAssistant(item)) {
      pendingToolCallTitles.push(...toolCallTitlesForItem(item));
      continue;
    }
    let nextItem = item;
    if (item.kind === "tool" && pendingToolCallTitles.length > 0) {
      const pendingTitle = pendingToolCallTitles.shift();
      if (pendingTitle && shouldPreferPendingToolTitle(item)) nextItem = { ...item, title: pendingTitle };
    } else if (item.kind !== "tool") {
      pendingToolCallTitles.length = 0;
    }
    const previous = compacted.at(-1);
    if (previous && mergeDuplicateToolResult(previous, nextItem)) continue;
    compacted.push(nextItem);
  }
  return compacted;
}

function compactToolSummary(item: TranscriptItem): string {
  if (item.kind !== "tool" || item.status !== "done") return "";
  const source = item.body || item.segments?.map((segment) => "text" in segment ? segment.text : segment.label).join("\n") || "";
  const lines = source
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const usefulLine = lines.find((part) => {
    if (/^exit code:\s*0$/i.test(part)) return false;
    if (/^(?:running|starting|completed?)\b.*\btool\b/i.test(part)) return false;
    if (/^(?:stdout|stderr):\s*$/i.test(part)) return false;
    return true;
  });
  const prefix = lines.length > 8 ? `${lines.length} lines: ` : "";
  if (!usefulLine) return lines.length > 0 ? `${lines.length} line${lines.length === 1 ? "" : "s"} output` : "completed";
  const normalized = usefulLine.replace(/^stdout:\s*/i, "").replace(/^stderr:\s*/i, "stderr: ").replace(/\s+/g, " ");
  const summary = `${prefix}${normalized}`;
  return summary.length > 140 ? `${summary.slice(0, 137)}…` : summary;
}

function normalizeToolTextForDedupe(value: string): string {
  return value
    .replace(/^exit code:\s*0\s*$/gim, "")
    .replace(/^(?:stdout|stderr):\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mergeDuplicateToolResult(previous: TranscriptItem, current: TranscriptItem): boolean {
  if (previous.kind !== "tool" || current.kind !== "tool" || previous.status !== "done" || current.status !== "done") return false;
  if (!/^(?:tool result(?::|$)|result(?::|$))/i.test(current.title.trim())) return false;
  if (itemHasRenderedImage(previous) || itemHasRenderedImage(current)) return false;

  const previousText = normalizeToolTextForDedupe(`${previous.body}\n${compactToolSummary(previous)}`);
  const currentText = normalizeToolTextForDedupe(`${current.body}\n${compactToolSummary(current)}`);
  if (!currentText) return false;
  if (!previousText || !previousText.includes(currentText.slice(0, Math.min(80, currentText.length)))) {
    if (previousText && currentText && previousText !== currentText && !currentText.includes(previousText.slice(0, Math.min(80, previousText.length)))) return false;
  }

  previous.body = previous.body || current.body;
  if (!previous.segments?.length && current.segments) previous.segments = current.segments;
  previous.raw = { previous: previous.raw, duplicateResult: current.raw };
  return true;
}

function renderTranscriptSegments(item: TranscriptItem, showThinking: boolean, context: RenderContext = {}): string {
  const suppressedKey = context.suppressLocalImageArtifactPaths ? Array.from(context.suppressLocalImageArtifactPaths).join("|") : "";
  const cacheKey = `${item.id}:${item.kind}:${item.status ?? ""}:${showThinking}:${item.body}:${context.localImageUrl ? "assets" : ""}:${suppressedKey}`;
  const cached = context.cache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const segments = item.segments?.length ? item.segments : [{ kind: item.kind === "tool" || item.kind === "system" || item.kind === "error" ? "pre" : "markdown", text: item.body } satisfies TranscriptSegment];
  const usePlainStreamingText = item.status === "running" && (item.kind === "assistant" || item.kind === "user");
  const rendered = segments
    .map((segment) => {
      if (segment.kind === "markdown") {
        if (usePlainStreamingText) return `<div class="markdown-body streaming-plain"><pre>${escapeHtml(segment.text)}</pre></div>`;
        return `<div class="markdown-body">${renderMarkdown(segment.text)}${renderLocalImageArtifacts(segment.text, context.localImageUrl, context.suppressLocalImageArtifactPaths)}</div>`;
      }
      if (segment.kind === "thinking") {
        const content = showThinking ? renderMarkdown(segment.text) : "<p>Thinking...</p>";
        return `<div class="markdown-body thinking-trace">${content}</div>`;
      }
      if (segment.kind === "toolCall") return `<div class="inline-tool-call">${escapeHtml(segment.label)}</div>`;
      if (segment.kind === "image") {
        return segment.src
          ? `<figure class="inline-image rendered-image"><img src="${escapeHtml(segment.src)}" alt="${escapeHtml(segment.label)}" loading="lazy" /><figcaption>${escapeHtml(segment.label)}</figcaption></figure>`
          : `<div class="inline-image">${escapeHtml(segment.label)}</div>`;
      }
      return `<pre class="${item.kind === "tool" ? "terminal-output" : ""}">${escapeHtml(segment.text)}</pre>${renderLocalImageArtifacts(segment.text, context.localImageUrl, context.suppressLocalImageArtifactPaths)}`;
    })
    .join("");
  if (context.cache) {
    if (context.cache.size > 300) context.cache.clear();
    context.cache.set(cacheKey, rendered);
  }
  return rendered;
}

class PiTranscriptRow extends HTMLElement {
  private item: TranscriptItem | null = null;
  private showThinking = false;
  private selected = false;
  private collapsed = false;
  private actionMenuOpen = false;
  private canFork = false;
  private toolGroupPosition: ToolGroupPosition = "single";
  private lastRenderKey = "";
  private lastStreamingText = "";

  connectedCallback(): void {
    this.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const expandableImage = target?.closest<HTMLElement>(".artifact-image, .rendered-image");
      if (expandableImage) {
        event.stopImmediatePropagation();
        expandableImage.classList.toggle("expanded");
        return;
      }
      if (target?.closest(".message-action-area")) return;
      if (target?.closest(".message-header") && this.isCollapsible()) {
        event.stopImmediatePropagation();
        this.collapsed = !this.collapsed;
        if (this.item) this.setState(this.item, { showThinking: this.showThinking, selected: this.selected, actionMenuOpen: this.actionMenuOpen, canFork: this.canFork });
        else this.classList.toggle("collapsed", this.collapsed);
      }
    });
  }

  setState(item: TranscriptItem, options: { showThinking: boolean; selected: boolean; actionMenuOpen?: boolean; canFork?: boolean; toolGroupPosition?: ToolGroupPosition; cache?: Map<string, string>; localImageUrl?: (path: string) => string | null; suppressLocalImageArtifactPaths?: Set<string> }): void {
    const start = performance.now();
    const previous = this.item;
    const wasSelected = this.selected;
    this.item = item;
    this.showThinking = options.showThinking;
    this.selected = options.selected;
    this.actionMenuOpen = options.actionMenuOpen ?? false;
    this.canFork = options.canFork ?? false;
    this.toolGroupPosition = options.toolGroupPosition ?? "single";
    const isCollapsible = this.isCollapsible();
    const defaultOpen = item.status === "running" || item.status === "error" || options.selected || itemHasRenderedImage(item) || itemHasLocalImageArtifacts(item, options.localImageUrl, options.suppressLocalImageArtifactPaths);
    const completedSuccessfully = previous?.id === item.id && previous.status === "running" && item.status === "done";
    if (!previous || previous.id !== item.id || completedSuccessfully) this.collapsed = isCollapsible && !defaultOpen;
    if (options.selected && !wasSelected) this.collapsed = false;

    this.dataset.transcriptId = item.id;
    this.className = this.classNames();

    const streamingText = this.streamingText();
    const canPatchText = Boolean(streamingText !== null && this.lastStreamingText !== "" && this.querySelector(".streaming-plain pre"));
    const compactSummary = this.collapsed ? compactToolSummary(item) : "";
    const renderKey = `${item.id}:${item.kind}:${item.title}:${item.status ?? ""}:${this.showThinking}:${this.selected}:${this.collapsed}:${isCollapsible}:${compactSummary}:${this.actionMenuOpen}:${this.canFork}:${this.toolGroupPosition}:${streamingText !== null ? "streaming" : item.body}`;
    if (canPatchText && renderKey === this.lastRenderKey && streamingText !== this.lastStreamingText) {
      this.querySelector<HTMLElement>(".streaming-plain pre")!.textContent = streamingText ?? "";
      this.lastStreamingText = streamingText ?? "";
      recordPerfSample("rowUpdate", performance.now() - start);
      return;
    }

    this.innerHTML = `
      <div class="message-header">
        <strong>${escapeHtml(item.title)}</strong>
        ${compactSummary ? `<span class="tool-summary">${escapeHtml(compactSummary)}</span>` : ""}
        <span class="message-header-spacer"></span>
        ${item.status ? `<span class="message-status">${escapeHtml(item.status)}</span>` : ""}
        <span class="message-action-area">
          <button class="message-overflow" type="button" data-row-action="menu" data-transcript-id="${escapeHtml(item.id)}" aria-haspopup="menu" aria-expanded="${this.actionMenuOpen ? "true" : "false"}" title="Message actions">⋯</button>
          ${this.actionMenuOpen ? this.renderActionMenu(item) : ""}
        </span>
      </div>
      <div class="message-body">${renderTranscriptSegments(item, this.showThinking, { cache: options.cache, localImageUrl: options.localImageUrl, suppressLocalImageArtifactPaths: options.suppressLocalImageArtifactPaths })}</div>`;
    this.pinRunningToolOutputToBottom(item);
    this.lastRenderKey = renderKey;
    this.lastStreamingText = streamingText ?? "";
    recordPerfSample("rowUpdate", performance.now() - start);
  }

  private pinRunningToolOutputToBottom(item: TranscriptItem): void {
    if (item.kind !== "tool" || item.status !== "running") return;
    const body = this.querySelector<HTMLElement>(".message-body");
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }

  private renderActionMenu(item: TranscriptItem): string {
    const previewable = item.body.trim().length > 0;
    return `
      <div class="message-action-menu" role="menu">
        <button type="button" role="menuitem" data-row-action="copy" data-transcript-id="${escapeHtml(item.id)}">Copy</button>
        <button type="button" role="menuitem" data-row-action="details" data-transcript-id="${escapeHtml(item.id)}">Details</button>
        ${previewable ? `<button type="button" role="menuitem" data-row-action="preview" data-transcript-id="${escapeHtml(item.id)}">Preview</button>` : ""}
        ${this.canFork ? `<button type="button" role="menuitem" data-row-action="fork" data-transcript-id="${escapeHtml(item.id)}">Fork from here</button>` : ""}
      </div>`;
  }

  private isCollapsible(): boolean {
    return this.item?.kind === "tool" || this.item?.kind === "system";
  }

  private classNames(): string {
    if (!this.item) return "message";
    const groupClass = this.item.kind === "tool" && this.item.status === "done" ? `tool-group-${this.toolGroupPosition}` : "";
    return ["message", this.item.kind, this.item.status ?? "", groupClass, this.selected ? "selected" : "", this.isCollapsible() ? "collapsible" : "", this.collapsed ? "collapsed" : ""].filter(Boolean).join(" ");
  }

  private streamingText(): string | null {
    if (!this.item || this.item.status !== "running" || (this.item.kind !== "assistant" && this.item.kind !== "user")) return null;
    const segments = this.item.segments?.length ? this.item.segments : [{ kind: "markdown", text: this.item.body } satisfies TranscriptSegment];
    const text = segments.filter((segment): segment is Extract<TranscriptSegment, { kind: "markdown" }> => segment.kind === "markdown").map((segment) => segment.text).join("\n\n");
    return text;
  }
}

customElements.define("pi-transcript-row", PiTranscriptRow);

function messageKey(message: Record<string, unknown>, fallback: string): string {
  const role = String(message.role ?? "message");
  const timestamp = message.timestamp ?? message.id;
  return timestamp ? `${role}:${String(timestamp)}` : fallback;
}

function messageToTranscriptItem(message: unknown, fallbackId: string): TranscriptItem {
  if (!isRecord(message)) {
    return { id: fallbackId, kind: "system", title: "Event", body: stringify(message), raw: message };
  }

  const role = String(message.role ?? "message");
  const segments = contentToSegments(message.content);
  const body = contentToText(message.content);
  if (role === "user") return { id: messageKey(message, fallbackId), kind: "user", title: "You", body, segments, raw: message };
  if (role === "assistant") return { id: messageKey(message, fallbackId), kind: "assistant", title: "Pi", body, segments, raw: message };
  if (role === "toolResult") {
    const details = isRecord(message.details) && message.details.diff ? `\n\n${String(message.details.diff)}` : "";
    return {
      id: messageKey(message, fallbackId),
      kind: "tool",
      title: `Tool result${message.toolName ? `: ${String(message.toolName)}` : ""}`,
      body: `${body}${details}`,
      segments,
      status: message.isError ? "error" : "done",
      raw: message,
    };
  }
  return { id: messageKey(message, fallbackId), kind: "system", title: role, body: body || stringify(message), raw: message };
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
  private connectionState: ConnectionState = "disconnected";
  private connectionMessage = "No session connected.";
  private notice = "";
  private controller: ControllerInfo | null = null;
  private settings: SessionRuntimeSettings | null = null;
  private appSettings: AppSettings | null = null;
  private metadataSuggestion: SessionMetadataSuggestion | null = null;
  private metadataSuggestionError = "";
  private metadataGenerating = false;
  private editingTitleDraft: string | null = null;
  private sessionTree: SessionTreeResponse | null = null;
  private treeDrawerOpen = false;
  private lastSelectedSessionId = localStorage.getItem("piWebLastSessionId") ?? "";
  private autoScroll = localStorage.getItem("piWebAutoScroll") !== "false";
  private showThinking = localStorage.getItem("piWebShowThinking") === "true";
  private sessionSidebarCollapsed = localStorage.getItem("piWebSessionSidebarCollapsed") === "true";
  private sessionSidebarPinned = localStorage.getItem("piWebSessionSidebarPinned") === "true";
  private showOlderSessions = localStorage.getItem("piWebShowOlderSessions") === "true";
  private rightPanelTab: RightPanelTab = (localStorage.getItem("piWebRightPanelTab") as RightPanelTab | null) ?? "details";
  private rightPanelCollapsed = localStorage.getItem("piWebRightPanelCollapsed") === "true";
  private selectedTranscriptId = localStorage.getItem("piWebSelectedTranscriptId") ?? "";
  private openActionMenuId = "";
  private pendingToolCallTitles: string[] = [];
  private transcriptScrollTop = 0;
  private preserveTranscriptScrollOnce = false;
  private unreadTranscriptIds = new Set<string>();
  private promptDraft = "";
  private promptImages: PromptImage[] = [];
  private runningQueue: RunningQueueState = { steering: [], followUp: [] };
  private runningQueueExpanded = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socketGeneration = 0;
  private fileAutocomplete: FileAutocompleteState = { active: false, token: "", start: 0, end: 0, files: [], selectedIndex: 0, loading: false };
  private fileAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private fileAutocompleteRequest = 0;
  private commandAutocomplete: CommandAutocompleteState = { active: false, token: "", start: 0, end: 0, commands: [], selectedIndex: 0, loading: false };
  private commandAutocompleteTimer: ReturnType<typeof setTimeout> | undefined;
  private commandAutocompleteRequest = 0;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollMonitorTimer: ReturnType<typeof setInterval> | undefined;
  private renderScheduled = false;
  private forceFullRender = false;
  private dirtyTranscriptIds = new Set<string>();
  private focusPromptOnNextReadyRender = false;
  private renderedSegmentCache = new Map<string, string>();
  private readonly beforeUnloadHandler = () => this.persistAttachmentWarningIfNeeded();

  connectedCallback(): void {
    window.addEventListener("beforeunload", this.beforeUnloadHandler);
    this.startScrollMonitor();
    this.render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.beforeUnloadHandler);
    this.persistAttachmentWarningIfNeeded();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.scrollMonitorTimer) clearInterval(this.scrollMonitorTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socketGeneration++;
    this.ws?.close();
  }

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }

  private localImageUrl(path: string): string | null {
    if (!this.selectedSession) return null;
    const normalized = path.replace(/^\.\//, "");
    if (!/^(?:[^/]+\/)+[^/]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalized)) return null;
    const url = new URL(`${this.apiBase}/api/sessions/${this.selectedSession.id}/files/raw`);
    url.searchParams.set("path", normalized);
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { ...init, headers: { ...this.headers(), ...init?.headers } });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private upsertTranscript(item: TranscriptItem): void {
    if (isToolCallOnlyAssistant(item)) {
      this.pendingToolCallTitles.push(...toolCallTitlesForItem(item));
      const existingIndex = this.transcript.findIndex((candidate) => candidate.id === item.id);
      if (existingIndex !== -1) {
        this.transcript.splice(existingIndex, 1);
        this.forceFullRender = true;
      }
      return;
    }

    let nextItem = item;
    if (nextItem.kind === "tool" && this.pendingToolCallTitles.length > 0) {
      const pendingTitle = this.pendingToolCallTitles.shift();
      if (pendingTitle && shouldPreferPendingToolTitle(nextItem)) nextItem = { ...nextItem, title: pendingTitle };
    } else if (nextItem.kind !== "tool") {
      this.pendingToolCallTitles.length = 0;
    }

    const index = this.transcript.findIndex((candidate) => candidate.id === nextItem.id);
    const previousForMerge = index === -1 ? this.transcript.at(-1) : this.transcript[index - 1];
    if (previousForMerge && mergeDuplicateToolResult(previousForMerge, nextItem)) {
      this.dirtyTranscriptIds.add(previousForMerge.id);
      return;
    }

    if (index === -1) this.transcript.push(nextItem);
    else this.transcript[index] = { ...this.transcript[index], ...nextItem };
    const nextIndex = index === -1 ? this.transcript.length - 1 : index;
    this.dirtyTranscriptIds.add(nextItem.id);
    const previous = this.transcript[nextIndex - 1];
    const next = this.transcript[nextIndex + 1];
    if (previous?.kind === "tool") this.dirtyTranscriptIds.add(previous.id);
    if (next?.kind === "tool") this.dirtyTranscriptIds.add(next.id);
    if (!this.autoScroll) this.unreadTranscriptIds.add(nextItem.id);
    if (!this.selectedTranscriptId) this.selectTranscriptItem(nextItem.id, false);
  }

  private draftKey(sessionId = this.selectedSession?.id): string | null {
    return sessionId ? `piWebPromptDraft:${sessionId}` : null;
  }

  private attachmentWarningKey(sessionId = this.selectedSession?.id): string | null {
    return sessionId ? `piWebPromptAttachmentWarning:${sessionId}` : null;
  }

  private savePromptDraft(): void {
    const key = this.draftKey();
    if (!key) return;
    if (this.promptDraft) localStorage.setItem(key, this.promptDraft);
    else localStorage.removeItem(key);
  }

  private loadPromptDraft(sessionId: string): string {
    return localStorage.getItem(`piWebPromptDraft:${sessionId}`) ?? "";
  }

  private persistAttachmentWarningIfNeeded(): void {
    const key = this.attachmentWarningKey();
    if (key && this.promptImages.length > 0) localStorage.setItem(key, "lost");
  }

  private async refresh(): Promise<void> {
    try {
      const [workspaces, sessions, appSettings] = await Promise.all([
        this.api<Workspace[]>("/api/workspaces"),
        this.api<WebSession[]>("/api/sessions"),
        this.api<AppSettings>("/api/settings"),
      ]);
      this.workspaces = workspaces;
      this.sessions = sessions;
      this.appSettings = appSettings;
      if (this.selectedSession) {
        const updated = sessions.find((candidate) => candidate.id === this.selectedSession?.id);
        if (updated) this.selectedSession = updated;
      }
      this.notice = "";
      if (!this.selectedSession && this.lastSelectedSessionId) {
        const session = sessions.find((candidate) => candidate.id === this.lastSelectedSessionId);
        if (session) {
          this.openSession(session, false);
          return;
        }
      }
      this.render();
    } catch (error) {
      this.notice = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async createSession(cwdOverride?: string): Promise<WebSession | null> {
    const select = this.querySelector<HTMLSelectElement>("#workspace");
    const cwd = cwdOverride || select?.value || this.workspaces[0]?.path;
    if (!cwd) return null;
    try {
      const session = await this.api<WebSession>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ cwd }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session, false);
      return session;
    } catch (error) {
      this.notice = `Create session failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
      return null;
    }
  }

  private openSession(session: WebSession, collapseSidebar = true): void {
    this.persistAttachmentWarningIfNeeded();
    this.selectedSession = session;
    if (collapseSidebar && !this.sessionSidebarPinned) this.sessionSidebarCollapsed = true;
    this.lastSelectedSessionId = session.id;
    localStorage.setItem("piWebLastSessionId", session.id);
    this.transcript = [{ id: "opened", kind: "system", title: "Session", body: `Opened ${session.cwd}` }];
    this.status = "connecting";
    const attachmentWarningKey = this.attachmentWarningKey(session.id);
    const hadLostAttachments = attachmentWarningKey ? localStorage.getItem(attachmentWarningKey) === "lost" : false;
    if (attachmentWarningKey) localStorage.removeItem(attachmentWarningKey);
    this.notice = hadLostAttachments ? "Image attachments are not restored after a refresh. Please attach them again before sending." : "";
    this.promptDraft = this.loadPromptDraft(session.id);
    this.promptImages = [];
    this.runningQueue = { steering: [], followUp: [] };
    this.autoScroll = true;
    localStorage.setItem("piWebAutoScroll", "true");
    this.controller = null;
    this.settings = null;
    this.sessionTree = null;
    this.treeDrawerOpen = false;
    this.transcriptScrollTop = 0;
    this.unreadTranscriptIds.clear();
    this.selectedTranscriptId = "opened";
    localStorage.setItem("piWebSelectedTranscriptId", this.selectedTranscriptId);
    this.socketGeneration++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.connectWebSocket(session, "connecting");
    this.render();
  }

  private connectWebSocket(session: WebSession, state: ConnectionState): void {
    const generation = ++this.socketGeneration;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectionState = state;
    this.connectionMessage = state === "reconnecting" ? `Reconnecting to ${session.id}...` : `Connecting to ${session.id}...`;
    this.status = this.status === "running" ? this.status : "connecting";

    const url = new URL(`${this.apiBase}/api/sessions/${session.id}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    const rememberedClientId = localStorage.getItem(`piWebClientId:${session.id}`);
    if (rememberedClientId) url.searchParams.set("clientId", rememberedClientId);

    const socket = new WebSocket(url);
    this.ws = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.socketGeneration) return;
      this.connectionState = state === "reconnecting" ? "reconnecting" : "connecting";
      this.connectionMessage = "Socket opened; waiting for session snapshot...";
      this.requestRender(0);
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.socketGeneration) return;
      this.handleSocketMessage(event.data as string);
    });
    socket.addEventListener("close", () => {
      if (generation !== this.socketGeneration) return;
      this.handleSocketClose(session);
    });
    socket.addEventListener("error", () => {
      if (generation !== this.socketGeneration) return;
      this.connectionMessage = "Connection error; retrying if possible.";
      this.requestRender(0);
    });
  }

  private handleSocketClose(session: WebSession): void {
    if (this.selectedSession?.id !== session.id) return;
    this.status = "disconnected";
    this.connectionState = "disconnected";
    this.connectionMessage = "Connection lost. Retrying shortly...";
    this.scheduleReconnect(session);
    this.requestRender(0);
  }

  private scheduleReconnect(session: WebSession): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt++;
    if (this.reconnectAttempt > 8) {
      this.connectionState = "retry_failed";
      this.connectionMessage = "Reconnect failed. Check whether the backend is running, then use Save / Refresh or reopen the session.";
      return;
    }
    const delay = Math.min(8_000, 500 * 2 ** Math.max(0, this.reconnectAttempt - 1));
    this.connectionState = "reconnecting";
    this.connectionMessage = `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt}/8)...`;
    this.reconnectTimer = setTimeout(() => {
      if (this.selectedSession?.id !== session.id) return;
      this.connectWebSocket(session, "reconnecting");
      this.requestRender(0);
    }, delay);
  }

  private applySnapshot(snapshot: SessionSnapshot): void {
    this.status = snapshot.status;
    this.selectedSession = snapshot.session;
    this.sessions = this.sessions.map((session) => session.id === snapshot.session.id ? snapshot.session : session);
    this.controller = snapshot.controller ?? this.controller;
    this.settings = snapshot.settings ?? this.settings;
    this.transcript = compactSnapshotTranscript(snapshot.messages.map((message, index) => messageToTranscriptItem(message, `snapshot:${index}`)));
    this.runningQueue = { steering: [], followUp: [] };
    this.pendingToolCallTitles = [];
    if (this.transcript.length === 0) this.transcript.push({ id: "empty", kind: "system", title: "Session", body: "No messages yet." });
    this.unreadTranscriptIds.clear();
    this.forceFullRender = true;
    this.dirtyTranscriptIds.clear();
    if (!this.transcript.some((item) => item.id === this.selectedTranscriptId)) this.selectTranscriptItem(this.transcript[this.transcript.length - 1]?.id ?? "", false);
    void this.refreshTree();
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
      this.connectionState = "connected";
      this.connectionMessage = "Connected.";
      this.reconnectAttempt = 0;
      this.applySnapshot(payload.snapshot);
    } else if (payload.type === "agent_event") {
      this.applyAgentEvent(payload.event.data ?? payload.event);
    } else if (payload.type === "controller_update") {
      this.controller = payload.controller;
    } else if (payload.type === "settings_update") {
      this.settings = payload.settings;
    } else if (payload.type === "session_metadata_update") {
      this.selectedSession = payload.session;
      this.sessions = this.sessions.map((session) => session.id === payload.session.id ? payload.session : session);
    } else if (payload.type === "error") {
      this.upsertTranscript({ id: `error:${Date.now()}`, kind: "error", title: payload.code, body: payload.message });
    }
    this.requestRender();
  }

  private applyAgentEvent(event: unknown): void {
    if (!isRecord(event)) return;
    const type = String(event.type ?? "event");
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (this.autoScroll && transcript && !this.isTranscriptNearBottom(transcript)) this.autoScroll = false;

    if (type === "agent_start" || type === "turn_start") {
      this.status = "running";
    }
    if (type === "agent_end" || type === "turn_end") {
      this.status = "idle";
      this.runningQueue = { steering: [], followUp: [] };
      void this.refreshTree();
    }

    if (type === "web_command_result") {
      this.upsertTranscript({
        id: String(event.id ?? `command:${Date.now()}`),
        kind: event.isError ? "error" : "system",
        title: String(event.title ?? "Slash command"),
        body: String(event.body ?? ""),
        raw: event,
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
        raw: event,
      });
      return;
    }

    if (type === "tool_execution_update") {
      const partialResult = event.partialResult ?? {};
      const partialText = toolResultToText(partialResult);
      this.upsertTranscript({
        id: `tool:${String(event.toolCallId ?? Date.now())}`,
        kind: "tool",
        title: formatToolTitle(event.toolName, event.args),
        body: partialText || toolArgsToText(event.args ?? {}),
        segments: toolResultToSegments(partialResult),
        status: "running",
        raw: event,
      });
      return;
    }

    if (type === "tool_execution_end") {
      const id = `tool:${String(event.toolCallId ?? Date.now())}`;
      const existing = this.transcript.find((item) => item.id === id);
      const result = event.result ?? {};
      this.upsertTranscript({
        id,
        kind: "tool",
        title: existing?.title ?? formatToolTitle(event.toolName, {}),
        body: toolResultToText(result),
        segments: toolResultToSegments(result),
        status: event.isError ? "error" : "done",
        raw: event,
      });
      return;
    }

    if (type === "queue_update") {
      const preserveImageCounts = (queue: "steering" | "followUp", values: unknown[]): RunningQueueItem[] => {
        const previous = [...this.runningQueue[queue]];
        return values.map((value) => {
          const text = String(value);
          const matchIndex = previous.findIndex((item) => item.text === text);
          const match = matchIndex >= 0 ? previous.splice(matchIndex, 1)[0] : undefined;
          return { text, imageCount: match?.imageCount };
        });
      };
      this.runningQueue = {
        steering: preserveImageCounts("steering", Array.isArray(event.steering) ? event.steering : []),
        followUp: preserveImageCounts("followUp", Array.isArray(event.followUp) ? event.followUp : []),
      };
    }
  }

  private selectTranscriptItem(id: string, shouldRender = true): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (transcript) this.transcriptScrollTop = transcript.scrollTop;
    this.selectedTranscriptId = id;
    localStorage.setItem("piWebSelectedTranscriptId", id);
    if (shouldRender) {
      this.preserveTranscriptScrollOnce = true;
      this.render();
    }
  }

  private selectedTranscriptItem(): TranscriptItem | null {
    return this.transcript.find((item) => item.id === this.selectedTranscriptId) ?? this.transcript[this.transcript.length - 1] ?? null;
  }

  private treeNodes(nodes = this.sessionTree?.tree ?? []): SessionTreeNode[] {
    return nodes.flatMap((node) => [node, ...this.treeNodes(node.children)]);
  }

  private forkEntryIdForTranscriptItem(item: TranscriptItem): string | null {
    if (item.kind !== "user") return null;
    const rawTimestamp = isRecord(item.raw) ? String(item.raw.timestamp ?? "") : "";
    const idTimestamp = item.id.startsWith("user:") ? item.id.slice("user:".length) : "";
    const timestamp = rawTimestamp || idTimestamp;
    const text = item.body.replace(/\s+/g, " ").trim();
    const node = this.treeNodes().find((candidate) => {
      if (candidate.type !== "message" || candidate.role !== "user") return false;
      if (timestamp && candidate.timestamp === timestamp) return true;
      return Boolean(text && candidate.title.replace(/^user:\s*/, "").startsWith(text.slice(0, 80)));
    });
    return node?.id ?? null;
  }

  private async refreshTree(): Promise<void> {
    if (!this.selectedSession) return;
    try {
      this.sessionTree = await this.api<SessionTreeResponse>(`/api/sessions/${this.selectedSession.id}/tree`);
      this.requestRender(0);
    } catch (error) {
      this.notice = `Tree refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      this.requestRender(0);
    }
  }

  private async forkFromEntry(entryId: string): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const session = await this.api<WebSession>(`/api/sessions/${this.selectedSession.id}/fork`, {
        method: "POST",
        body: JSON.stringify({ entryId }),
      });
      this.sessions = [session, ...this.sessions];
      this.openSession(session, false);
    } catch (error) {
      this.notice = `Fork failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private async navigateToTreeEntry(entryId: string): Promise<void> {
    if (!this.selectedSession) return;
    try {
      const result = await this.api<NavigateTreeResponse>(`/api/sessions/${this.selectedSession.id}/tree/navigate`, {
        method: "POST",
        body: JSON.stringify({ entryId, summarize: false }),
      });
      this.applySnapshot(result.snapshot);
      if (result.editorText) {
        this.promptDraft = result.editorText;
        this.savePromptDraft();
      }
      this.notice = result.editorText ? "Navigated to user message draft" : "Navigated to selected point";
      this.render();
    } catch (error) {
      this.notice = `Tree navigation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private openTreeDrawer(): void {
    if (!this.selectedSession) return;
    this.treeDrawerOpen = true;
    this.rightPanelTab = "tree";
    localStorage.setItem("piWebRightPanelTab", "tree");
    void this.refreshTree();
    this.render();
  }

  private closeTreeDrawer(): void {
    this.treeDrawerOpen = false;
    this.render();
  }

  private async copyText(value: string, label = "Copied"): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notice = label;
    } catch (error) {
      this.notice = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private async handleTranscriptRowAction(action: TranscriptRowAction | "menu", transcriptId: string): Promise<void> {
    const item = this.transcript.find((candidate) => candidate.id === transcriptId);
    if (!item) return;
    if (action === "menu") {
      this.openActionMenuId = this.openActionMenuId === transcriptId ? "" : transcriptId;
      this.selectTranscriptItem(transcriptId, false);
      if (item.kind === "user" && !this.forkEntryIdForTranscriptItem(item)) await this.refreshTree();
      this.render();
      return;
    }

    this.openActionMenuId = "";
    if (action === "copy") {
      await this.copyText(item.body, "Copied message content");
      return;
    }
    if (action === "details" || action === "preview") {
      this.selectedTranscriptId = transcriptId;
      localStorage.setItem("piWebSelectedTranscriptId", transcriptId);
      this.rightPanelTab = action;
      this.rightPanelCollapsed = false;
      localStorage.setItem("piWebRightPanelTab", action);
      localStorage.setItem("piWebRightPanelCollapsed", "false");
      this.preserveTranscriptScrollOnce = true;
      this.render();
      return;
    }
    if (action === "fork") {
      const entryId = this.forkEntryIdForTranscriptItem(item);
      if (entryId) await this.forkFromEntry(entryId);
      else {
        this.notice = "Fork is only available after this user message appears in the session tree.";
        this.render();
      }
    }
  }

  private async updateSessionTitle(title: string): Promise<void> {
    if (!this.selectedSession) return;
    const nextTitle = title.trim();
    const previous = this.selectedSession;
    if ((previous.title ?? "") === nextTitle) {
      this.editingTitleDraft = null;
      this.render();
      return;
    }
    this.selectedSession = { ...previous, title: nextTitle || null, titleSource: nextTitle ? "manual" : "unset" };
    this.sessions = this.sessions.map((session) => session.id === previous.id ? this.selectedSession! : session);
    this.editingTitleDraft = null;
    this.render();
    try {
      const updated = await this.api<WebSession>(`/api/sessions/${previous.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle || null }),
      });
      this.selectedSession = updated;
      this.sessions = this.sessions.map((session) => session.id === updated.id ? updated : session);
      this.notice = nextTitle ? "Session title updated." : "Session title cleared.";
    } catch (error) {
      this.selectedSession = previous;
      this.sessions = this.sessions.map((session) => session.id === previous.id ? previous : session);
      this.notice = `Title update failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private async generateMetadataSuggestion(): Promise<void> {
    if (!this.selectedSession || this.metadataGenerating) return;
    this.metadataGenerating = true;
    this.metadataSuggestion = null;
    this.metadataSuggestionError = "";
    this.render();
    try {
      const suggestion = await this.api<SessionMetadataSuggestion>(`/api/sessions/${this.selectedSession.id}/metadata/generate`, {
        method: "POST",
        body: JSON.stringify({ mode: "suggest" }),
      });
      if (suggestion.deferred) this.metadataSuggestionError = suggestion.reason ?? "Not enough session context yet.";
      else this.metadataSuggestion = suggestion;
    } catch (error) {
      this.metadataSuggestionError = `Metadata generation failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.metadataGenerating = false;
    this.render();
  }

  private async acceptMetadataSuggestion(kind: "both" | "title" | "summary"): Promise<void> {
    if (!this.selectedSession || !this.metadataSuggestion) return;
    const body: Record<string, string> = {};
    if ((kind === "both" || kind === "title") && this.metadataSuggestion.title) body.title = this.metadataSuggestion.title;
    if ((kind === "both" || kind === "summary") && this.metadataSuggestion.summary) body.summary = this.metadataSuggestion.summary;
    if (Object.keys(body).length === 0) return;
    try {
      const updated = await this.api<WebSession>(`/api/sessions/${this.selectedSession.id}`, { method: "PATCH", body: JSON.stringify(body) });
      this.selectedSession = updated;
      this.sessions = this.sessions.map((session) => session.id === updated.id ? updated : session);
      this.metadataSuggestion = null;
      this.metadataSuggestionError = "";
    } catch (error) {
      this.metadataSuggestionError = `Could not apply suggestion: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.render();
  }

  private sendClientMessage(type: "prompt" | "steer" | "follow_up"): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim() || (this.promptImages.length > 0 ? "Please inspect the attached image." : "");
    if (!input || !text) return;
    if (type === "prompt" && /^\/tree(?:\s|$)/i.test(text)) {
      this.promptDraft = "";
      this.savePromptDraft();
      this.closeFileAutocomplete();
      this.closeCommandAutocomplete();
      input.value = "";
      this.openTreeDrawer();
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.notice = "Not connected. Your draft is saved locally; sending will be available after reconnect.";
      this.render();
      return;
    }
    const images = this.promptImages.length > 0 ? this.promptImages.map((image) => image.dataUrl) : undefined;
    this.ws.send(JSON.stringify(images ? { type, text, images } : { type, text }));
    const queuedItem = { text, imageCount: images?.length };
    if (type === "steer") this.runningQueue = { ...this.runningQueue, steering: [...this.runningQueue.steering, queuedItem] };
    if (type === "follow_up") this.runningQueue = { ...this.runningQueue, followUp: [...this.runningQueue.followUp, queuedItem] };
    if (type === "prompt" && this.selectedSession && !this.selectedSession.title) {
      const provisionalTitle = provisionalTitleFromPrompt(text);
      const optimistic = { ...this.selectedSession, title: provisionalTitle, titleSource: provisionalTitle ? "first_prompt" as const : "unset" as const, lastUserPrompt: text.slice(0, 160), lastActivityAt: new Date().toISOString(), status: "running" as const };
      this.selectedSession = optimistic;
      this.sessions = this.sessions.map((session) => session.id === optimistic.id ? optimistic : session);
      window.setTimeout(() => void this.refresh(), 500);
    }
    this.promptDraft = "";
    this.savePromptDraft();
    this.promptImages = [];
    this.closeFileAutocomplete();
    this.closeCommandAutocomplete();
    input.value = "";
    this.render();
  }

  private removeQueuedMessage(queue: "steering" | "followUp", index: number, text: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.notice = "Not connected. Queued messages can be changed after reconnect.";
      this.render();
      return false;
    }
    const current = this.runningQueue[queue];
    if (current[index]?.text !== text) {
      this.notice = "Queued message changed before it could be updated.";
      this.render();
      return false;
    }
    this.runningQueue = {
      ...this.runningQueue,
      [queue]: current.filter((_, candidateIndex) => candidateIndex !== index),
    };
    this.ws.send(JSON.stringify({ type: "cancel_queued_message", queue, index, text }));
    return true;
  }

  private cancelQueuedMessage(queue: "steering" | "followUp", index: number, text: string): void {
    if (this.removeQueuedMessage(queue, index, text)) this.render();
  }

  private editQueuedMessage(queue: "steering" | "followUp", index: number, text: string): void {
    if (!this.removeQueuedMessage(queue, index, text)) return;
    this.promptDraft = text;
    this.savePromptDraft();
    this.notice = `Queued ${queue === "followUp" ? "follow-up" : "steer"} moved back to the composer.`;
    this.render();
    window.requestAnimationFrame(() => {
      const input = this.querySelector<HTMLTextAreaElement>("#prompt");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  private sendFromInput(followUp = false): void {
    const input = this.querySelector<HTMLTextAreaElement>("#prompt");
    const text = input?.value.trim() ?? "";
    if (input && /^\/new(?:\s|$)/i.test(text)) {
      void this.handleNewSlashCommand(input, text);
      return;
    }
    if (this.status === "running") this.sendClientMessage(followUp ? "follow_up" : "steer");
    else this.sendClientMessage("prompt");
  }

  private async handleNewSlashCommand(input: HTMLTextAreaElement, text: string): Promise<void> {
    if (text !== "/new") {
      this.notice = "Usage: /new";
      this.render();
      return;
    }
    if (this.promptImages.length > 0) {
      this.notice = "Remove image attachments before using /new.";
      this.render();
      return;
    }

    const cwd = this.selectedSession?.cwd;
    this.focusPromptOnNextReadyRender = true;
    const session = await this.createSession(cwd);
    if (!session) {
      this.focusPromptOnNextReadyRender = false;
      return;
    }
    this.promptDraft = "";
    this.savePromptDraft();
    this.closeFileAutocomplete();
    this.closeCommandAutocomplete();
    input.value = "";
  }

  private async addPromptImageFiles(files: FileList | File[]): Promise<void> {
    const incoming = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (incoming.length === 0) return;
    const added: PromptImage[] = [];
    for (const file of incoming) {
      if (this.promptImages.length + added.length >= maxPromptImages) {
        this.notice = `Only ${maxPromptImages} images can be attached to one prompt.`;
        break;
      }
      if (!supportedPromptImageTypes.has(file.type)) {
        this.notice = `Unsupported image type: ${file.type || file.name}`;
        continue;
      }
      if (file.size > maxPromptImageBytes) {
        this.notice = `${file.name} is larger than 8 MB.`;
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
        reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read image")));
        reader.readAsDataURL(file);
      });
      added.push({ id: crypto.randomUUID(), name: file.name || "pasted-image", mimeType: file.type, dataUrl, size: file.size });
    }
    if (added.length > 0) {
      this.promptImages = [...this.promptImages, ...added];
      this.notice = "Image attachments are ready for this prompt only and are not preserved across page refreshes.";
    }
    this.render();
  }

  private removePromptImage(id: string): void {
    this.promptImages = this.promptImages.filter((image) => image.id !== id);
    this.render();
  }

  private abort(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "abort" }));
  }

  private takeControl(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "take_control" }));
      this.notice = "Control request sent to the current controller.";
      this.render();
    }
  }

  private respondToControlRequest(approve: boolean, requesterClientId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: approve ? "approve_control" : "deny_control", requesterClientId }));
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
    this.savePromptDraft();
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
    this.savePromptDraft();
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
    const suffix = choice.type === "directory" && !choice.path.endsWith("/") ? "/" : "";
    const inserted = `@${choice.path}${suffix}`;
    const spacer = choice.type === "directory" ? "" : " ";
    const before = this.promptDraft.slice(0, this.fileAutocomplete.start);
    const after = this.promptDraft.slice(this.fileAutocomplete.end);
    this.promptDraft = `${before}${inserted}${spacer}${after}`;
    this.savePromptDraft();
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
    this.querySelector<HTMLSelectElement>("#metadataModelSetting")?.addEventListener("change", (event) => {
      const model = (event.currentTarget as HTMLSelectElement).value;
      void this.api<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ sessionMetadataModel: model ? { model } : null }) }).then((settings) => {
        this.appSettings = settings;
        this.render();
      }).catch((error) => {
        this.notice = `Settings update failed: ${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
    });
    this.querySelector<HTMLButtonElement>("#toggleSessionSidebar")?.addEventListener("click", () => {
      this.sessionSidebarCollapsed = !this.sessionSidebarCollapsed;
      this.sessionSidebarPinned = !this.sessionSidebarCollapsed;
      localStorage.setItem("piWebSessionSidebarCollapsed", String(this.sessionSidebarCollapsed));
      localStorage.setItem("piWebSessionSidebarPinned", String(this.sessionSidebarPinned));
      this.notice = this.sessionSidebarPinned ? "Session sidebar pinned open for future sessions." : "Session sidebar will auto-collapse after opening a session.";
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#toggleOlderSessions")?.addEventListener("click", () => {
      this.showOlderSessions = !this.showOlderSessions;
      localStorage.setItem("piWebShowOlderSessions", String(this.showOlderSessions));
      this.render();
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("input", (event) => {
      this.editingTitleDraft = (event.currentTarget as HTMLInputElement).value;
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
      if (event.key === "Escape") {
        this.editingTitleDraft = null;
        (event.currentTarget as HTMLInputElement).value = this.selectedSession?.title ?? "";
        (event.currentTarget as HTMLInputElement).blur();
      }
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("focus", (event) => {
      this.editingTitleDraft = (event.currentTarget as HTMLInputElement).value;
    });
    this.querySelector<HTMLInputElement>("#sessionTitle")?.addEventListener("blur", (event) => {
      void this.updateSessionTitle((event.currentTarget as HTMLInputElement).value);
    });
    this.querySelector<HTMLButtonElement>("#generateMetadata")?.addEventListener("click", () => void this.generateMetadataSuggestion());
    this.querySelector<HTMLButtonElement>("#toggleSessionSummary")?.addEventListener("click", () => this.setSummaryExpanded(!this.summaryExpanded()));
    this.querySelector<HTMLButtonElement>("#dismissMetadataSuggestion")?.addEventListener("click", () => {
      this.metadataSuggestion = null;
      this.metadataSuggestionError = "";
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-accept-metadata]").forEach((button) => {
      button.addEventListener("click", () => void this.acceptMetadataSuggestion(button.dataset.acceptMetadata as "both" | "title" | "summary"));
    });
    this.querySelector<HTMLButtonElement>("#send")?.addEventListener("click", () => this.sendFromInput(false));
    this.querySelector<HTMLButtonElement>("#followUp")?.addEventListener("click", () => this.sendFromInput(true));
    this.querySelector<HTMLButtonElement>("#toggleRunningQueue")?.addEventListener("click", () => {
      this.runningQueueExpanded = !this.runningQueueExpanded;
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-edit-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.editQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.editQueuedMessage(queue, index, text);
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-cancel-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.cancelQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.cancelQueuedMessage(queue, index, text);
      });
    });
    this.querySelector<HTMLButtonElement>("#abort")?.addEventListener("click", () => this.abort());
    this.querySelector<HTMLButtonElement>("#takeControl")?.addEventListener("click", () => this.takeControl());
    this.querySelector<HTMLButtonElement>("#approveControl")?.addEventListener("click", (event) => {
      this.respondToControlRequest(true, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
    });
    this.querySelector<HTMLButtonElement>("#denyControl")?.addEventListener("click", (event) => {
      this.respondToControlRequest(false, (event.currentTarget as HTMLButtonElement).dataset.requesterClientId ?? "");
    });
    this.querySelector<HTMLInputElement>("#autoScroll")?.addEventListener("change", (event) => {
      this.autoScroll = (event.currentTarget as HTMLInputElement).checked;
      localStorage.setItem("piWebAutoScroll", String(this.autoScroll));
      if (this.autoScroll) this.jumpToLatest();
      else this.render();
    });
    this.querySelector<HTMLButtonElement>("#jumpToLatest")?.addEventListener("click", () => this.jumpToLatest());
    this.querySelector<HTMLInputElement>("#showThinking")?.addEventListener("change", (event) => {
      this.showThinking = (event.currentTarget as HTMLInputElement).checked;
      localStorage.setItem("piWebShowThinking", String(this.showThinking));
      this.render();
    });
    this.querySelector<HTMLButtonElement>("#toggleRightPanel")?.addEventListener("click", () => {
      this.rightPanelCollapsed = !this.rightPanelCollapsed;
      localStorage.setItem("piWebRightPanelCollapsed", String(this.rightPanelCollapsed));
      this.render();
    });
    this.querySelectorAll<HTMLButtonElement>("[data-right-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = button.dataset.rightTab === "preview" ? "preview" : button.dataset.rightTab === "tree" ? "tree" : "details";
        this.rightPanelTab = tab;
        this.rightPanelCollapsed = false;
        localStorage.setItem("piWebRightPanelTab", tab);
        localStorage.setItem("piWebRightPanelCollapsed", "false");
        this.render();
      });
    });
    this.querySelector<HTMLButtonElement>("#copySelectedBody")?.addEventListener("click", () => {
      const item = this.selectedTranscriptItem();
      if (item) void this.copyText(item.body, "Copied selected content");
    });
    this.querySelector<HTMLButtonElement>("#copySelectedJson")?.addEventListener("click", () => {
      const item = this.selectedTranscriptItem();
      if (item) void this.copyText(stringify(item.raw ?? item), "Copied selected JSON");
    });
    this.querySelector<HTMLSelectElement>("#model")?.addEventListener("change", (event) => this.setModel((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLSelectElement>("#thinking")?.addEventListener("change", (event) => this.setThinking((event.currentTarget as HTMLSelectElement).value));
    this.querySelector<HTMLInputElement>("#imageInput")?.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      void this.addPromptImageFiles(input.files ?? []);
      input.value = "";
    });
    this.querySelector<HTMLButtonElement>("#attachImages")?.addEventListener("click", () => this.querySelector<HTMLInputElement>("#imageInput")?.click());
    this.querySelectorAll<HTMLButtonElement>("[data-remove-image-id]").forEach((button) => {
      button.addEventListener("click", () => this.removePromptImage(button.dataset.removeImageId ?? ""));
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragover", (event) => {
      if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.type.startsWith("image/"))) {
        event.preventDefault();
        (event.currentTarget as HTMLElement).classList.add("dragging-image");
      }
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("dragleave", (event) => {
      (event.currentTarget as HTMLElement).classList.remove("dragging-image");
    });
    this.querySelector<HTMLElement>(".prompt-shell")?.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (!files || !Array.from(files).some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      (event.currentTarget as HTMLElement).classList.remove("dragging-image");
      void this.addPromptImageFiles(files);
    });
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("input", (event) => this.updatePromptDraft(event.currentTarget as HTMLTextAreaElement));
    this.querySelector<HTMLTextAreaElement>("#prompt")?.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (files && Array.from(files).some((file) => file.type.startsWith("image/"))) void this.addPromptImageFiles(files);
    });
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
    this.querySelector<HTMLElement>(".transcript")?.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-row-action]");
      if (!button) {
        if (this.openActionMenuId) {
          this.openActionMenuId = "";
          this.render();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.rowAction as TranscriptRowAction | "menu";
      void this.handleTranscriptRowAction(action, button.dataset.transcriptId ?? "");
    });
    this.querySelector<HTMLElement>(".transcript")?.addEventListener("scroll", (event) => {
      const transcript = event.currentTarget as HTMLElement;
      this.transcriptScrollTop = transcript.scrollTop;
      if (this.isTranscriptNearBottom(transcript)) {
        if (!this.autoScroll || this.unreadTranscriptIds.size > 0) {
          this.autoScroll = true;
          this.unreadTranscriptIds.clear();
          this.requestRender(80);
        }
      } else if (this.autoScroll) {
        this.autoScroll = false;
        this.requestRender(80);
      } else {
        this.patchJumpToLatest();
      }
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

    this.querySelectorAll<HTMLButtonElement>("[data-tree-refresh]").forEach((button) => {
      button.addEventListener("click", () => void this.refreshTree());
    });
    this.querySelectorAll<HTMLButtonElement>("[data-open-tree-drawer]").forEach((button) => {
      button.addEventListener("click", () => this.openTreeDrawer());
    });
    this.querySelector<HTMLButtonElement>("#closeTreeDrawer")?.addEventListener("click", () => this.closeTreeDrawer());
    this.querySelectorAll<HTMLElement>("[data-tree-entry-id]").forEach((element) => {
      element.addEventListener("click", () => void this.navigateToTreeEntry(element.dataset.treeEntryId ?? ""));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-fork-entry-id]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.forkFromEntry(button.dataset.forkEntryId ?? "");
      });
    });
  }

  private sessionDisplayTitle(session: WebSession): string {
    return session.title?.trim() || (session.lastUserPrompt && isGenericSessionPrompt(session.lastUserPrompt) ? "New session" : session.lastUserPrompt?.trim().slice(0, 60)) || pathBasename(session.cwd) || "Untitled session";
  }

  private sessionTitlePlaceholder(session: WebSession): string {
    return session.title ? "Session title" : this.sessionDisplayTitle(session);
  }

  private summaryExpanded(sessionId = this.selectedSession?.id): boolean {
    return sessionId ? localStorage.getItem(`piWebSessionSummaryExpanded:${sessionId}`) === "true" : false;
  }

  private setSummaryExpanded(expanded: boolean): void {
    if (!this.selectedSession) return;
    localStorage.setItem(`piWebSessionSummaryExpanded:${this.selectedSession.id}`, String(expanded));
    this.render();
  }

  private sessionMetadata(session: WebSession): string {
    const repo = pathBasename(session.cwd);
    const parent = pathParent(session.cwd);
    return `${repo}${parent && parent !== repo ? ` · ${parent}` : ""}`;
  }

  private sortedSessions(): WebSession[] {
    return [...this.sessions].sort((a, b) => (b.lastActivityAt ?? b.lastOpenedAt).localeCompare(a.lastActivityAt ?? a.lastOpenedAt));
  }

  private recentSessions(): { visible: WebSession[]; olderCount: number } {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const sorted = this.sortedSessions();
    const recent = sorted.filter((session) => new Date(session.lastActivityAt ?? session.lastOpenedAt).getTime() >= cutoff || session.id === this.selectedSession?.id);
    const older = sorted.filter((session) => !recent.includes(session));
    return { visible: this.showOlderSessions ? sorted : recent, olderCount: older.length };
  }

  private renderSessionCard(session: WebSession): string {
    const title = this.sessionDisplayTitle(session);
    const activity = session.lastActivityAt ?? session.lastOpenedAt;
    const snippet = session.summary?.trim() || session.lastUserPrompt?.trim() || "No prompt yet";
    const status = session.status ?? (session.id === this.selectedSession?.id ? this.status === "connecting" || this.status === "disconnected" ? undefined : this.status : "idle");
    return `
      <button data-session-id="${escapeHtml(session.id)}" class="session-card ${session.id === this.selectedSession?.id ? "active" : ""}">
        <span class="session-card-top">
          <strong>${escapeHtml(title)}</strong>
          ${status ? `<em class="session-indicator ${escapeHtml(status)}">${escapeHtml(status)}</em>` : ""}
        </span>
        <span class="session-snippet">${escapeHtml(snippet)}</span>
        <small>${escapeHtml(relativeTime(activity))} · ${escapeHtml(pathBasename(session.cwd))}</small>
      </button>`;
  }

  private renderAppSettings(): string {
    const models = this.settings?.availableModels ?? [];
    const selected = this.appSettings?.sessionMetadataModel?.model ?? "";
    return `<div class="app-settings">
      <label>Metadata model
        <select id="metadataModelSetting">
          <option value="" ${selected ? "" : "selected"}>Default / active model</option>
          ${models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selected ? "selected" : ""}>${escapeHtml(model.name ?? model.id)} [${escapeHtml(model.provider)}]</option>`).join("")}
        </select>
      </label>
      <small>Titles and summaries are generated only when you click ✨.</small>
    </div>`;
  }

  private renderSessionSummary(expanded: boolean): string {
    if (!this.selectedSession) return "";
    const summary = this.selectedSession.summary?.trim();
    const suggestion = this.metadataSuggestion;
    const sourceHint = `Title: ${this.selectedSession.titleSource}; summary: ${this.selectedSession.summarySource}`;
    const summaryBlock = summary ? `
      <button id="toggleSessionSummary" class="session-summary-toggle" type="button" title="${escapeHtml(sourceHint)}">${expanded ? "▾" : "▸"} Summary${expanded ? "" : ` — ${escapeHtml(summary.slice(0, 120))}${summary.length > 120 ? "…" : ""}`}</button>
      ${expanded ? `<p class="session-summary-body">${escapeHtml(summary)}</p>` : ""}
    ` : `<span class="session-summary-empty" title="${escapeHtml(sourceHint)}">No summary yet.</span>`;
    const suggestionBlock = suggestion ? `
      <div class="metadata-suggestion">
        <strong>Suggested metadata</strong>
        ${suggestion.title ? `<p><b>Title:</b> ${escapeHtml(suggestion.title)}</p>` : ""}
        ${suggestion.summary ? `<p><b>Summary:</b> ${escapeHtml(suggestion.summary)}</p>` : ""}
        <div class="metadata-suggestion-actions">
          <button data-accept-metadata="both">Use both</button>
          ${suggestion.title ? `<button data-accept-metadata="title">Use title</button>` : ""}
          ${suggestion.summary ? `<button data-accept-metadata="summary">Use summary</button>` : ""}
          <button id="dismissMetadataSuggestion">Dismiss</button>
        </div>
      </div>` : "";
    const errorBlock = this.metadataSuggestionError ? `<p class="metadata-suggestion error">${escapeHtml(this.metadataSuggestionError)}</p>` : "";
    return `<div class="session-summary">${summaryBlock}${suggestionBlock}${errorBlock}</div>`;
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
            <strong>${escapeHtml(file.path)}${file.type === "directory" && !file.path.endsWith("/") ? "/" : ""}</strong>
          </button>`).join("")}
      </div>`;
  }

  private renderPromptImages(): string {
    if (this.promptImages.length === 0) return "";
    return `
      <div class="prompt-images" aria-label="Attached prompt images">
        ${this.promptImages.map((image) => `
          <figure class="prompt-image">
            <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" />
            <figcaption title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</figcaption>
            <button type="button" data-remove-image-id="${escapeHtml(image.id)}" aria-label="Remove ${escapeHtml(image.name)}">×</button>
          </figure>`).join("")}
      </div>`;
  }

  private renderRunningQueue(): string {
    const steering = this.runningQueue.steering;
    const followUp = this.runningQueue.followUp;
    const allItems = [
      ...steering.map((item, index) => ({ kind: "Steer" as const, queue: "steering" as const, item, index })),
      ...followUp.map((item, index) => ({ kind: "Follow-up" as const, queue: "followUp" as const, item, index })),
    ];
    if (allItems.length === 0) {
      this.runningQueueExpanded = false;
      return "";
    }
    const visibleItems = this.runningQueueExpanded ? allItems : allItems.slice(0, 3);
    const hiddenCount = Math.max(0, allItems.length - visibleItems.length);
    const renderPill = (kind: "Steer" | "Follow-up", queue: "steering" | "followUp", item: RunningQueueItem, index: number) => `
      <span class="queue-pill ${kind.toLowerCase()}" title="${escapeHtml(item.text)}">
        <strong>${escapeHtml(kind)} ${index + 1}</strong>
        <span>${escapeHtml(item.text)}</span>
        ${item.imageCount ? `<em class="queue-image-badge" title="${item.imageCount} attached image${item.imageCount === 1 ? "" : "s"}">🖼 ${item.imageCount}</em>` : ""}
        <button type="button" class="queue-edit" data-edit-queue="${queue}" data-queue-index="${index}" data-queue-text="${escapeHtml(item.text)}" aria-label="Edit ${escapeHtml(kind)} ${index + 1}">✎</button>
        <button type="button" class="queue-cancel" data-cancel-queue="${queue}" data-queue-index="${index}" data-queue-text="${escapeHtml(item.text)}" aria-label="Cancel ${escapeHtml(kind)} ${index + 1}">×</button>
      </span>`;
    const total = allItems.length;
    return `
      <div class="running-queue ${this.runningQueueExpanded ? "expanded" : "compact"}" aria-label="Queued running controls">
        <div class="running-queue-heading">
          <strong>Queued for this run</strong>
          <span>${total} pending</span>
          ${hiddenCount > 0 ? `<button id="toggleRunningQueue" class="queue-more" type="button">+${hiddenCount} more</button>` : this.runningQueueExpanded && total > 3 ? `<button id="toggleRunningQueue" class="queue-more" type="button">Show less</button>` : ""}
        </div>
        <div class="running-queue-items">
          ${visibleItems.map(({ kind, queue, item, index }) => renderPill(kind, queue, item, index)).join("")}
        </div>
      </div>`;
  }

  private renderRightPanel(): string {
    const item = this.selectedTranscriptItem();
    const detailsActive = this.rightPanelTab === "details";
    const previewActive = this.rightPanelTab === "preview";
    if (this.rightPanelCollapsed) {
      return `
        <aside class="right-panel collapsed" aria-label="Collapsed inspector">
          <button id="toggleRightPanel" title="Show inspector" aria-label="Show inspector">◀</button>
          <span>Inspector</span>
        </aside>`;
    }
    return `
      <aside class="right-panel">
        <div class="right-tabs">
          <button id="toggleRightPanel" class="collapse-panel" title="Hide inspector" aria-label="Hide inspector">▶</button>
          <button data-right-tab="details" class="${detailsActive ? "active" : ""}">Details</button>
          <button data-right-tab="preview" class="${previewActive ? "active" : ""}">Preview</button>
          <button data-right-tab="tree" class="${this.rightPanelTab === "tree" ? "active" : ""}">Tree</button>
        </div>
        ${this.rightPanelTab === "tree" ? this.renderTreePanel() : item ? `
          <div class="right-panel-heading">
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.kind)}${item.status ? ` · ${escapeHtml(item.status)}` : ""}</small>
            </div>
            <div class="right-actions">
              <button id="copySelectedBody">Copy text</button>
              <button id="copySelectedJson">Copy JSON</button>
            </div>
          </div>
          ${detailsActive ? this.renderDetailsPanel(item) : this.renderPreviewPanel(item)}
        ` : `<p class="empty-panel">Select a message or tool to inspect it.</p>`}
      </aside>`;
  }

  private renderTreeNodes(nodes: SessionTreeNode[], prefix = ""): string {
    return nodes.map((node, index) => {
      const isLast = index === nodes.length - 1;
      const connector = prefix ? (isLast ? "└─" : "├─") : "•";
      const childPrefix = `${prefix}${prefix ? (isLast ? "  " : "│ ") : ""}`;
      const canFork = node.type === "message" && node.role === "user";
      const kind = node.role ?? node.type;
      return `
        <div class="tree-line ${node.current ? "current" : ""}" data-tree-entry-id="${escapeHtml(node.id)}" title="Navigate to this point">
          <span class="tree-prefix">${escapeHtml(prefix)}${connector}</span>
          <span class="tree-kind ${escapeHtml(kind)}">${escapeHtml(kind)}:</span>
          <span class="tree-title">${escapeHtml(node.title.replace(/^\w+:\s*/, ""))}</span>
          ${node.current ? `<span class="tree-current">current</span>` : `<span class="tree-current">go</span>`}
          ${canFork ? `<button data-fork-entry-id="${escapeHtml(node.id)}" title="Fork from this user message">fork</button>` : ""}
        </div>
        ${node.children.length ? this.renderTreeNodes(node.children, childPrefix) : ""}`;
    }).join("");
  }

  private renderTreePanel(options: { drawer?: boolean } = {}): string {
    if (!this.selectedSession) return `<p class="empty-panel">Open a session to inspect its tree.</p>`;
    return `
      <div class="tree-panel tui-tree ${options.drawer ? "drawer-tree" : ""}">
        <div class="tree-toolbar">
          <strong>Session Tree</strong>
          <span>Type <b>/tree</b> to open this wide view. Click a row to navigate; <b>fork</b> creates a new session branch.</span>
          <div class="tree-toolbar-actions">
            ${options.drawer ? `<button id="closeTreeDrawer">Close</button>` : `<button data-open-tree-drawer>Wide</button>`}
            <button data-tree-refresh>Refresh</button>
          </div>
        </div>
        <div class="tree-hints">TUI-style view · current path highlighted · ${this.sessionTree?.leafId ? `leaf ${escapeHtml(this.sessionTree.leafId)}` : "no leaf yet"}</div>
        ${this.sessionTree?.tree.length
          ? `<div class="session-tree">${this.renderTreeNodes(this.sessionTree.tree)}</div>`
          : `<p class="empty-panel">No tree entries yet. Send a prompt first.</p>`}
      </div>`;
  }

  private renderTreeDrawer(): string {
    if (!this.treeDrawerOpen) return "";
    return `<div class="tree-drawer" role="dialog" aria-label="Session tree">${this.renderTreePanel({ drawer: true })}</div>`;
  }

  private renderDetailsPanel(item: TranscriptItem): string {
    const raw = item.raw ?? item;
    const rawText = stringify(raw);
    const bodyPreview = item.body.trim();
    return `
      <div class="details-panel">
        <dl class="detail-grid">
          <dt>ID</dt><dd><code>${escapeHtml(item.id)}</code></dd>
          <dt>Kind</dt><dd>${escapeHtml(item.kind)}</dd>
          <dt>Status</dt><dd>${escapeHtml(item.status ?? "—")}</dd>
          <dt>Content</dt><dd>${escapeHtml(String(item.body.length))} chars</dd>
          <dt>Raw</dt><dd>${escapeHtml(String(rawText.length))} chars</dd>
        </dl>
        ${bodyPreview ? `
          <section class="detail-section">
            <h3>Content</h3>
            <pre>${escapeHtml(bodyPreview)}</pre>
          </section>` : ""}
        <details class="detail-section raw-detail">
          <summary>Raw event/message JSON</summary>
          <pre>${escapeHtml(rawText)}</pre>
        </details>
      </div>`;
  }

  private renderPreviewPanel(item: TranscriptItem): string {
    const body = item.body.trim();
    if (!body) return `<p class="empty-panel">No previewable content.</p>`;
    if (looksLikeHtml(body) || looksLikeSvg(body)) {
      return `<iframe class="preview-frame" sandbox srcdoc="${escapeHtml(body)}"></iframe>`;
    }
    if (item.kind === "assistant" || item.kind === "user") {
      return `<div class="preview-markdown markdown-body">${renderTranscriptSegments(item, this.showThinking, { cache: this.renderedSegmentCache, localImageUrl: (path) => this.localImageUrl(path) })}</div>`;
    }
    if (looksLikeMarkdown(body)) {
      return `<div class="preview-markdown markdown-body">${renderMarkdown(body)}</div>`;
    }
    return `<div class="preview-code"><pre>${escapeHtml(body)}</pre></div>`;
  }

  private renderTranscriptItemShell(item: TranscriptItem): string {
    return `<pi-transcript-row data-transcript-id="${escapeHtml(item.id)}"></pi-transcript-row>`;
  }

  private renderTranscript(): string {
    return this.transcript.map((item) => this.renderTranscriptItemShell(item)).join("");
  }

  private startScrollMonitor(): void {
    if (this.scrollMonitorTimer) return;
    this.scrollMonitorTimer = setInterval(() => {
      const transcript = this.querySelector<HTMLElement>(".transcript");
      if (!transcript) return;
      if (this.autoScroll && !this.isTranscriptNearBottom(transcript)) {
        this.autoScroll = false;
        this.transcriptScrollTop = transcript.scrollTop;
      }
      if (!this.autoScroll) this.patchJumpToLatest();
    }, 120);
  }

  private stopScrollMonitor(): void {
    if (this.scrollMonitorTimer) clearInterval(this.scrollMonitorTimer);
    this.scrollMonitorTimer = undefined;
  }

  private renderJumpToLatest(): string {
    if (this.autoScroll) return "";
    const count = this.unreadTranscriptIds.size;
    return `<button id="jumpToLatest" class="jump-to-latest" type="button">Jump to latest${count > 0 ? ` · ${count} update${count === 1 ? "" : "s"}` : ""}</button>`;
  }

  private isTranscriptNearBottom(transcript = this.querySelector<HTMLElement>(".transcript")): boolean {
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
  }

  private scrollTranscriptToBottom(): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    this.transcriptScrollTop = transcript.scrollTop;
  }

  private jumpToLatest(): void {
    this.autoScroll = true;
    localStorage.setItem("piWebAutoScroll", "true");
    this.unreadTranscriptIds.clear();
    this.scrollTranscriptToBottom();
    this.render();
  }

  private scheduleTranscriptFollow(): void {
    requestAnimationFrame(() => this.scrollTranscriptToBottom());
  }

  private syncTranscriptScroll(): void {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    if (!this.autoScroll || this.preserveTranscriptScrollOnce) {
      transcript.scrollTop = Math.min(this.transcriptScrollTop, Math.max(0, transcript.scrollHeight - transcript.clientHeight));
      this.preserveTranscriptScrollOnce = false;
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

  private findTranscriptElement(id: string): PiTranscriptRow | null {
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript) return null;
    return Array.from(transcript.children).find((element) => (element as HTMLElement).dataset.transcriptId === id) as PiTranscriptRow | undefined ?? null;
  }

  private bindTranscriptElement(element: HTMLElement): void {
    if (element.dataset.transcriptBound === "true") return;
    element.dataset.transcriptBound = "true";
    element.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest(".message-action-area")) return;
      if ((event.target as HTMLElement | null)?.closest(".message-header") && element.classList.contains("collapsible")) return;
      this.openActionMenuId = "";
      this.selectTranscriptItem(element.dataset.transcriptId ?? "");
    });
  }

  private isGroupableToolItem(item: TranscriptItem): boolean {
    return item.kind === "tool"
      && item.status === "done"
      && !itemHasRenderedImage(item)
      && !itemHasLocalImageArtifacts(item, (path) => this.localImageUrl(path));
  }

  private toolGroupPositionFor(item: TranscriptItem): ToolGroupPosition {
    const index = this.transcript.findIndex((candidate) => candidate.id === item.id);
    if (index === -1 || !this.isGroupableToolItem(item)) return "single";
    const previousGrouped = index > 0 && this.isGroupableToolItem(this.transcript[index - 1]!);
    const nextGrouped = index < this.transcript.length - 1 && this.isGroupableToolItem(this.transcript[index + 1]!);
    if (previousGrouped && nextGrouped) return "middle";
    if (nextGrouped) return "start";
    if (previousGrouped) return "end";
    return "single";
  }

  private updateTranscriptRow(row: PiTranscriptRow, item: TranscriptItem): void {
    row.setState(item, {
      showThinking: this.showThinking,
      selected: item.id === this.selectedTranscriptId,
      actionMenuOpen: item.id === this.openActionMenuId,
      canFork: Boolean(this.forkEntryIdForTranscriptItem(item)),
      toolGroupPosition: this.toolGroupPositionFor(item),
      cache: this.renderedSegmentCache,
      localImageUrl: (path) => this.localImageUrl(path),
    });
  }

  private hydrateTranscriptRows(): void {
    this.querySelectorAll<PiTranscriptRow>("pi-transcript-row[data-transcript-id]").forEach((row) => {
      this.bindTranscriptElement(row);
      const item = this.transcript.find((candidate) => candidate.id === row.dataset.transcriptId);
      if (item) this.updateTranscriptRow(row, item);
    });
  }

  private patchHeaderStatus(): void {
    const status = this.querySelector<HTMLElement>(".status");
    if (!status) return;
    status.className = `status ${this.status}`;
    status.textContent = this.status;
  }

  private patchConnectionBanner(): void {
    const banner = this.querySelector<HTMLElement>(".connection-banner");
    if (!banner) return;
    banner.className = `connection-banner ${this.connectionState}`;
    banner.innerHTML = `
      <strong>${escapeHtml(this.connectionState.replace("_", " "))}</strong>
      <span>${escapeHtml(this.connectionMessage)}</span>
      ${this.promptDraft ? `<small>Draft saved locally for this session.</small>` : ""}
      ${this.promptImages.length > 0 ? `<small>Attached images will be lost on refresh.</small>` : ""}`;
  }

  private patchJumpToLatest(): void {
    const shell = this.querySelector<HTMLElement>(".transcript-shell");
    if (!shell) return;
    const existing = shell.querySelector<HTMLButtonElement>("#jumpToLatest");
    if (this.autoScroll) {
      existing?.remove();
      return;
    }
    const count = this.unreadTranscriptIds.size;
    const label = `Jump to latest${count > 0 ? ` · ${count} update${count === 1 ? "" : "s"}` : ""}`;
    if (existing) {
      existing.textContent = label;
      return;
    }
    const button = document.createElement("button");
    button.id = "jumpToLatest";
    button.className = "jump-to-latest";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => this.jumpToLatest());
    shell.append(button);
  }

  private patchLiveRender(): boolean {
    const start = performance.now();
    const transcript = this.querySelector<HTMLElement>(".transcript");
    if (!transcript || this.forceFullRender) return false;
    if (this.autoScroll && !this.isTranscriptNearBottom(transcript)) this.autoScroll = false;

    for (const id of this.dirtyTranscriptIds) {
      const item = this.transcript.find((candidate) => candidate.id === id);
      if (!item) continue;
      const existing = this.findTranscriptElement(id);
      if (existing) {
        this.updateTranscriptRow(existing, item);
      } else {
        const next = document.createElement("pi-transcript-row") as PiTranscriptRow;
        next.dataset.transcriptId = item.id;
        this.bindTranscriptElement(next);
        this.updateTranscriptRow(next, item);
        transcript.append(next);
      }
    }
    this.dirtyTranscriptIds.clear();
    this.patchHeaderStatus();
    this.patchConnectionBanner();
    this.patchJumpToLatest();
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    recordPerfSample("patch", performance.now() - start);
    return true;
  }

  private requestRender(delayMs = this.status === "running" ? 150 : 0): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      if (delayMs > 0 && this.patchLiveRender()) return;
      this.render();
    }, delayMs);
  }

  private renderContextUsageNotice(): string {
    const usage = this.settings?.contextUsage;
    if (!this.selectedSession || !usage) return "";
    const percent = Math.max(0, Math.min(100, usage.percent ?? 0));
    const title = usage.tokens === null
      ? `Context usage is currently unknown. Model context window: ${usage.contextWindow.toLocaleString()} tokens.`
      : `Estimated context usage: ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${usage.percent?.toFixed(2) ?? "unknown"}%).`;
    return `<div class="context-usage" aria-label="Model context usage" title="${escapeHtml(title)}">
      <span><strong>Context</strong> ${escapeHtml(contextUsageLabel(usage))}</span>
      <span class="context-usage-bar" aria-hidden="true"><i style="width: ${percent}%"></i></span>
    </div>`;
  }

  private render(): void {
    const renderStart = performance.now();
    const existingTranscript = this.querySelector<HTMLElement>(".transcript");
    if (existingTranscript) {
      if (this.autoScroll && !this.isTranscriptNearBottom(existingTranscript)) this.autoScroll = false;
      this.transcriptScrollTop = existingTranscript.scrollTop;
    }
    const prompt = this.querySelector<HTMLTextAreaElement>("#prompt");
    const restorePromptFocus = document.activeElement === prompt;
    const promptSelectionStart = prompt?.selectionStart ?? this.promptDraft.length;
    const promptSelectionEnd = prompt?.selectionEnd ?? promptSelectionStart;
    const isRunning = this.status === "running";
    this.classList.toggle("session-sidebar-collapsed", this.sessionSidebarCollapsed);
    this.classList.toggle("inspector-collapsed", this.rightPanelCollapsed);
    const isController = this.controller?.isController ?? true;
    const takeoverRequest = this.controller?.takeoverRequest;
    const takeoverPending = takeoverRequest?.state === "requested";
    const takeoverIncoming = takeoverRequest?.state === "incoming";
    const controllerLabel = this.controller
      ? `${this.controller.isController ? "controller" : "viewer"} · ${this.controller.connectedClients} client${this.controller.connectedClients === 1 ? "" : "s"}`
      : "";
    const currentModelId = this.settings?.model?.id ?? "";
    const sessionGroups = this.recentSessions();
    const selectedTitle = this.selectedSession ? (this.editingTitleDraft ?? this.selectedSession.title ?? "") : "";
    const selectedTitlePlaceholder = this.selectedSession ? this.sessionTitlePlaceholder(this.selectedSession) : "";
    const selectedMeta = this.selectedSession ? this.sessionMetadata(this.selectedSession) : "";
    const summaryExpanded = this.selectedSession ? this.summaryExpanded(this.selectedSession.id) : false;
    this.innerHTML = `
      <aside class="session-sidebar ${this.sessionSidebarCollapsed ? "collapsed" : ""}">
        <div class="sidebar-titlebar">
          <h1>Pi Web Agent</h1>
          <button id="toggleSessionSidebar" class="collapse-sidebar" title="${this.sessionSidebarCollapsed ? "Show sessions" : this.sessionSidebarPinned ? "Hide sessions and unpin auto-collapse" : "Hide sessions"}" aria-label="${this.sessionSidebarCollapsed ? "Show sessions" : "Hide sessions"}">${this.sessionSidebarCollapsed ? "▶" : "◀"}</button>
        </div>
        ${this.sessionSidebarCollapsed ? `
          <span class="collapsed-sidebar-label">Sessions</span>
          ${this.selectedSession ? `<span class="collapsed-sidebar-session" title="${escapeHtml(this.selectedSession.title ?? this.selectedSession.cwd)}">●</span>` : ""}
        ` : `
          <label>API <input id="apiBase" value="${escapeHtml(this.apiBase)}" /></label>
          <label>Token <input id="token" type="password" value="${escapeHtml(this.token)}" /></label>
          <button id="saveSettings">Save / Refresh</button>
          ${this.notice ? `<p class="notice">${escapeHtml(this.notice)}</p>` : ""}
          ${this.renderAppSettings()}
          ${this.sessionSidebarPinned ? `<p class="sidebar-mode">Pinned open for new sessions</p>` : `<p class="sidebar-mode">Auto-collapses after opening a session</p>`}
          <hr />
          <label>Workspace
            <select id="workspace">
              ${this.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.path)}">${escapeHtml(workspace.label)} — ${escapeHtml(workspace.path)}</option>`).join("")}
            </select>
          </label>
          <button id="newSession">New session</button>
          <div class="sessions-heading">
            <h2>Recent sessions</h2>
            ${sessionGroups.olderCount > 0 ? `<button id="toggleOlderSessions" type="button">${this.showOlderSessions ? "Hide older" : `Show older (${sessionGroups.olderCount})`}</button>` : ""}
          </div>
          <div class="sessions">
            ${sessionGroups.visible.length ? sessionGroups.visible.map((session) => this.renderSessionCard(session)).join("") : `<p class="empty-sidebar">No recent sessions. Create one from the selected workspace.</p>`}
          </div>
        `}
      </aside>
      <main>
        <header>
          <div class="session-identity">
            ${this.selectedSession ? `<div class="session-title-row"><input id="sessionTitle" class="session-title-input" value="${escapeHtml(selectedTitle)}" placeholder="${escapeHtml(selectedTitlePlaceholder)}" aria-label="Session title" title="Edit session title" />
              <button id="generateMetadata" class="icon-button" title="Suggest title and summary" aria-label="Suggest title and summary" ${this.metadataGenerating || this.status === "running" ? "disabled" : ""}>${this.metadataGenerating ? "…" : "✨"}</button></div>
              <span title="${escapeHtml(this.selectedSession.cwd)}">${escapeHtml(selectedMeta)}</span>
              ${this.renderSessionSummary(summaryExpanded)}` : `<strong>Create or open a session</strong><span>Select a workspace on the left to start.</span>`}
          </div>
          <div class="header-status">
            ${controllerLabel ? `<span class="controller ${isController ? "" : "viewer"}">${escapeHtml(controllerLabel)}</span>` : ""}
            ${!isController ? `<button id="takeControl" ${takeoverPending ? "disabled" : ""}>${takeoverPending ? "Control requested" : "Take control"}</button>` : ""}
            ${takeoverIncoming ? `<span class="control-request">Another tab wants control <button id="approveControl" data-requester-client-id="${escapeHtml(takeoverRequest?.requesterClientId ?? "")}">Approve</button><button id="denyControl" data-requester-client-id="${escapeHtml(takeoverRequest?.requesterClientId ?? "")}">Deny</button></span>` : ""}
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
        <div class="connection-banner ${escapeHtml(this.connectionState)}" role="status">
          <strong>${escapeHtml(this.connectionState.replace("_", " "))}</strong>
          <span>${escapeHtml(this.connectionMessage)}</span>
          ${takeoverPending ? `<small>Waiting for the current controller to approve your control request.</small>` : ""}
          ${takeoverIncoming ? `<small>A viewer is asking to control this session. Approve only if you are ready to hand off input.</small>` : ""}
          ${this.promptDraft ? `<small>Draft saved locally for this session.</small>` : ""}
          ${this.promptImages.length > 0 ? `<small>Attached images will be lost on refresh.</small>` : ""}
        </div>
        <div class="transcript-shell ${this.runningQueue.steering.length + this.runningQueue.followUp.length > 0 ? "has-running-queue" : ""}">
          <section class="transcript">${this.renderTranscript()}</section>
          ${this.renderRunningQueue()}
          ${this.renderJumpToLatest()}
        </div>
        <footer class="${isRunning ? "running-footer" : ""}">
          <div class="prompt-shell">
            <div class="composer-mode ${isRunning ? "running" : "idle"}">
              <strong>${isRunning ? "Running input" : "Prompt"}</strong>
              <span class="composer-hint">${isRunning ? "Enter steers now · Alt+Enter queues a follow-up" : "Enter sends · Shift+Enter adds a line"}</span>
              ${this.renderContextUsageNotice()}
            </div>
            ${this.renderPromptImages()}
            <textarea id="prompt" rows="2" ${isController ? "" : "disabled"} placeholder="${isController ? (isRunning ? "Steer the active run..." : "Ask pi... Paste/drop screenshots, type / for commands or @ for files.") : "Viewer mode — take control to send"}">${escapeHtml(this.promptDraft)}</textarea>
            <input id="imageInput" class="hidden-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple />
            ${this.renderCommandAutocomplete()}
            ${this.renderFileAutocomplete()}
          </div>
          <div class="controls ${isRunning ? "running" : ""}">
            <button id="attachImages" class="icon-button" title="Attach images" aria-label="Attach images" ${isController ? "" : "disabled"}>📎</button>
            <button id="send" class="primary-action" ${isController ? "" : "disabled"}>${isRunning ? "Steer" : "Send"}<small>Enter</small></button>
            <button id="followUp" class="secondary-action ${isRunning ? "" : "hidden"}" ${isController ? "" : "disabled"}>Follow-up<small>Alt+Enter</small></button>
            <button id="abort" class="${isRunning ? "danger" : "hidden"}" ${isController ? "" : "disabled"}>Abort</button>
          </div>
        </footer>
      </main>
      ${this.renderRightPanel()}
      ${this.renderTreeDrawer()}
    `;
    this.forceFullRender = false;
    this.dirtyTranscriptIds.clear();
    this.bindEvents();
    this.hydrateTranscriptRows();
    if (restorePromptFocus || this.focusPromptOnNextReadyRender) {
      const nextPrompt = this.querySelector<HTMLTextAreaElement>("#prompt");
      if (nextPrompt && !nextPrompt.disabled) {
        nextPrompt.focus();
        const max = nextPrompt.value.length;
        const start = this.focusPromptOnNextReadyRender ? max : Math.min(promptSelectionStart, max);
        const end = this.focusPromptOnNextReadyRender ? max : Math.min(promptSelectionEnd, max);
        nextPrompt.setSelectionRange(start, end);
        if (!this.focusPromptOnNextReadyRender || this.connectionState === "connected") this.focusPromptOnNextReadyRender = false;
      }
    }
    this.syncTranscriptScroll();
    this.syncAutocompleteScroll();
    recordPerfSample("render", performance.now() - renderStart);
  }
}

customElements.define("pi-web-agent", PiWebAgentApp);
