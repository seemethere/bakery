import { describe, expect, test } from "bun:test";
import {
  activeToolExecutionSnapshotToTranscriptItem,
  applyAgentEvent,
  compactSnapshotTranscript,
  detectPlanCard,
  messageToTranscriptItem,
} from "./transcript";

describe("React transcript parity", () => {
  test("uses stable live tool row ids for SDK toolResult snapshots", () => {
    const item = messageToTranscriptItem({
      role: "toolResult",
      toolCallId: "call_subagent_1",
      toolName: "subagent",
      content: [{ type: "text", text: "done" }],
    }, "fallback");

    expect(item).toMatchObject({
      id: "tool:call_subagent_1",
      kind: "tool",
      title: "Tool result: subagent",
      body: "done",
      status: "done",
    });
  });

  test("decodes persisted web command result rows", () => {
    const item = messageToTranscriptItem({
      role: "webCommandResult",
      id: "command-1",
      title: "/reload",
      body: "Reloaded resources.",
      isError: false,
    }, "fallback");

    expect(item).toMatchObject({
      id: "command-1",
      kind: "system",
      title: "/reload",
      body: "Reloaded resources.",
    });
  });

  test("appends delta-only bash updates while preserving missing-prefix notice", () => {
    let items = applyAgentEvent([], { type: "bash_execution_start", id: "bash-1", command: "pwd" });
    items = applyAgentEvent(items, { type: "bash_execution_update", id: "bash-1", command: "pwd", outputDelta: "/repo", outputOffsetBytes: 0 });
    items = applyAgentEvent(items, { type: "bash_execution_update", id: "bash-1", command: "pwd", outputDelta: "\n", outputOffsetBytes: 5 });
    expect(items[0]).toMatchObject({ body: "/repo\n", status: "running" });

    const midStream = applyAgentEvent([], { type: "bash_execution_update", id: "bash-2", command: "tail", outputDelta: "latest", outputOffsetBytes: 100 });
    expect(midStream[0]?.body).toBe("[Earlier output will appear when the command completes.]\nlatest");
  });

  test("hydrates active tool execution snapshots as running tool rows", () => {
    const item = activeToolExecutionSnapshotToTranscriptItem({
      type: "tool_execution_update",
      toolCallId: "sub-active",
      toolName: "subagent",
      args: { agent: "reviewer" },
      partialResult: { content: [{ type: "text", text: "running" }] },
    });

    expect(item).toMatchObject({
      id: "tool:sub-active",
      kind: "tool",
      title: "subagent",
      body: "running",
      status: "running",
    });
  });

  test("detects legacy plan card key-file headings", () => {
    const item = messageToTranscriptItem({
      role: "assistant",
      content: `## Plan summary\nDo the thing.\n\n## Smallest next slice\nOne slice.\n\n## Key files likely to change\n- apps/web/src/lib/transcript.ts\n\n## Validation plan\nRun checks.\n\nPlan actions: Accept plan`,
    }, "plan");

    expect(item.kind).toBe("assistant");
    expect(detectPlanCard(item)?.keyFiles).toEqual(["apps/web/src/lib/transcript.ts"]);
  });

  test("keeps compact duplicate generic tool results quiet", () => {
    const first = messageToTranscriptItem({
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "stdout: hello\nexit code: 0" }],
    }, "first");
    const duplicate = messageToTranscriptItem({
      role: "toolResult",
      content: [{ type: "text", text: "hello" }],
    }, "duplicate");

    const compacted = compactSnapshotTranscript([first, duplicate]);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.raw).toMatchObject({ duplicateResult: duplicate.raw });
  });

  test("does not render live assistant rows that only announce tool calls", () => {
    const items = applyAgentEvent([], {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "DESIGN.md" } }],
      },
    });

    expect(items).toHaveLength(0);
  });

  test("keeps tool call labels out of mixed assistant message body text", () => {
    const item = messageToTranscriptItem({
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the design." },
        { type: "toolCall", name: "read", arguments: { path: "DESIGN.md" } },
      ],
    }, "assistant-1");

    expect(item.body).toBe("I will inspect the design.");
    expect(item.segments).toContainEqual({ kind: "toolCall", label: "↳ read DESIGN.md" });
  });
});
