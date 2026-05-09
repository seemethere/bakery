// Core data types and transformation logic for transcript items.
// Ported from apps/web-old/src/transcript.ts and session-events.ts.
import { LEGACY_FULL_PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER, PLAN_ACTIONS_MARKER, type ActiveToolExecutionSnapshot } from "@pi-web-agent/protocol";

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

export type PlanCardData = {
  markdown: string;
  summary: string;
  nextSlice: string;
  keyFiles: string[];
  validation: string;
};

// ---- Helpers ----------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? ""; } catch { return String(value); }
}

function eventTimestamp(event: Record<string, unknown>): string {
  const value = event.endedAt ?? event.timestamp ?? event.eventTime ?? event.time;
  return typeof value === "string" ? value : new Date().toISOString();
}

function eventStartTimestamp(event: Record<string, unknown>, existing?: TranscriptItem): string {
  const value = event.startedAt ?? event.startTime ?? existing?.startedAt ?? event.eventTime ?? event.time;
  return typeof value === "string" ? value : new Date().toISOString();
}

function calcDurationMs(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function messageKey(message: Record<string, unknown>, fallback: string): string {
  const role = String(message.role ?? "message");
  const timestamp = message.timestamp ?? message.id;
  return timestamp ? `${role}:${String(timestamp)}` : fallback;
}

function toolResultMessageKey(message: Record<string, unknown>, fallback: string): string {
  return typeof message.toolCallId === "string" && message.toolCallId.trim() ? `tool:${message.toolCallId}` : messageKey(message, fallback);
}

function webCommandResultToTranscriptItem(event: Record<string, unknown>, fallbackId: string): TranscriptItem {
  return {
    id: String(event.id ?? fallbackId),
    kind: event.isError ? "error" : "system",
    title: String(event.title ?? "Slash command"),
    body: String(event.body ?? ""),
    raw: event,
  };
}

function imagePartToSegment(part: Record<string, unknown>): TranscriptSegment {
  const mimeType = typeof part.mimeType === "string" ? part.mimeType
    : typeof part.mediaType === "string" ? part.mediaType : "image/png";
  const label = `[image${mimeType ? `: ${mimeType}` : ""}]`;
  const rawUrl = typeof part.url === "string" ? part.url : typeof part.src === "string" ? part.src : undefined;
  const rawData = typeof part.data === "string" ? part.data : typeof part.base64 === "string" ? part.base64 : undefined;
  const candidate = rawUrl ?? (rawData ? `data:${mimeType};base64,${rawData}` : undefined);
  return candidate ? { kind: "image", label, src: candidate } : { kind: "image", label };
}

function formatToolCall(part: Record<string, unknown>): string {
  const name = String(part.name ?? part.toolName ?? "tool");
  const args = isRecord(part.arguments) ? part.arguments : isRecord(part.args) ? part.args : {};
  if (name === "read" && args.path) return `↳ read ${String(args.path)}`;
  if (name === "bash" && args.command) return `↳ bash ${String(args.command)}`;
  if ((name === "edit" || name === "write") && args.path) return `↳ ${name} ${String(args.path)}`;
  return `↳ ${name}`;
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

function toolContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  return content.map((part) => {
    if (!isRecord(part)) return stringify(part);
    if (part.type === "text") return String(part.text ?? "");
    if (part.type === "image") return `[image${part.mimeType ? `: ${String(part.mimeType)}` : ""}]`;
    return stringify(part);
  }).filter(Boolean).join("\n");
}

function toolTextToSegment(text: string): TranscriptSegment {
  return /!\[[^\]]*\]\((?:data:image\/|https?:\/\/|file:|\/)[^)]+\)/i.test(text)
    ? { kind: "markdown", text }
    : { kind: "pre", text };
}

