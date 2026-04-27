import { marked } from "marked";
import { escapeHtml, isRecord, pathBasename, pathParent, recordPerfSample, stringify } from "./utils";

export type TranscriptKind = "user" | "assistant" | "tool" | "question" | "system" | "error";
export type TranscriptSegment =
  | { kind: "markdown"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; label: string }
  | { kind: "image"; label: string; src?: string }
  | { kind: "pre"; text: string };

export type TranscriptItem = {
  id: string;
  kind: TranscriptKind;
  title: string;
  body: string;
  segments?: TranscriptSegment[];
  status?: "running" | "done" | "error";
  raw?: unknown;
};

export type RenderContext = {
  cache?: Map<string, string> | undefined;
  localImageUrl?: ((path: string) => string | null) | undefined;
  suppressLocalImageArtifactPaths?: Set<string> | undefined;
};

export type ToolGroupPosition = "single" | "start" | "middle" | "end";

const imageFailureHandlerAttr = ` onerror="window.__piWebImageFailed?.(this.currentSrc||this.src);this.closest('figure')?.remove();this.remove()"`;

function createMarkdownRenderer(localImageUrl?: RenderContext["localImageUrl"]) {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safeHref = sanitizeUrl(href);
    if (!safeHref) return label;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noreferrer noopener">${label}</a>`;
  };
  renderer.image = function ({ href, title, text }) {
    const safeHref = resolveImageHref(href, localImageUrl);
    if (!safeHref) return escapeHtml(text || "image");
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy"${imageFailureHandlerAttr} />`;
  };
  return renderer;
}

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

function isExternalOrRootHref(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value);
}

function isLocalImageHref(value: string): boolean {
  return !isExternalOrRootHref(value) || value.startsWith("/") || /^file:\/\//i.test(value);
}

