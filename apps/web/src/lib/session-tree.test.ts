import { describe, expect, test } from "bun:test";
import type { SessionTreeNode } from "@pi-web-agent/protocol";
import { forkEntryIdForTranscriptItem } from "./session-tree";
import type { TranscriptItem } from "./transcript";

const node = (overrides: Partial<SessionTreeNode>): SessionTreeNode => ({
  id: "n1",
  parentId: null,
  type: "message",
  role: "assistant",
  title: "assistant: Done",
  timestamp: "2026-01-01T00:00:00.000Z",
  current: false,
  children: [],
  ...overrides,
});

describe("forkEntryIdForTranscriptItem", () => {
  test("matches assistant rows by timestamp/text", () => {
    const item: TranscriptItem = { id: "assistant:2026-01-01T00:00:00.000Z", kind: "assistant", title: "Pi", body: "Done with the slice", raw: {} };
    expect(forkEntryIdForTranscriptItem(item, [node({ id: "a1", title: "assistant: Done with the slice" })])).toBe("a1");
  });

  test("matches tool rows by title", () => {
    const item: TranscriptItem = { id: "tool:read-1", kind: "tool", title: "read README.md", body: "content", raw: { toolCallId: "read-1" } };
    expect(forkEntryIdForTranscriptItem(item, [node({ id: "t1", type: "tool", role: "toolResult", title: "Tool result: read README.md" })])).toBe("t1");
  });
});