function compactWorkflowLaunch(text: string): { body: string; segments: TranscriptSegment[] } | null {
  const match = /^Run the bundled `([^`]+)` workflow skill for this coding session\./m.exec(text);
  if (!match) return null;
  const command = match[1] ?? "workflow";
  const focusMatch = /^Operator-provided focus:\s*(.+)$/m.exec(text);
  const focus = focusMatch?.[1]?.replace(/\s+/g, " ").trim();
  const summary = [`Launched /${command} workflow`, focus ? `Focus: ${focus}` : ""].filter(Boolean).join(" · ");
  const body = summary.replace(" · Focus:", ".\nFocus:");
  return { body, segments: [{ kind: "markdown", text: body }] };
}

const PLAN_MARKERS = [PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER, LEGACY_FULL_PLAN_ACTIONS_MARKER];

function stripPlanMarkers(text: string): string {
  let next = text;
  for (const marker of PLAN_MARKERS) {
    next = next.replaceAll(marker, "");
  }
  return next.trim();
}

function sectionText(markdown: string, heading: string): string {
  const pattern = new RegExp(`^#{1,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$([\\s\\S]*?)(?=\\n#{1,3}\\s+|\\s*$)`, "im");
  const match = pattern.exec(markdown);
  return match?.[1]?.trim() ?? "";
}

function firstPlainLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? "";
}

function listItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function isGeneratingPlan(item: TranscriptItem): boolean {
  return item.kind === "assistant" && item.status === "running" && /^##\s+Plan summary\b/im.test(item.body);
}

export function detectPlanCard(item: TranscriptItem): PlanCardData | null {
  if (item.kind !== "assistant") return null;
  if (!PLAN_MARKERS.some((marker) => item.body.includes(marker))) return null;
  const markdown = stripPlanMarkers(item.body);
  const summaryText = sectionText(markdown, "Plan summary");
  const nextSliceText = sectionText(markdown, "Smallest next slice");
  const filesText = sectionText(markdown, "Key files");
  const validationText = sectionText(markdown, "Validation plan");
  return {
    markdown,
    summary: firstPlainLine(summaryText) || firstPlainLine(markdown) || "Plan ready.",
    nextSlice: firstPlainLine(nextSliceText) || "Proceed with the recommended next slice.",
    keyFiles: listItems(filesText),
    validation: firstPlainLine(validationText) || "Run the selected validation commands.",
  };
}

// ---- Public API: data transformation ----------------------------------------

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
  if (role === "assistant") {
    return { id: messageKey(message, fallbackId), kind: "assistant", title: "Pi", body, segments, raw: message };
  }
  if (role === "webCommandResult") {
    return webCommandResultToTranscriptItem({
      type: "web_command_result",
      id: message.id,
      title: message.title,
      body: message.body,
      isError: message.isError,
      data: message.data,
      time: message.timestamp,
    }, fallbackId);
  }
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
      id: toolResultMessageKey(message, fallbackId),
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
  return parts.filter(Boolean).join("\n\n").trim() || stringify(result);
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

export function isAskQuestionToolItem(item: TranscriptItem): boolean {
  if (item.kind !== "tool") return false;
  const raw = isRecord(item.raw) ? item.raw : {};
  const toolName = String(raw.toolName ?? raw.name ?? "");
  if (toolName === "ask_question") return true;
  const result = isRecord(raw.result) ? raw.result : raw;
  const details = isRecord(result.details) ? result.details : isRecord(raw.details) ? raw.details : null;
  return Boolean(details?.questionId || details?.question || /^question$/i.test(item.title.trim()));
}

