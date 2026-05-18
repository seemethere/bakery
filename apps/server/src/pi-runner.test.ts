import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelPolicy } from "@pi-web-agent/protocol";
import { applyConfiguredDefaultModel, snapshotMessagesFromSessionBranch } from "./pi-runner.js";

function makePolicy(defaultModel?: string, allowedModels?: string[]): ModelPolicy {
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(allowedModels ? { allowedModels } : {}),
    defaultThinkingLevel: "medium",
    allowedThinkingLevels: ["medium"],
  };
}

function makeSession(options: {
  current?: { provider: string; id: string } | undefined;
  available?: Array<{ provider: string; id: string }> | undefined;
  messages?: unknown[] | undefined;
}) {
  const calls: Array<{ provider: string; id: string }> = [];
  const session = {
    model: options.current,
    state: { messages: options.messages ?? [] },
    modelRegistry: {
      getAvailable: async () => options.available ?? [],
    },
    setModel: async (model: { provider: string; id: string }) => {
      calls.push(model);
      session.model = model;
    },
  };
  return { session, calls };
}

describe("applyConfiguredDefaultModel", () => {
  afterEach(() => {
    // bun's mock restore is global; keep this local helper safe if a warning spy was used.
    try {
      (console.warn as unknown as { mockRestore?: () => void }).mockRestore?.();
    } catch {
      // ignore if console.warn was not mocked
    }
  });

  test("selects the configured default for a new session", async () => {
    const target = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const { session, calls } = makeSession({
      current: { provider: "openai", id: "gpt-5.1" },
      available: [{ provider: "openai", id: "gpt-5.1" }, target],
    });

    await applyConfiguredDefaultModel(session as never, makePolicy("anthropic/claude-sonnet-4-5"));

    expect(calls).toEqual([target]);
    expect(session.model).toBe(target);
  });

  test("preserves restored sessions with existing messages", async () => {
    const { session, calls } = makeSession({
      current: { provider: "openai", id: "gpt-5.1" },
      available: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
      messages: [{ role: "user", content: "hello" }],
    });

    await applyConfiguredDefaultModel(session as never, makePolicy("anthropic/claude-sonnet-4-5"));

    expect(calls).toEqual([]);
    expect(session.model).toEqual({ provider: "openai", id: "gpt-5.1" });
  });

  test("warns and leaves the sdk-selected model when the configured default is disallowed", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const { session, calls } = makeSession({
      current: { provider: "openai", id: "gpt-5.1" },
      available: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    });

    await applyConfiguredDefaultModel(session as never, makePolicy("anthropic/claude-sonnet-4-5", ["openai/gpt-5.1"]));

    expect(calls).toEqual([]);
    expect(session.model).toEqual({ provider: "openai", id: "gpt-5.1" });
    expect(warn).toHaveBeenCalledWith("Configured default model is not allowed by policy: anthropic/claude-sonnet-4-5");
  });

  test("warns and leaves the sdk-selected model when the configured default is unavailable", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const { session, calls } = makeSession({
      current: { provider: "openai", id: "gpt-5.1" },
      available: [{ provider: "openai", id: "gpt-5.1" }],
    });

    await applyConfiguredDefaultModel(session as never, makePolicy("anthropic/claude-sonnet-4-5"));

    expect(calls).toEqual([]);
    expect(session.model).toEqual({ provider: "openai", id: "gpt-5.1" });
    expect(warn).toHaveBeenCalledWith("Configured default model is not available: anthropic/claude-sonnet-4-5");
  });
});

function messageEntry(id: string, timestamp: string, message: Record<string, unknown>): SessionEntry {
  return { type: "message", id, parentId: null, timestamp, message } as unknown as SessionEntry;
}

describe("snapshotMessagesFromSessionBranch", () => {
  test("returns persisted branch message entries with canonical entry timestamps", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("u1", "2026-05-15T23:20:00.000Z", { role: "user", content: "Hello" }),
      messageEntry("a1", "2026-05-15T23:20:01.000Z", { role: "assistant", content: "Hi" }),
    ])).toEqual([
      { role: "user", content: "Hello", timestamp: "2026-05-15T23:20:00.000Z" },
      { role: "assistant", content: "Hi", timestamp: "2026-05-15T23:20:01.000Z" },
    ]);
  });

  test("uses entry timestamps instead of stale inner message timestamps", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("a1", "2026-05-15T23:20:01.000Z", { role: "assistant", content: "Done", timestamp: "2026-05-15T23:00:00.000Z" }),
    ])).toEqual([
      { role: "assistant", content: "Done", timestamp: "2026-05-15T23:20:01.000Z" },
    ]);
  });

  test("ignores non-message branch entries in the first restored transcript slice", () => {
    const modelEntry = { type: "model_change", id: "m1", parentId: null, timestamp: "2026-05-15T23:19:59.000Z", provider: "openai", modelId: "gpt-5.1" } as unknown as SessionEntry;

    expect(snapshotMessagesFromSessionBranch([
      modelEntry,
      messageEntry("u1", "2026-05-15T23:20:00.000Z", { role: "user", content: "Hello" }),
    ])).toEqual([
      { role: "user", content: "Hello", timestamp: "2026-05-15T23:20:00.000Z" },
    ]);
  });

  test("keeps a verified volatile state tail for snapshots during streaming", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("u1", "2026-05-15T23:20:00.000Z", { role: "user", content: "Hello" }),
    ], [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Partial response" },
    ])).toEqual([
      { role: "user", content: "Hello", timestamp: "2026-05-15T23:20:00.000Z" },
      { role: "assistant", content: "Partial response" },
    ]);
  });

  test("does not append volatile state messages when the branch prefix is not the same timeline", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("u1", "2026-05-15T23:20:00.000Z", { role: "user", content: "Hello" }),
    ], [
      { role: "compactionSummary", summary: "Older context" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Partial response" },
    ])).toEqual([
      { role: "user", content: "Hello", timestamp: "2026-05-15T23:20:00.000Z" },
    ]);
  });

  test("keeps volatile state when a new streaming session has no branch entries yet", () => {
    expect(snapshotMessagesFromSessionBranch([], [
      { role: "user", content: "Hello" },
    ])).toEqual([
      { role: "user", content: "Hello" },
    ]);
  });

  test("returns branch messages when volatile state is shorter than the branch", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("u1", "2026-05-15T23:20:00.000Z", { role: "user", content: "Hello" }),
      messageEntry("a1", "2026-05-15T23:20:01.000Z", { role: "assistant", content: "Hi" }),
    ], [
      { role: "user", content: "Hello" },
    ])).toEqual([
      { role: "user", content: "Hello", timestamp: "2026-05-15T23:20:00.000Z" },
      { role: "assistant", content: "Hi", timestamp: "2026-05-15T23:20:01.000Z" },
    ]);
  });

  test("preserves non-record persisted message payloads defensively", () => {
    expect(snapshotMessagesFromSessionBranch([
      messageEntry("m1", "2026-05-15T23:20:00.000Z", "legacy message" as unknown as Record<string, unknown>),
    ])).toEqual(["legacy message"]);
  });
});
