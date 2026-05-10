import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ModelPolicy } from "@pi-web-agent/protocol";
import { applyConfiguredDefaultModel } from "./pi-runner.js";

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