function questionSummaryFromTool(item: TranscriptItem): TranscriptItem | null {
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

function isToolCallOnlyAssistant(item: TranscriptItem): boolean {
  const segments = item.segments;
  return item.kind === "assistant" && segments !== undefined && segments.length > 0 &&
    segments.every((s) => s.kind === "toolCall" || s.kind === "thinking");
}

function toolCallTitlesForItem(item: TranscriptItem): string[] {
  return (item.segments ?? [])
    .filter((s): s is Extract<TranscriptSegment, { kind: "toolCall" }> => s.kind === "toolCall")
    .map((s) => {
      const clean = s.label.replace(/^↳\s*/, "").trim();
      const bash = clean.match(/^bash\s+(.+)$/s);
      return bash ? `$ ${bash[1]?.trim() ?? "bash"}` : clean || s.label;
    });
}

function shouldPreferPendingToolTitle(item: TranscriptItem): boolean {
  return item.kind === "tool" && /^(?:tool result(?::|$)|tool$)/i.test(item.title.trim());
}

export function isDeveloperBashItem(item: TranscriptItem): boolean {
  if (item.kind !== "tool") return false;
  if (item.id.startsWith("bash:")) return true;
  if (!isRecord(item.raw)) return false;
  return item.raw.role === "bashExecution" || String(item.raw.type ?? "").startsWith("bash_execution_");
}

function itemHasRenderedImage(item: TranscriptItem): boolean {
  return Boolean(item.segments?.some((segment) => segment.kind === "image" && segment.src));
}

function normalizeToolTextForDedupe(value: string): string {
  return value
    .replace(/^exit code:\s*0\s*$/gim, "")
    .replace(/^(?:stdout|stderr):\s*/gim, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mergeDuplicateDeveloperBash(previous: TranscriptItem, current: TranscriptItem): boolean {
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

// ---- Event handlers (streaming) --------------------------------------------

function isGenericToolResultTitle(title: string): boolean {
  return /^(?:tool result(?::|$)|result(?::|$))/i.test(title.trim());
}

function hasToolOutput(item: TranscriptItem): boolean {
  return Boolean(item.body.trim() || item.segments?.length);
}

function shouldPreserveExistingToolTitle(existing: TranscriptItem, nextItem: TranscriptItem): boolean {
  if (existing.kind !== "tool" || nextItem.kind !== "tool") return false;
  if (isGenericToolResultTitle(nextItem.title)) return true;
  const existingDisplay = toolHeaderDisplay(existing);
  const nextDisplay = toolHeaderDisplay(nextItem);
  return Boolean(existingDisplay.target && !nextDisplay.target && existingDisplay.action === nextDisplay.action);
}

function mergeSameIdToolResult(existing: TranscriptItem, nextItem: TranscriptItem): TranscriptItem {
  if (existing.kind !== "tool" || nextItem.kind !== "tool") return nextItem;
  const existingHasOutput = hasToolOutput(existing);
  const nextHasOutput = hasToolOutput(nextItem);
  const nextBody = nextHasOutput || !existingHasOutput ? nextItem.body : existing.body;
  const nextSegments = nextItem.segments?.length ? nextItem.segments : nextItem.body.trim() ? undefined : existing.segments;
  const title = isGenericToolResultTitle(existing.title)
    ? nextItem.title
    : shouldPreserveExistingToolTitle(existing, nextItem)
      ? existing.title
      : nextItem.title;
  const merged: TranscriptItem = {
    ...existing,
    ...nextItem,
    title,
    body: nextBody,
    raw: { previous: existing.raw, toolResult: nextItem.raw },
  };
  if (nextSegments) merged.segments = nextSegments;
  else delete merged.segments;
  return merged;
}

function upsertItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    const next = [...items];
    next[idx] = mergeSameIdToolResult(next[idx]!, item);
    return next;
  }
  for (let runningBashIndex = items.length - 1; runningBashIndex >= 0; runningBashIndex -= 1) {
    const candidate = items[runningBashIndex];
    if (!candidate) continue;
    const candidateCopy = { ...candidate, segments: candidate.segments ? [...candidate.segments] : undefined };
    if (mergeDuplicateDeveloperBash(candidateCopy, item)) {
      const next = [...items];
      next[runningBashIndex] = candidateCopy;
      return next;
    }
  }
  const previous = items.at(-1);
  if (previous) {
    const previousCopy = { ...previous, segments: previous.segments ? [...previous.segments] : undefined };
    if (mergeDuplicateToolResult(previousCopy, item)) {
      const next = [...items];
      next[next.length - 1] = previousCopy;
      return next;
    }
  }
  return [...items, item];
}

function removeItemsByIdPrefix(items: TranscriptItem[], prefix: string): TranscriptItem[] {
  return items.filter((i) => !i.id.startsWith(prefix));
}

export function activeToolExecutionSnapshotToTranscriptItem(event: ActiveToolExecutionSnapshot, existing?: TranscriptItem): TranscriptItem | null {
  if (typeof event.toolCallId !== "string" || !event.toolCallId.trim()) return null;
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update") return null;
  return toolExecutionToTranscriptItem(event.type, event, existing);
}

function toolExecutionToTranscriptItem(type: string, event: Record<string, unknown>, existing?: TranscriptItem): TranscriptItem | null {
  const id = `tool:${String(event.toolCallId ?? Date.now())}`;
  if (type === "tool_execution_start") {
    return {
      id, kind: "tool",
      title: formatToolTitle(event.toolName, event.args),
      body: toolArgsToText(event.args ?? {}),
      status: "running",
      startedAt: eventStartTimestamp(event),
      raw: event,
    };
  }
  if (type === "tool_execution_update") {
    const partialResult = event.partialResult ?? {};
    const partialText = toolResultToText(partialResult);
    return {
      id, kind: "tool",
      title: formatToolTitle(event.toolName, event.args),
      body: partialText || toolArgsToText(event.args ?? {}),
      segments: toolResultToSegments(partialResult),
      status: "running",
      startedAt: eventStartTimestamp(event, existing),
      raw: event,
    };
  }
  if (type === "tool_execution_end") {
    const result = event.result ?? {};
    const startedAt = eventStartTimestamp(event, existing);
    const endedAt = eventTimestamp(event);
    const elapsedMs = typeof event.durationMs === "number" ? Math.max(0, event.durationMs) : calcDurationMs(startedAt, endedAt);
    return {
      id, kind: "tool",
      title: existing?.title ?? formatToolTitle(event.toolName, {}),
      body: toolResultToText(result),
      segments: toolResultToSegments(result),
      status: event.isError ? "error" : "done",
      startedAt, endedAt,
      ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
      raw: event,
    };
  }
  return null;
}

export function applyAgentEvent(items: TranscriptItem[], event: unknown): TranscriptItem[] {
  if (!isRecord(event)) return items;
  const type = String(event.type ?? "");

  if (type === "web_command_result") {
    return upsertItem(items, {
      id: String(event.id ?? `command:${Date.now()}`),
      kind: event.isError ? "error" : "system",
      title: String(event.title ?? "Slash command"),
      body: String(event.body ?? ""),
      raw: event,
    });
  }

  if (type === "bash_execution_start" || type === "bash_execution_update" || type === "bash_execution_end") {
    const command = String(event.command ?? "bash");
    const excludeFromContext = Boolean(event.excludeFromContext);
    const title = `$ ${command}${excludeFromContext ? " (no context)" : ""}`;
    const id = String(event.id ?? `bash:${Date.now()}`);
    if (type === "bash_execution_start") {
      // Remove any pending bash items with same command
      const cleaned = items.filter((i) => !(i.id.startsWith("bash:pending:") && isRecord(i.raw) && i.raw.command === command));
      return upsertItem(cleaned, { id, kind: "tool", title, body: "Starting…", status: "running", raw: event });
    }
    if (type === "bash_execution_update") {
      const existing = items.find((item) => item.id === id);
      const existingIsStartPlaceholder = isRecord(existing?.raw) && existing.raw.type === "bash_execution_start";
      const existingOutput = existing && !existingIsStartPlaceholder ? existing.body : "";
      const missingPrefix = !existingOutput && typeof event.outputOffsetBytes === "number" && event.outputOffsetBytes > 0 ? "[Earlier output will appear when the command completes.]\n" : "";
      const output = typeof event.output === "string"
        ? event.output
        : typeof event.outputDelta === "string"
          ? `${existingOutput || missingPrefix}${event.outputDelta}`
          : "";
      return upsertItem(items, { id, kind: "tool", title, body: output, segments: [{ kind: "pre", text: output }], status: "running", raw: event });
    }
    // bash_execution_end
    const result = isRecord(event.result) ? event.result : {};
    const output = typeof result.output === "string" ? result.output : stringify(result);
    const body = output || "Command completed with no output.";
    return upsertItem(items, {
      id, kind: "tool", title, body,
      segments: [{ kind: "pre", text: body }],
      status: event.isError || (typeof result.exitCode === "number" && result.exitCode !== 0) ? "error" : "done",
      raw: event,
    });
  }

  if (type === "message_start" || type === "message_update" || type === "message_end") {
    if (!isRecord(event.message)) return items;
    const fallback = type === "message_update" ? "assistant:live" : `${type}:${Date.now()}`;
    const item = messageToTranscriptItem(event.message, fallback);
    item.status = type === "message_update" ? "running" : "done";
    return upsertItem(items, item);
  }

  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    const id = `tool:${String(event.toolCallId ?? Date.now())}`;
    const existing = items.find((i) => i.id === id);
    const toolItem = toolExecutionToTranscriptItem(type, event, existing);
    if (!toolItem) return items;
    let next = upsertItem(items, toolItem);
    const questionSummary = questionSummaryFromTool(toolItem);
    if (questionSummary) next = upsertItem(next, questionSummary);
    return next;
  }

  return items;
}

// ---- Rendering helpers ------------------------------------------------------

export type ToolHeaderDisplay = { action: string; target: string };

export function toolHeaderDisplay(item: TranscriptItem): ToolHeaderDisplay {
  if (item.kind !== "tool") return { action: item.title, target: "" };
  const raw = isRecord(item.raw) ? item.raw : {};
  const args = isRecord(raw.args) ? raw.args : {};
  const rawName = typeof raw.toolName === "string" ? raw.toolName : typeof raw.name === "string" ? raw.name : "";
  const action = rawName.toLowerCase();
  if (action === "bash" && typeof args.command === "string") return { action: "bash", target: args.command };
  if ((action === "read" || action === "edit" || action === "write") && typeof args.path === "string") return { action, target: args.path };
  if ((action === "grep" || action === "find") && typeof args.pattern === "string") return { action, target: args.pattern };
  if (action === "ask_question") return { action: "question", target: typeof args.question === "string" ? args.question : "operator input" };
  // Fall back to parsing the title
  const trimmed = item.title.trim();
  if (!trimmed) return { action: "tool", target: "" };
  if (trimmed.startsWith("$ ")) return { action: "bash", target: trimmed.slice(2).trim() };
  const match = /^(read|edit|write|grep|find)\s+(.+)$/i.exec(trimmed);
  if (match) return { action: match[1]!.toLowerCase(), target: match[2]!.trim() };
  const [first = "tool", ...rest] = trimmed.split(/\s+/);
  return { action: first.toLowerCase(), target: rest.join(" ").trim() };
}

export function formatToolDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 10_000) return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function compactToolSummaryLine(part: string): string | null {
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

export function compactToolSummary(item: TranscriptItem): string {
  if (item.kind !== "tool" || item.status !== "done") return "";
  const segmentText = item.segments?.map((s) => "text" in s ? s.text : s.label).join("\n") ?? "";
  const source = segmentText || item.body || "";
  const rawLines = source.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const usefulLines = rawLines.map(compactToolSummaryLine).filter((l): l is string => Boolean(l));
  if (usefulLines.length === 0) return rawLines.length > 0 ? `${rawLines.length} line${rawLines.length === 1 ? "" : "s"} output` : "completed";
  const firstLine = usefulLines[0]!;
  const lastLine = usefulLines.at(-1)!;
  const prefix = usefulLines.length > 8 ? `${usefulLines.length} lines · ` : "";
  const middle = usefulLines.length > 8 && lastLine !== firstLine ? `${firstLine} … ${lastLine}` : firstLine;
  const summary = `${prefix}${middle}`;
  return summary.length > 140 ? `${summary.slice(0, 137)}…` : summary;
}

// Remove stale temporary item IDs used for pending/preview items
void removeItemsByIdPrefix; // exported indirectly via applyAgentEvent
