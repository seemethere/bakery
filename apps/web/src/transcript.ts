import { LEGACY_FULL_PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER, PLAN_ACTIONS_MARKER, type UiActionContribution } from "@pi-web-agent/protocol";
import ConvertAnsi from "ansi-to-html";
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
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  raw?: unknown;
};

export type RenderContext = {
  cache?: Map<string, string> | undefined;
  localImageUrl?: ((path: string) => string | null) | undefined;
  suppressLocalImageArtifactPaths?: Set<string> | undefined;
};

export type ToolGroupPosition = "single" | "start" | "middle" | "end";

export { PLAN_ACTIONS_MARKER };
const planActionMarkers = [PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER, LEGACY_FULL_PLAN_ACTIONS_MARKER];
const escapedPlanActionMarkers = planActionMarkers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const planActionsMarkerPattern = new RegExp(`(?:\\n\\s*)?(?:${escapedPlanActionMarkers})\\s*$`);

type UiActionContributionMatcher = {
  contribution: UiActionContribution;
  matches: (item: TranscriptItem) => boolean;
};

export const PLAN_UI_ACTION_CONTRIBUTION: UiActionContribution = {
  id: "bakery.workflow.plan.actions",
  placement: "composer_takeover",
  title: "Plan ready",
  description: "Accept to prepare the composer with this implementation plan.",
  source: { extensionId: "bakery.workflow", commandName: "plan" },
  actions: [
    { id: "accept", label: "Accept plan", variant: "primary" },
  ],
};

const UI_ACTION_CONTRIBUTION_MATCHERS: UiActionContributionMatcher[] = [
  {
    contribution: PLAN_UI_ACTION_CONTRIBUTION,
    matches: (item) => item.kind === "assistant" && planActionsMarkerPattern.test(item.body),
  },
];

export function stripPlanActionsMarker(text: string): string {
  return text.replace(planActionsMarkerPattern, "").trimEnd();
}

