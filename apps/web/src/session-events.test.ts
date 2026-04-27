import { beforeAll, describe, expect, test } from "bun:test";
import type { WebSession } from "@pi-web-agent/protocol";

type SessionEvents = typeof import("./session-events");
let helpers: SessionEvents;

beforeAll(async () => {
  Object.defineProperty(globalThis, "HTMLElement", {
    value: class HTMLElement {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "customElements", {
    value: { define: () => undefined },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { location: { href: "http://127.0.0.1:5173/" } },
    configurable: true,
  });
  helpers = await import("./session-events");
});

function webSession(overrides: Partial<WebSession> = {}): WebSession {
  return {
    id: "s1",
    cwd: "/repo",
    piSessionFile: "/repo/.pi/sessions/s1.jsonl",
    title: null,
    titleSource: "unset",
    summary: null,
    summarySource: "unset",
    summaryUpdatedAt: null,
    metadataGenerationCount: 0,
    metadataLastGeneratedAt: null,
    autoGenerateMetadataOverride: "default",
    createdAt: "2026-04-27T00:00:00.000Z",
    lastOpenedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("session event helpers", () => {
  test("extracts agent event types from records only", () => {
    expect(helpers.agentEventType({ type: "turn_start" })).toBe("turn_start");
    expect(helpers.agentEventType({})).toBe("event");
    expect(helpers.agentEventType(null)).toBeNull();
    expect(helpers.agentEventType("turn_start")).toBeNull();
  });

  test("converts web command results into system or error transcript items", () => {
    expect(helpers.webCommandResultToTranscriptItem({ id: "c1", title: "Slash command", body: "Done" })).toMatchObject({
      id: "c1",
      kind: "system",
      title: "Slash command",
      body: "Done",
    });
    expect(helpers.webCommandResultToTranscriptItem({ id: "c2", isError: true, title: "Nope", body: "Failed" })).toMatchObject({
      id: "c2",
      kind: "error",
      title: "Nope",
      body: "Failed",
    });
  });

  test("converts bash lifecycle events including no-context and exit errors", () => {
    const start = { type: "bash_execution_start", id: "b1", command: "pwd", excludeFromContext: true };
    expect(helpers.bashEventCommand(start)).toBe("pwd");
    expect(helpers.bashEventToTranscriptItem(start)).toMatchObject({
      id: "b1",
      kind: "tool",
      title: "$ pwd (no context)",
      body: "Starting…",
      status: "running",
    });

    expect(helpers.bashEventToTranscriptItem({ type: "bash_execution_update", id: "b1", command: "pwd", output: "/repo\n" })).toMatchObject({
      id: "b1",
      title: "$ pwd",
      body: "/repo\n",
      segments: [{ kind: "pre", text: "/repo\n" }],
      status: "running",
    });

    expect(helpers.bashEventToTranscriptItem({ type: "bash_execution_end", id: "b1", command: "false", result: { output: "boom", exitCode: 1 } })).toMatchObject({
      id: "b1",
      title: "$ false",
      body: "boom",
      segments: [{ kind: "pre", text: "boom" }],
      status: "error",
    });

    expect(helpers.bashEventToTranscriptItem({ type: "other", command: "pwd" })).toBeNull();
  });

  test("converts message events with running status for updates", () => {
    const update = helpers.messageEventToTranscriptItem("message_update", { message: { role: "assistant", timestamp: "t1", content: [{ type: "text", text: "Hello" }] } });
    expect(update).toMatchObject({ id: "assistant:t1", kind: "assistant", title: "Pi", body: "Hello", status: "running" });

    const end = helpers.messageEventToTranscriptItem("message_end", { message: { role: "user", timestamp: "t2", content: "Done" } });
    expect(end).toMatchObject({ id: "user:t2", kind: "user", title: "You", body: "Done", status: "done" });

    expect(helpers.messageEventToTranscriptItem("message_update", { message: "not a record" })).toBeNull();
  });

  test("converts tool events and preserves existing title on completion", () => {
    const start = helpers.toolExecutionToTranscriptItem("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "README.md" } });
    expect(start).toMatchObject({ id: "tool:t1", kind: "tool", title: "read README.md", status: "running" });

    const end = helpers.toolExecutionToTranscriptItem("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: "hello" } }, start ?? undefined);
    expect(end).toMatchObject({ id: "tool:t1", kind: "tool", title: "read README.md", body: "hello", status: "done" });

    const failed = helpers.toolExecutionToTranscriptItem("tool_execution_end", { toolCallId: "t2", toolName: "bash", isError: true, result: { error: "nope" } });
    expect(failed?.status).toBe("error");
    expect(helpers.toolExecutionToTranscriptItem("other", {})).toBeNull();
  });

  test("normalizes queue updates", () => {
    expect(helpers.queueUpdateValues({ steering: ["a"], followUp: ["b"] })).toEqual({ steering: ["a"], followUp: ["b"] });
    expect(helpers.queueUpdateValues({ steering: "nope", followUp: null })).toEqual({ steering: [], followUp: [] });
  });

  test("merges metadata updates while preserving enriched recency fields when omitted", () => {
    const existing = webSession({ title: "Old", lastUserPrompt: "previous prompt", lastActivityAt: "2026-04-27T01:00:00.000Z", status: "running" });
    const update = webSession({ id: "s1", title: "New", lastUserPrompt: undefined, lastActivityAt: undefined, status: undefined });
    expect(helpers.mergeSessionMetadataUpdate(existing, update)).toMatchObject({
      title: "New",
      lastUserPrompt: "previous prompt",
      lastActivityAt: "2026-04-27T01:00:00.000Z",
      status: "running",
    });
  });
});
