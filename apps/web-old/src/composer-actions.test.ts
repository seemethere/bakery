import { describe, expect, test } from "bun:test";
import { buildComposerSendPayload, composerQueueItem, consumePromptAttachmentWarning, loadPromptDraftForSession, parseBashPrompt, persistPromptAttachmentWarning, promptAttachmentWarningStorageKey, promptDraftStorageKey, promptTextFromInput, savePromptDraftForSession } from "./composer-actions";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe("composer action helpers", () => {
  test("builds session-scoped draft and attachment warning keys", () => {
    expect(promptDraftStorageKey("s1")).toBe("piWebPromptDraft:s1");
    expect(promptAttachmentWarningStorageKey("s1")).toBe("piWebPromptAttachmentWarning:s1");
    expect(promptDraftStorageKey(undefined)).toBeNull();
  });

  test("loads, saves, and clears prompt drafts", () => {
    const storage = memoryStorage();
    savePromptDraftForSession(storage, "s1", "hello");
    expect(loadPromptDraftForSession(storage, "s1")).toBe("hello");
    savePromptDraftForSession(storage, "s1", "");
    expect(loadPromptDraftForSession(storage, "s1")).toBe("");
  });

  test("persists and consumes one-shot attachment warning state", () => {
    const storage = memoryStorage();
    persistPromptAttachmentWarning(storage, "s1", false);
    expect(consumePromptAttachmentWarning(storage, "s1")).toBe(false);
    persistPromptAttachmentWarning(storage, "s1", true);
    expect(consumePromptAttachmentWarning(storage, "s1")).toBe(true);
    expect(consumePromptAttachmentWarning(storage, "s1")).toBe(false);
  });

  test("parses context-included and context-excluded bash prompts", () => {
    expect(parseBashPrompt("! pwd")).toEqual({ command: "pwd", excludeFromContext: false });
    expect(parseBashPrompt("!! bun test")).toEqual({ command: "bun test", excludeFromContext: true });
    expect(parseBashPrompt("!")).toBeNull();
    expect(parseBashPrompt("hello ! pwd")).toBeNull();
  });

  test("builds prompt text and send payloads", () => {
    expect(promptTextFromInput("  ", 1)).toBe("Please inspect the attached image.");
    expect(buildComposerSendPayload("prompt", "hello", ["data:image/png;base64,a"])).toEqual({ type: "prompt", text: "hello", images: ["data:image/png;base64,a"] });
    expect(buildComposerSendPayload("steer", "note")).toEqual({ type: "steer", text: "note" });
    expect(buildComposerSendPayload("prompt", "!! ls")).toEqual({ type: "bash", command: "ls", excludeFromContext: true });
    expect(composerQueueItem("hello", 2)).toEqual({ text: "hello", imageCount: 2 });
    expect(composerQueueItem("hello", 0)).toEqual({ text: "hello", imageCount: undefined });
  });
});