function resolveImageHref(value: string, localImageUrl?: RenderContext["localImageUrl"]): string | null {
  const safeHref = sanitizeUrl(value);
  if (!safeHref) return null;
  if (isLocalImageHref(value)) return localImageUrl?.(value) ?? null;
  return safeHref;
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

export function renderMarkdown(value: string, localImageUrl?: RenderContext["localImageUrl"]): string {
  return marked.parse(value, { async: false, gfm: true, breaks: false, renderer: createMarkdownRenderer(localImageUrl) });
}

const localImagePathPattern = /(?:^|[\s([{"'`])((?:(?:file:\/\/)?\/|\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.(?:png|jpe?g|gif|webp|svg))(?![\w.-])/gi;

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

const markdownImageHrefPattern = /!\[[^\]]*\]\(\s*<?([^\s>)]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi;

function markdownLocalImagePaths(text: string, localImageUrl?: RenderContext["localImageUrl"]): Set<string> {
  const paths = new Set<string>();
  if (!localImageUrl) return paths;
  for (const match of text.matchAll(markdownImageHrefPattern)) {
    const href = match[1]?.replace(/^\.\//, "");
    if (!href || !isLocalImageHref(href) || !localImageUrl(href)) continue;
    paths.add(href);
  }
  return paths;
}

function mergeSuppressedPaths(...sets: Array<Set<string> | undefined>): Set<string> | undefined {
  const merged = new Set<string>();
  for (const set of sets) for (const value of set ?? []) merged.add(value);
  return merged.size ? merged : undefined;
}

function renderLocalImageArtifacts(text: string, localImageUrl?: RenderContext["localImageUrl"], suppressedPaths?: Set<string>): string {
  const artifacts = localImageArtifacts(text, localImageUrl, suppressedPaths);
  if (artifacts.length === 0) return "";
  return `<div class="artifact-image-grid">${artifacts.map((artifact) => {
    const fileName = pathBasename(artifact.path);
    const parent = pathParent(artifact.path);
    const showParent = parent && parent !== artifact.path && parent !== fileName;
    return `
    <figure class="artifact-image">
      <img src="${escapeHtml(artifact.url)}" alt="${escapeHtml(artifact.path)}" loading="lazy"${imageFailureHandlerAttr} />
      <figcaption title="${escapeHtml(artifact.path)}">${showParent ? `<small>${escapeHtml(parent)}/</small>` : ""}<strong>${escapeHtml(fileName)}</strong></figcaption>
    </figure>`;
  }).join("")}</div>`;
}

export function looksLikeHtml(value: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<body[\s>]|<article[\s>]|<section[\s>]|<div[\s>])/i.test(value);
}

export function looksLikeSvg(value: string): boolean {
  return /^\s*<svg[\s>]/i.test(value);
}

export function looksLikeMarkdown(value: string): boolean {
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

export function formatToolTitle(name: unknown, args: unknown): string {
  const toolName = String(name ?? "tool");
  const toolArgs = isRecord(args) ? args : {};
  if (toolName === "bash" && toolArgs.command) return `$ ${String(toolArgs.command)}`;
  if (toolName === "ask_question") return "Question";
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

export function toolResultToText(result: unknown): string {
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

export function toolResultToSegments(result: unknown): TranscriptSegment[] {
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

export function questionSummaryFromTool(item: TranscriptItem): TranscriptItem | null {
  if (item.kind !== "tool" || item.status !== "done") return null;
  const raw = isRecord(item.raw) ? item.raw : {};
  const toolName = String(raw.toolName ?? raw.name ?? "");
  const result = isRecord(raw.result) ? raw.result : raw;
  const details = isRecord(result.details) ? result.details : isRecord(raw.details) ? raw.details : null;
  if (toolName !== "ask_question" && !details?.questionId && !details?.question) return null;
  if (!details || typeof details.question !== "string") return null;
  const cancelled = details.cancelled === true;
  const answer = cancelled ? "Cancelled" : String(details.answer ?? details.optionLabel ?? "").trim();
  const wasCustom = details.wasCustom === true;
  const selected = typeof details.selectedIndex === "number" ? `Option ${details.selectedIndex + 1}` : wasCustom ? "Custom answer" : "Answer";
  const body = [`Q: ${details.question}`, `A: ${answer || "—"}`].join("\n");
  return {
    id: `question:${item.id}`,
    kind: "question",
    title: cancelled ? "Question cancelled" : `Answered question · ${selected}`,
    body,
    segments: [{ kind: "pre", text: body }],
    status: cancelled ? "error" : "done",
    raw: { sourceToolId: item.id, details },
  };
}

export function toolArgsToText(args: unknown): string {
  if (!isRecord(args)) return stringify(args);
  if (typeof args.question === "string") {
    const lines = [`Q: ${args.question}`];
    if (typeof args.recommendation === "string" && args.recommendation.trim()) lines.push(`Recommended: ${args.recommendation}`);
    if (Array.isArray(args.options) && args.options.length > 0) lines.push(`${args.options.length} option${args.options.length === 1 ? "" : "s"}`);
    return lines.join("\n");
  }
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

export function itemHasRenderedImage(item: TranscriptItem): boolean {
  return Boolean(item.segments?.some((segment) => segment.kind === "image" && segment.src));
}

function itemHasLocalImageArtifacts(item: TranscriptItem, localImageUrl?: RenderContext["localImageUrl"], suppressedPaths?: Set<string>): boolean {
  if (!localImageUrl) return false;
  return Boolean((item.segments?.length ? item.segments : [{ kind: "pre", text: item.body } satisfies TranscriptSegment])
    .some((segment) => "text" in segment && localImageArtifacts(segment.text, localImageUrl, suppressedPaths).length > 0));
}

export function isToolCallOnlyAssistant(item: TranscriptItem): boolean {
  const segments = item.segments;
  return item.kind === "assistant" && segments !== undefined && segments.length > 0 && segments.every((segment) => segment.kind === "toolCall" || segment.kind === "thinking");
}

export function isRenderableTranscriptItem(item: TranscriptItem): boolean {
  if (item.kind !== "assistant") return true;
  if (item.body.trim()) return true;
  const segments = item.segments ?? [];
  return segments.some((segment) => {
    if (segment.kind === "toolCall" || segment.kind === "thinking") return false;
    if ("text" in segment) return segment.text.trim().length > 0;
    return Boolean(segment.src || segment.label.trim());
  });
}

export function toolCallTitlesForItem(item: TranscriptItem): string[] {
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

export function shouldPreferPendingToolTitle(item: TranscriptItem): boolean {
  return item.kind === "tool" && /^(?:tool result(?::|$)|tool$)/i.test(item.title.trim());
}

export function compactSnapshotTranscript(items: TranscriptItem[]): TranscriptItem[] {
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
    const questionSummary = questionSummaryFromTool(nextItem);
    if (questionSummary) compacted.push(questionSummary);
  }
  return compacted;
}

export function compactToolSummaryLine(part: string): string | null {
  const withoutAnsi = part.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  if (!withoutAnsi) return null;
  if (/^exit code:\s*0$/i.test(withoutAnsi)) return null;
  if (/^(?:running|starting|completed?)\b.*\btool\b/i.test(withoutAnsi)) return null;
  if (/^(?:command\s+)?completed successfully\.?$/i.test(withoutAnsi)) return null;
  if (/^(?:stdout|stderr):\s*$/i.test(withoutAnsi)) return null;
  const stderrMatch = /^stderr:\s*(.+)$/i.exec(withoutAnsi);
  if (stderrMatch) return `stderr: ${stderrMatch[1]!.trim()}`;
  return withoutAnsi.replace(/^stdout:\s*/i, "").replace(/\s+/g, " ").trim() || null;
}

function compactToolSummary(item: TranscriptItem): string {
  if (item.kind !== "tool" || item.status !== "done") return "";
  const source = item.body || item.segments?.map((segment) => "text" in segment ? segment.text : segment.label).join("\n") || "";
  const rawLines = source
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const usefulLines = rawLines
    .map(compactToolSummaryLine)
    .filter((line): line is string => Boolean(line));
  if (usefulLines.length === 0) return rawLines.length > 0 ? `${rawLines.length} line${rawLines.length === 1 ? "" : "s"} output` : "completed";

  const firstLine = usefulLines[0]!;
  const lastLine = usefulLines.at(-1)!;
  const prefix = usefulLines.length > 8 ? `${usefulLines.length} lines · ` : "";
  const middle = usefulLines.length > 8 && lastLine !== firstLine ? `${firstLine} … ${lastLine}` : firstLine;
  const summary = `${prefix}${middle}`;
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

export function mergeDuplicateToolResult(previous: TranscriptItem, current: TranscriptItem): boolean {
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

export function renderTranscriptSegments(item: TranscriptItem, showThinking: boolean, context: RenderContext = {}): string {
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
        const markdownImagePaths = markdownLocalImagePaths(segment.text, context.localImageUrl);
        const suppressedPaths = mergeSuppressedPaths(context.suppressLocalImageArtifactPaths, markdownImagePaths);
        return `<div class="markdown-body">${renderMarkdown(segment.text, context.localImageUrl)}${renderLocalImageArtifacts(segment.text, context.localImageUrl, suppressedPaths)}</div>`;
      }
      if (segment.kind === "thinking") {
        const content = showThinking ? renderMarkdown(segment.text) : "<p>Thinking...</p>";
        return `<div class="markdown-body thinking-trace">${content}</div>`;
      }
      if (segment.kind === "toolCall") return `<div class="inline-tool-call">${escapeHtml(segment.label)}</div>`;
      if (segment.kind === "image") {
        return segment.src
          ? `<figure class="inline-image rendered-image"><img src="${escapeHtml(segment.src)}" alt="${escapeHtml(segment.label)}" loading="lazy"${imageFailureHandlerAttr} /><figcaption>${escapeHtml(segment.label)}</figcaption></figure>`
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

export class PiTranscriptRow extends HTMLElement {
  private item: TranscriptItem | null = null;
  private showThinking = false;
  private selected = false;
  private collapsed = false;
  private actionMenuOpen = false;
  private canFork = false;
  private afterRunningTool = false;
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
        if (this.item) this.setState(this.item, { showThinking: this.showThinking, selected: this.selected, actionMenuOpen: this.actionMenuOpen, canFork: this.canFork, afterRunningTool: this.afterRunningTool, toolGroupPosition: this.toolGroupPosition });
        else this.classList.toggle("collapsed", this.collapsed);
      }
    });
  }

  setState(item: TranscriptItem, options: { showThinking: boolean; selected: boolean; actionMenuOpen?: boolean; canFork?: boolean; afterRunningTool?: boolean; toolGroupPosition?: ToolGroupPosition; cache?: Map<string, string>; localImageUrl?: (path: string) => string | null; suppressLocalImageArtifactPaths?: Set<string> }): void {
    const start = performance.now();
    const previous = this.item;
    const wasSelected = this.selected;
    this.item = item;
    this.showThinking = options.showThinking;
    this.selected = options.selected;
    this.actionMenuOpen = options.actionMenuOpen ?? false;
    this.canFork = options.canFork ?? false;
    this.afterRunningTool = options.afterRunningTool ?? false;
    this.toolGroupPosition = options.toolGroupPosition ?? "single";
    const isCollapsible = this.isCollapsible();
    const completedDoneTool = item.kind === "tool" && item.status === "done";
    const isQuestionTool = item.kind === "tool" && item.title === "Question";
    const hasVisualResult = itemHasRenderedImage(item) || itemHasLocalImageArtifacts(item, options.localImageUrl, options.suppressLocalImageArtifactPaths);
    const defaultOpen = (item.status === "running" && !isQuestionTool) || item.status === "error" || (hasVisualResult && item.status !== "done") || (options.selected && !completedDoneTool && !isQuestionTool);
    const completedSuccessfully = previous?.id === item.id && previous.status === "running" && item.status === "done";
    if (!previous || previous.id !== item.id || completedSuccessfully) this.collapsed = isCollapsible && !defaultOpen;
    if (options.selected && !wasSelected && !completedDoneTool) this.collapsed = false;

    this.dataset.transcriptId = item.id;
    this.className = this.classNames();

    const streamingText = this.streamingText();
    const canPatchText = Boolean(streamingText !== null && this.lastStreamingText !== "" && this.querySelector(".streaming-plain pre"));
    const compactSummary = this.collapsed ? compactToolSummary(item) : "";
    const renderKey = `${item.id}:${item.kind}:${item.title}:${item.status ?? ""}:${this.showThinking}:${this.selected}:${this.collapsed}:${isCollapsible}:${compactSummary}:${this.actionMenuOpen}:${this.canFork}:${this.afterRunningTool}:${this.toolGroupPosition}:${streamingText !== null ? "streaming" : item.body}`;
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
      <div class="message-body">${this.collapsed ? "" : renderTranscriptSegments(item, this.showThinking, { cache: options.cache, localImageUrl: options.localImageUrl, suppressLocalImageArtifactPaths: options.suppressLocalImageArtifactPaths })}</div>`;
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
    const afterRunningClass = this.item.kind === "tool" && this.item.status === "done" && this.afterRunningTool ? "after-running-tool" : "";
    return ["message", this.item.kind, this.item.status ?? "", groupClass, afterRunningClass, this.selected ? "selected" : "", this.isCollapsible() ? "collapsible" : "", this.collapsed ? "collapsed" : ""].filter(Boolean).join(" ");
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

export function compactWorkflowLaunchSummary(text: string): string | null {
  const workflowMatch = /^Run the bundled `([^`]+)` workflow skill for this coding session\./m.exec(text);
  if (!workflowMatch) return null;
  const command = workflowMatch[1] ?? "workflow";
  const focusMatch = /^Operator-provided focus:\s*(.+)$/m.exec(text);
  const focus = focusMatch?.[1]?.replace(/\s+/g, " ").trim();
  return [`Launched /${command} workflow`, focus ? `Focus: ${focus}` : ""].filter(Boolean).join(" · ");
}

function compactWorkflowLaunch(text: string): { body: string; segments: TranscriptSegment[] } | null {
  const summary = compactWorkflowLaunchSummary(text);
  if (!summary) return null;
  const body = summary.replace(" · Focus:", ".\nFocus:");
  return { body, segments: [{ kind: "markdown", text: body }] };
}

export function messageToTranscriptItem(message: unknown, fallbackId: string): TranscriptItem {
  if (!isRecord(message)) {
    return { id: fallbackId, kind: "system", title: "Event", body: stringify(message), raw: message };
  }

  const role = String(message.role ?? "message");
  const segments = contentToSegments(message.content);
  const body = contentToText(message.content);
  if (role === "user") {
    const compact = compactWorkflowLaunch(body);
    return { id: messageKey(message, fallbackId), kind: "user", title: "You", body: compact?.body ?? body, segments: compact?.segments ?? segments, raw: message };
  }
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