type PlanSectionId = "Plan summary" | "Smallest next slice" | "Key files likely to change" | "Validation plan";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMarkdownSection(text: string, heading: PlanSectionId): string {
  const pattern = new RegExp(`(?:^|\\n)##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return text.match(pattern)?.[1]?.trim() ?? "";
}

function plainTextSummary(text: string, maxLength: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxLength) return plain;
  return `${plain.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function renderPlanCard(item: TranscriptItem, strippedBody: string, localImageUrl?: RenderContext["localImageUrl"]): string {
  const summary = extractMarkdownSection(strippedBody, "Plan summary") || plainTextSummary(strippedBody, 220) || "Review the recommended implementation plan.";
  const nextSlice = extractMarkdownSection(strippedBody, "Smallest next slice");
  const files = extractMarkdownSection(strippedBody, "Key files likely to change");
  const validation = extractMarkdownSection(strippedBody, "Validation plan");
  return `<article class="plan-card" role="button" tabindex="0" data-plan-detail-id="${escapeHtml(item.id)}" aria-label="Open full plan">
      <div class="plan-card-header">
        <span class="plan-card-kicker">Plan ready</span>
        <span class="plan-card-open-hint">Full plan ↗</span>
      </div>
      <div class="plan-card-summary">${renderMarkdown(summary, localImageUrl)}</div>
      ${nextSlice ? `<section class="plan-card-section"><h3>Smallest next slice</h3>${renderMarkdown(nextSlice, localImageUrl)}</section>` : ""}
      ${files ? `<section class="plan-card-section compact"><h3>Key files</h3>${renderMarkdown(files, localImageUrl)}</section>` : ""}
      ${validation ? `<section class="plan-card-section compact"><h3>Validation</h3>${renderMarkdown(validation, localImageUrl)}</section>` : ""}
      <div class="plan-card-actions">
        <span class="plan-card-click-copy">Click the card to read the full rendered plan.</span>
        <button type="button" class="primary-action" data-ui-action="accept" data-plan-action="accept" data-ui-contribution-id="${escapeHtml(PLAN_UI_ACTION_CONTRIBUTION.id)}" data-transcript-id="${escapeHtml(item.id)}">Accept plan</button>
      </div>
    </article>`;
}

type MetadataDetailsCardData = {
  kind: "metadata_details_result";
  applied: string[];
  skipped: Array<{ field?: unknown; reason?: unknown }>;
  deferred?: boolean;
  title?: string;
  summary?: string;
  reason?: string;
};

export function metadataDetailsCardData(item: TranscriptItem): MetadataDetailsCardData | null {
  if (!isRecord(item.raw) || !isRecord(item.raw.data)) return null;
  const data = item.raw.data;
  if (data.kind !== "metadata_details_result") return null;
  return {
    kind: "metadata_details_result",
    applied: Array.isArray(data.applied) ? data.applied.map(String) : [],
    skipped: Array.isArray(data.skipped) ? data.skipped.filter(isRecord) : [],
    ...(typeof data.deferred === "boolean" ? { deferred: data.deferred } : {}),
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
  };
}

function renderMetadataDetailsCard(data: MetadataDetailsCardData): string {
  const applied = new Set(data.applied);
  const skipped = data.skipped.map((entry) => ({ field: String(entry.field ?? "field"), reason: String(entry.reason ?? "protected") }));
  const status = data.deferred ? "Could not generate details yet" : applied.size > 0 ? "Session details updated" : skipped.length > 0 ? "Manual details protected" : "No details changed";
  const kicker = data.deferred ? "Try again later" : applied.size > 0 ? "Generated details" : "Generate details";
  const titleStatus = applied.has("title") ? "Updated" : skipped.some((entry) => entry.field === "title") ? "Protected" : data.title ? "Suggested" : "No change";
  const summaryStatus = applied.has("summary") ? "Updated" : skipped.some((entry) => entry.field === "summary") ? "Protected" : data.summary ? "Suggested" : "No change";
  return `<article class="metadata-details-card ${data.deferred ? "deferred" : ""}" aria-label="Session metadata generation result">
    <div class="metadata-details-card-header">
      <span class="metadata-details-icon" aria-hidden="true">✦</span>
      <div>
        <span class="metadata-details-kicker">${escapeHtml(kicker)}</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
    </div>
    <div class="metadata-details-grid">
      <section class="metadata-details-field ${applied.has("title") ? "updated" : ""}">
        <span>${escapeHtml(titleStatus)}</span>
        <h3>Title</h3>
        <p>${escapeHtml(data.title || "No generated title returned.")}</p>
      </section>
      <section class="metadata-details-field ${applied.has("summary") ? "updated" : ""}">
        <span>${escapeHtml(summaryStatus)}</span>
        <h3>Summary</h3>
        <p>${escapeHtml(data.summary || "No generated summary returned.")}</p>
      </section>
    </div>
    ${skipped.length > 0 ? `<div class="metadata-details-note">${skipped.map((entry) => `Skipped ${escapeHtml(entry.field)}: ${escapeHtml(entry.reason)}. Use <code>--replace</code> to overwrite.`).join(" ")}</div>` : ""}
    ${data.deferred && data.reason ? `<div class="metadata-details-note">${escapeHtml(data.reason)}</div>` : ""}
  </article>`;
}

export function uiActionContributionForTranscriptItem(item: TranscriptItem): UiActionContribution | null {
  return UI_ACTION_CONTRIBUTION_MATCHERS.find((matcher) => matcher.matches(item))?.contribution ?? null;
}

export function hasPlanActionsMarker(item: TranscriptItem): boolean {
  return uiActionContributionForTranscriptItem(item) !== null;
}

export function isDeveloperBashItem(item: TranscriptItem): boolean {
  if (item.kind !== "tool") return false;
  if (item.id.startsWith("bash:")) return true;
  if (!isRecord(item.raw)) return false;
  return item.raw.role === "bashExecution" || String(item.raw.type ?? "").startsWith("bash_execution_");
}

export function isDeveloperBashNoContextItem(item: TranscriptItem): boolean {
  if (!isDeveloperBashItem(item)) return false;
  if (isRecord(item.raw) && item.raw.excludeFromContext === true) return true;
  return /\(no context\)/i.test(item.title);
}

const imageFailureHandlerAttr = ` onerror="window.__piWebImageFailed?.(this.currentSrc||this.src);this.closest('figure')?.remove();this.remove()"`;
const ansiConverter = new ConvertAnsi({
  escapeXML: true,
  newline: false,
  stream: false,
  fg: "var(--terminal-fg)",
  bg: "transparent",
  colors: {
    0: "#000000",
    1: "#c91b00",
    2: "#00c200",
    3: "#c7c400",
    4: "#0225c7",
    5: "#ca30c7",
    6: "#00c5c7",
    7: "#c7c7c7",
    8: "#676767",
    9: "#ff6e67",
    10: "#5ffa68",
    11: "#fffc67",
    12: "#6871ff",
    13: "#ff77ff",
    14: "#5ffdff",
    15: "#ffffff",
  },
});

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
    return `<img class="transcript-markdown-image" src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" decoding="async"${imageFailureHandlerAttr} />`;
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

function promptAttachmentArtifactPaths(text: string, localImageUrl?: RenderContext["localImageUrl"]): Set<string> {
  const paths = new Set<string>();
  if (!localImageUrl) return paths;
  for (const match of text.matchAll(/^\s*Screenshot artifact:\s*(\S+\.(?:png|jpe?g|gif|webp|svg))\s*$/gim)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path || !localImageUrl(path)) continue;
    paths.add(path);
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
      <img src="${escapeHtml(artifact.url)}" alt="${escapeHtml(artifact.path)}" loading="lazy" decoding="async"${imageFailureHandlerAttr} />
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

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 10_000) return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatRunningToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return formatToolDuration(durationMs);
}

export type ToolHeaderDisplay = {
  action: string;
  target: string;
};

function toolHeaderFromTitle(title: string): ToolHeaderDisplay {
  const trimmed = title.trim();
  if (!trimmed) return { action: "tool", target: "" };
  if (trimmed.startsWith("$ ")) return { action: "bash", target: trimmed.slice(2).trim() };
  const match = /^(read|edit|write|grep|find)\s+(.+)$/i.exec(trimmed);
  if (match) return { action: match[1]!.toLowerCase(), target: match[2]!.trim() };
  if (/^question$/i.test(trimmed)) return { action: "question", target: "operator input" };
  const [first = "tool", ...rest] = trimmed.split(/\s+/);
  return { action: first.toLowerCase(), target: rest.join(" ").trim() };
}

export function toolHeaderDisplay(item: TranscriptItem): ToolHeaderDisplay {
  if (item.kind !== "tool") return { action: item.title, target: "" };
  const raw = isRecord(item.raw) ? item.raw : {};
  const args = isRecord(raw.args) ? raw.args : {};
  const rawName = typeof raw.toolName === "string" ? raw.toolName : typeof raw.name === "string" ? raw.name : "";
  const action = rawName ? rawName.toLowerCase() : "";
  if (action === "bash" && typeof args.command === "string") return { action: "bash", target: args.command };
  if ((action === "read" || action === "edit" || action === "write") && typeof args.path === "string") return { action, target: args.path };
  if ((action === "grep" || action === "find") && typeof args.pattern === "string") return { action, target: args.pattern };
  if (action === "ask_question") return { action: "question", target: typeof args.question === "string" ? args.question : "operator input" };
  return toolHeaderFromTitle(item.title);
}

export function shouldShowToolDuration(item: TranscriptItem, collapsed: boolean): boolean {
  if (item.kind !== "tool" || item.durationMs === undefined) return false;
  if (!collapsed) return true;
  return item.durationMs >= 1_000;
}

function compactToolSummary(item: TranscriptItem): string {
  if (item.kind !== "tool" || item.status !== "done") return "";
  const segmentText = item.segments?.map((segment) => "text" in segment ? segment.text : segment.label).join("\n") ?? "";
  const source = segmentText || item.body || "";
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

export function mergeDuplicateDeveloperBash(previous: TranscriptItem, current: TranscriptItem): boolean {
  if (!isDeveloperBashItem(previous) || !isDeveloperBashItem(current)) return false;
  if (previous.title !== current.title) return false;
  if (previous.status !== "running") return false;

  previous.body = current.body || previous.body;
  if (current.segments) previous.segments = current.segments;
  if (current.status) previous.status = current.status;
  if (current.startedAt) previous.startedAt = current.startedAt;
  if (current.endedAt) previous.endedAt = current.endedAt;
  if (current.durationMs !== undefined) previous.durationMs = current.durationMs;
  previous.raw = { previous: previous.raw, duplicateBashExecution: current.raw };
  return true;
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
  const segmentKey = item.segments?.map((segment) => {
    if ("text" in segment) return `${segment.kind}:${segment.text}`;
    return `${segment.kind}:${segment.label}:${segment.kind === "image" ? segment.src ?? "" : ""}`;
  }).join("|") ?? "";
  const cacheKey = `${item.id}:${item.kind}:${item.status ?? ""}:${showThinking}:${item.body}:${segmentKey}:${context.localImageUrl ? "assets" : ""}:${suppressedKey}`;
  const cached = context.cache?.get(cacheKey);
  if (cached !== undefined) return cached;

  const segments = item.segments?.length ? item.segments : [{ kind: item.kind === "tool" || item.kind === "system" || item.kind === "error" ? "pre" : "markdown", text: item.body } satisfies TranscriptSegment];
  const usePlainStreamingText = item.status === "running" && (item.kind === "assistant" || item.kind === "user");
  const usePlainStreamingToolOutput = item.status === "running" && item.kind === "tool";
  const rendered = segments
    .map((segment) => {
      if (segment.kind === "markdown") {
        if (usePlainStreamingText) return `<div class="markdown-body streaming-plain"><pre>${escapeHtml(segment.text)}</pre></div>`;
        const markdownImagePaths = markdownLocalImagePaths(segment.text, context.localImageUrl);
        const attachedImageArtifactPaths = item.kind === "user" && itemHasRenderedImage(item) ? promptAttachmentArtifactPaths(segment.text, context.localImageUrl) : undefined;
        const suppressedPaths = mergeSuppressedPaths(context.suppressLocalImageArtifactPaths, markdownImagePaths, attachedImageArtifactPaths);
        return `<div class="markdown-body">${renderMarkdown(segment.text, context.localImageUrl)}${renderLocalImageArtifacts(segment.text, context.localImageUrl, suppressedPaths)}</div>`;
      }
      if (segment.kind === "thinking") {
        const content = showThinking ? renderMarkdown(segment.text) : "<p>Thinking...</p>";
        return `<div class="markdown-body thinking-trace">${content}</div>`;
      }
      if (segment.kind === "toolCall") return "";
      if (segment.kind === "image") {
        return segment.src
          ? `<figure class="inline-image rendered-image"><img src="${escapeHtml(segment.src)}" alt="${escapeHtml(segment.label)}" loading="lazy" decoding="async"${imageFailureHandlerAttr} /><figcaption>${escapeHtml(segment.label)}</figcaption></figure>`
          : `<div class="inline-image">${escapeHtml(segment.label)}</div>`;
      }
      const terminalText = item.kind === "tool" && !usePlainStreamingToolOutput ? ansiConverter.toHtml(segment.text) : escapeHtml(segment.text);
      return `${item.kind === "tool" ? '<div class="terminal-window" aria-label="Terminal output">' : ""}<pre class="${item.kind === "tool" ? `terminal-output${usePlainStreamingToolOutput ? " tool-streaming-output" : ""}` : ""}">${terminalText}</pre>${item.kind === "tool" ? "</div>" : ""}${renderLocalImageArtifacts(segment.text, context.localImageUrl, context.suppressLocalImageArtifactPaths)}`;
    })
    .join("");
  if (context.cache) {
    if (context.cache.size > 300) context.cache.clear();
    context.cache.set(cacheKey, rendered);
  }
  return rendered;
}

function copyIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2.2"></rect><path d="M5 16V7a2 2 0 0 1 2-2h9"></path></svg>`;
}

function forkIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6" r="2.5"></circle><circle cx="17" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M7 8.5v2.2c0 1.7 1 3.2 2.6 3.9L12 15.7l2.4-1.1A4.3 4.3 0 0 0 17 10.7V8.5"></path><path d="M12 15.7V18"></path></svg>`;
}

function ellipsisIconSvg(): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="18" cy="12" r="1.6"></circle></svg>`;
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
      if (target?.closest(".message-action-area, .message-action-bar, .message-expand-toggle")) return;
    });
  }

  setState(item: TranscriptItem, options: { showThinking: boolean; selected: boolean; expanded?: boolean | undefined; actionMenuOpen?: boolean; canFork?: boolean; afterRunningTool?: boolean; toolGroupPosition?: ToolGroupPosition; cache?: Map<string, string>; localImageUrl?: (path: string) => string | null; suppressLocalImageArtifactPaths?: Set<string> }): void {
    const start = performance.now();
    this.item = item;
    this.showThinking = options.showThinking;
    this.selected = options.selected;
    this.actionMenuOpen = options.actionMenuOpen ?? false;
    this.canFork = options.canFork ?? false;
    this.afterRunningTool = options.afterRunningTool ?? false;
    this.toolGroupPosition = options.toolGroupPosition ?? "single";
    const isCollapsible = this.isCollapsible();
    const isQuestionTool = item.kind === "tool" && item.title === "Question";
    const hasVisualResult = itemHasRenderedImage(item) || itemHasLocalImageArtifacts(item, options.localImageUrl, options.suppressLocalImageArtifactPaths);
    const isDeveloperBash = isDeveloperBashItem(item);
    const defaultOpen = item.kind === "system" || isDeveloperBash || (item.kind !== "tool" && item.status === "error") || (hasVisualResult && item.status !== "done");
    const expanded = isCollapsible ? (options.expanded ?? defaultOpen) : true;
    this.collapsed = isCollapsible && !expanded;

    this.dataset.transcriptId = item.id;
    this.className = this.classNames();

    const streamingText = this.streamingText();
    const streamingTextTarget = streamingText !== null ? this.querySelector<HTMLElement>(this.item?.kind === "tool" ? ".tool-streaming-output" : ".streaming-plain pre") : null;
    const canPatchText = Boolean(streamingText !== null && this.lastStreamingText !== "" && streamingTextTarget);
    const compactSummary = this.collapsed && item.kind !== "tool" ? compactToolSummary(item) : "";
    const toolDisplay = item.kind === "tool" ? toolHeaderDisplay(item) : null;
    const visibleDuration = shouldShowToolDuration(item, this.collapsed);
    const segmentKey = item.segments?.map((segment) => {
      if ("text" in segment) return `${segment.kind}:${segment.text}`;
      return `${segment.kind}:${segment.label}:${segment.kind === "image" ? segment.src ?? "" : ""}`;
    }).join("|") ?? "";
    const renderKey = `${item.id}:${item.kind}:${item.title}:${item.status ?? ""}:${item.startedAt ?? ""}:${item.endedAt ?? ""}:${item.durationMs ?? ""}:${toolDisplay?.action ?? ""}:${toolDisplay?.target ?? ""}:${visibleDuration}:${this.showThinking}:${this.collapsed}:${isCollapsible}:${compactSummary}:${this.actionMenuOpen}:${this.canFork}:${streamingText !== null ? "streaming" : `${item.body}:${segmentKey}`}`;
    if (renderKey === this.lastRenderKey) {
      if (canPatchText && streamingText !== this.lastStreamingText) {
        streamingTextTarget!.textContent = streamingText ?? "";
        this.pinRunningToolOutputToBottom(item);
        this.lastStreamingText = streamingText ?? "";
      }
      recordPerfSample("rowUpdate", performance.now() - start);
      return;
    }

    const hasPlanActions = hasPlanActionsMarker(item);
    const metadataDetails = metadataDetailsCardData(item);
    const strippedPlanBody = hasPlanActions ? stripPlanActionsMarker(item.body) : "";
    const renderedItem = hasPlanActions ? { ...item, body: strippedPlanBody, segments: strippedPlanBody ? [{ kind: "markdown" as const, text: strippedPlanBody }] : [] } : item;
    const body = this.collapsed ? "" : hasPlanActions ? renderPlanCard(item, strippedPlanBody, options.localImageUrl) : metadataDetails ? renderMetadataDetailsCard(metadataDetails) : renderTranscriptSegments(renderedItem, this.showThinking, { cache: options.cache, localImageUrl: options.localImageUrl, suppressLocalImageArtifactPaths: options.suppressLocalImageArtifactPaths });
    const isConversationMessage = item.kind === "user" || item.kind === "assistant";
    this.innerHTML = isConversationMessage ? `
      <div class="message-body">${body}</div>
      ${this.renderConversationActionBar(item)}` : `
      <div class="message-header">
        ${isCollapsible ? `<button class="message-expand-toggle" type="button" data-row-action="toggle-output" data-transcript-id="${escapeHtml(item.id)}" aria-expanded="${this.collapsed ? "false" : "true"}" aria-label="${this.collapsed ? "Show output" : "Hide output"}" title="${this.collapsed ? "Show output" : "Hide output"}">${this.collapsed ? "▸" : "▾"}</button>` : ""}
        ${item.kind === "tool" && item.status === "running" ? `<span class="tool-running-spinner" aria-hidden="true"></span>` : ""}
        ${toolDisplay ? `<strong class="tool-action" title="${escapeHtml(toolDisplay.action)}">${escapeHtml(toolDisplay.action)}</strong>${toolDisplay.target ? ` <span class="tool-target" title="${escapeHtml(toolDisplay.target)}">${escapeHtml(toolDisplay.target)}</span>` : ""}` : `<strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>`}
        ${compactSummary ? `<span class="tool-summary">${escapeHtml(compactSummary)}</span>` : ""}
        <span class="message-header-spacer"></span>
        ${visibleDuration ? `<span class="tool-duration">${escapeHtml(formatToolDuration(item.durationMs!))}</span>` : ""}
        ${item.status && !(item.kind === "tool" && this.collapsed) ? `<span class="message-status">${escapeHtml(item.status)}</span>` : ""}
        <div class="message-action-area">
          <button class="message-overflow" type="button" data-row-action="menu" data-transcript-id="${escapeHtml(item.id)}" aria-haspopup="menu" aria-expanded="${this.actionMenuOpen ? "true" : "false"}" title="Message actions">${ellipsisIconSvg()}</button>
          ${this.actionMenuOpen ? this.renderActionMenu(item) : ""}
        </div>
      </div>
      <div class="message-body">${body}</div>`;
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

  private renderConversationActionBar(item: TranscriptItem): string {
    return `
      <div class="message-action-bar">
        <button class="message-action-button" type="button" data-row-action="copy" data-transcript-id="${escapeHtml(item.id)}" aria-label="Copy message" title="Copy message">${copyIconSvg()}</button>
        ${this.canFork ? `<button class="message-action-button" type="button" data-row-action="fork" data-transcript-id="${escapeHtml(item.id)}" aria-label="Fork from here" title="Fork from here">${forkIconSvg()}</button>` : ""}
      </div>`;
  }

  private renderActionMenu(item: TranscriptItem, options: { secondaryOnly?: boolean } = {}): string {
    return `
      <div class="message-action-menu" role="menu">
        ${options.secondaryOnly ? "" : `<button type="button" role="menuitem" data-row-action="copy" data-transcript-id="${escapeHtml(item.id)}">Copy</button>`}
        ${!options.secondaryOnly && this.canFork ? `<button type="button" role="menuitem" data-row-action="fork" data-transcript-id="${escapeHtml(item.id)}">Fork from here</button>` : ""}
      </div>`;
  }

  private isCollapsible(): boolean {
    return this.item?.kind === "tool" || this.item?.kind === "system";
  }

  private classNames(): string {
    if (!this.item) return "message";
    const developerBashClass = isDeveloperBashItem(this.item) ? "developer-bash" : "";
    const noContextClass = isDeveloperBashNoContextItem(this.item) ? "no-context" : "";
    const metadataDetailsClass = metadataDetailsCardData(this.item) ? "metadata-details-result" : "";
    return ["message", this.item.kind, this.item.status ?? "", developerBashClass, noContextClass, metadataDetailsClass, this.selected ? "selected" : "", this.isCollapsible() ? "collapsible" : "", this.collapsed ? "collapsed" : ""].filter(Boolean).join(" ");
  }

  private streamingText(): string | null {
    if (!this.item || this.item.status !== "running") return null;
    if (this.item.kind === "assistant" || this.item.kind === "user") {
      const segments = this.item.segments?.length ? this.item.segments : [{ kind: "markdown", text: this.item.body } satisfies TranscriptSegment];
      return segments.filter((segment): segment is Extract<TranscriptSegment, { kind: "markdown" }> => segment.kind === "markdown").map((segment) => segment.text).join("\n\n");
    }
    if (this.item.kind === "tool") {
      const segments = this.item.segments?.length ? this.item.segments : [{ kind: "pre", text: this.item.body } satisfies TranscriptSegment];
      return segments.filter((segment): segment is Extract<TranscriptSegment, { kind: "pre" }> => segment.kind === "pre").map((segment) => segment.text).join("\n\n");
    }
    return null;
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
  if (role === "bashExecution") {
    const command = String(message.command ?? "bash");
    const output = String(message.output ?? "");
    const status = message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0) ? "error" : "done";
    const suffix = message.excludeFromContext ? " (no context)" : "";
    return {
      id: messageKey(message, fallbackId),
      kind: "tool",
      title: `$ ${command}${suffix}`,
      body: output || "Command completed with no output.",
      segments: [{ kind: "pre", text: output || "Command completed with no output." }],
      status,
      raw: message,
    };
  }
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
