import { describe, expect, test } from "bun:test";
import type { SessionRuntimeSettings } from "@pi-web-agent/protocol";
import { modelShorthand, modelThinkingTriggerLabel, isNonDefaultThinkingLevel } from "./model-thinking-picker";

const settings = (overrides: Partial<SessionRuntimeSettings> = {}): SessionRuntimeSettings => ({
  model: { id: "anthropic/claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
  availableModels: [],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "low", "medium", "high"],
  ...overrides,
});

describe("model thinking picker", () => {
  test("formats compact model shorthand", () => {
    expect(modelShorthand({ id: "anthropic/claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" })).toBe("Sonnet 4");
    expect(modelShorthand({ id: "openai/gpt-5.5", provider: "openai", name: "GPT-5.5" })).toBe("GPT 5.5");
    expect(modelShorthand({ id: "openai/gpt-5-codex", provider: "openai" })).toBe("GPT 5 Codex");
  });

  test("only includes thinking in the trigger when non-default", () => {
    expect(modelThinkingTriggerLabel(settings(), "medium")).toBe("Sonnet 4");
    expect(modelThinkingTriggerLabel(settings({ thinkingLevel: "high" }), "medium")).toBe("Sonnet 4 · high");
  });

  test("uses medium as the fallback default thinking level", () => {
    expect(isNonDefaultThinkingLevel("medium")).toBe(false);
    expect(isNonDefaultThinkingLevel("low")).toBe(true);
  });
});
