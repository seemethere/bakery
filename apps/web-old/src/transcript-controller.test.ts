import { beforeAll, describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./transcript";

let TranscriptController: typeof import("./transcript-controller").TranscriptController;
let toolCallIdForTranscriptItem: typeof import("./transcript-controller").toolCallIdForTranscriptItem;

beforeAll(async () => {
  Object.defineProperty(globalThis, "HTMLElement", {
    value: class HTMLElement {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "customElements", {
    value: { define: () => undefined },
    configurable: true,
  });
  ({ TranscriptController, toolCallIdForTranscriptItem } = await import("./transcript-controller"));
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function tool(id: string, status: TranscriptItem["status"] = "running"): TranscriptItem {
  return { id, kind: "tool", title: "$ test", body: "output", status };
}

describe("TranscriptController", () => {
  test("upserts transcript items, tracks dirty neighbors, and marks unread", () => {
    const unread: string[] = [];
    const controller = new TranscriptController(memoryStorage());

    controller.upsert({ id: "assistant:1", kind: "assistant", title: "Assistant", body: "hello" }, { markUnread: (id) => unread.push(id) });
    controller.upsert(tool("tool:1"), { markUnread: (id) => unread.push(id) });
    controller.upsert({ ...tool("tool:1"), status: "done", body: "done" }, { markUnread: (id) => unread.push(id) });

    expect(controller.items.map((item) => item.id)).toEqual(["assistant:1", "tool:1"]);
    expect(controller.items.at(-1)).toMatchObject({ status: "done", body: "done" });
    expect(controller.dirtyIds.has("tool:1")).toBe(true);
    expect(controller.structureDirty).toBe(true);
    expect(unread).toEqual(["assistant:1", "tool:1", "tool:1"]);
  });

  test("uses pending assistant tool-call titles for following tool execution rows", () => {
    const controller = new TranscriptController(memoryStorage());
    controller.upsert({
      id: "assistant-tools",
      kind: "assistant",
      title: "Assistant",
      body: "",
      segments: [{ kind: "toolCall", label: "read DESIGN.md" }],
    });
    controller.upsert({ id: "tool:abc", kind: "tool", title: "Tool", body: "ok", status: "running" });

    expect(controller.items).toHaveLength(1);
    expect(controller.items[0]?.title).toContain("read");
  });

  test("persists and reapplies tool timing metadata by tool call id", () => {
    const storage = memoryStorage();
    const first = new TranscriptController(storage);
    first.loadToolTimings("session-1");
    first.rememberToolTiming("session-1", { id: "tool:call-1", kind: "tool", title: "Tool", body: "", status: "done", durationMs: 123 });

    const second = new TranscriptController(storage);
    second.loadToolTimings("session-1");
    const [hydrated] = second.applyCachedToolTimings([{ id: "tool:call-1", kind: "tool", title: "Tool", body: "", status: "done" }]);

    expect(hydrated?.durationMs).toBe(123);
    expect(toolCallIdForTranscriptItem(hydrated!)).toBe("call-1");
  });

  test("removes pending rows and marks transcript structure dirty", () => {
    const controller = new TranscriptController(memoryStorage());
    controller.replaceItems([tool("bash:pending:1"), tool("tool:kept")]);
    controller.structureDirty = false;

    controller.removeByIds(["bash:pending:1"]);

    expect(controller.items.map((item) => item.id)).toEqual(["tool:kept"]);
    expect(controller.dirtyIds.has("bash:pending:1")).toBe(true);
    expect(controller.structureDirty).toBe(true);
  });
});
