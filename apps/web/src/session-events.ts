import type { WebSession } from "@pi-web-agent/protocol";
import { formatToolTitle, messageToTranscriptItem, questionSummaryFromTool, toolArgsToText, toolResultToSegments, toolResultToText, type TranscriptItem } from "./transcript";
import { isRecord, stringify } from "./utils";

function eventTimestamp(event: Record<string, unknown>): string {
  const value = event.endedAt ?? event.timestamp ?? event.eventTime ?? event.time;
  return typeof value === "string" ? value : new Date().toISOString();
}

function eventStartTimestamp(event: Record<string, unknown>, existing?: TranscriptItem): string {
  const value = event.startedAt ?? event.startTime ?? existing?.startedAt ?? event.eventTime ?? event.time;
  return typeof value === "string" ? value : new Date().toISOString();
}

function durationMs(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

export function agentEventType(event: unknown): string | null {
  return isRecord(event) ? String(event.type ?? "event") : null;
}

export function webCommandResultToTranscriptItem(event: Record<string, unknown>): TranscriptItem {
  return {
    id: String(event.id ?? `command:${Date.now()}`),
    kind: event.isError ? "error" : "system",
    title: String(event.title ?? "Slash command"),
    body: String(event.body ?? ""),
    raw: event,
  };
}

export function bashEventCommand(event: Record<string, unknown>): string {
  return String(event.command ?? "bash");
}

export function bashEventToTranscriptItem(event: Record<string, unknown>): TranscriptItem | null {
  const type = String(event.type ?? "event");
  const command = bashEventCommand(event);
  const excludeFromContext = Boolean(event.excludeFromContext);
  const title = `$ ${command}${excludeFromContext ? " (no context)" : ""}`;
  const id = String(event.id ?? `bash:${Date.now()}`);
  if (type === "bash_execution_start") {
    return { id, kind: "tool", title, body: "Starting…", status: "running", raw: event };
  }
  if (type === "bash_execution_update") {
    const output = String(event.output ?? "");
    return { id, kind: "tool", title, body: output, segments: [{ kind: "pre", text: output }], status: "running", raw: event };
  }
  if (type === "bash_execution_end") {
    const result = isRecord(event.result) ? event.result : {};
    const output = typeof result.output === "string" ? result.output : stringify(result);
    const body = output || "Command completed with no output.";
    return {
      id,
      kind: "tool",
      title,
      body,
      segments: [{ kind: "pre", text: body }],
      status: event.isError || (typeof result.exitCode === "number" && result.exitCode !== 0) ? "error" : "done",
      raw: event,
    };
  }
  return null;
}

export function messageEventToTranscriptItem(type: string, event: Record<string, unknown>): TranscriptItem | null {
  if (!isRecord(event.message)) return null;
  const fallback = type === "message_update" ? "assistant:live" : `${type}:${Date.now()}`;
  const item = messageToTranscriptItem(event.message, fallback);
  item.status = type === "message_update" ? "running" : "done";
  return item;
}

export function toolExecutionToTranscriptItem(type: string, event: Record<string, unknown>, existing?: TranscriptItem): TranscriptItem | null {
  const id = `tool:${String(event.toolCallId ?? Date.now())}`;
  if (type === "tool_execution_start") {
    const startedAt = eventStartTimestamp(event);
    return {
      id,
      kind: "tool",
      title: formatToolTitle(event.toolName, event.args),
      body: toolArgsToText(event.args ?? {}),
      status: "running",
      startedAt,
      raw: event,
    };
  }
  if (type === "tool_execution_update") {
    const partialResult = event.partialResult ?? {};
    const partialText = toolResultToText(partialResult);
    return {
      id,
      kind: "tool",
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
    const elapsedMs = typeof event.durationMs === "number" ? Math.max(0, event.durationMs) : durationMs(startedAt, endedAt);
    return {
      id,
      kind: "tool",
      title: existing?.title ?? formatToolTitle(event.toolName, {}),
      body: toolResultToText(result),
      segments: toolResultToSegments(result),
      status: event.isError ? "error" : "done",
      startedAt,
      endedAt,
      ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
      raw: event,
    };
  }
  return null;
}

export function questionSummaryForToolItem(item: TranscriptItem): TranscriptItem | null {
  return questionSummaryFromTool(item);
}

export function queueUpdateValues(event: Record<string, unknown>): { steering: unknown[]; followUp: unknown[] } {
  return {
    steering: Array.isArray(event.steering) ? event.steering : [],
    followUp: Array.isArray(event.followUp) ? event.followUp : [],
  };
}

export function mergeSessionMetadataUpdate(existing: WebSession | undefined, update: WebSession): WebSession {
  return {
    ...existing,
    ...update,
    lastUserPrompt: update.lastUserPrompt ?? existing?.lastUserPrompt,
    lastActivityAt: update.lastActivityAt ?? existing?.lastActivityAt,
    status: update.status ?? existing?.status,
  };
}
