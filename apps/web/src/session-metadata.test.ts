import { describe, expect, test } from "bun:test";
import type { WebSession } from "@pi-web-agent/protocol";
import { cleanTitleInput, formatMetadataError, isGenericSessionPrompt, metadataPatchForSuggestion, provisionalTitleFromPrompt, renderSessionSummary, sessionDisplayTitle, sessionMetadataLabel, sessionSnippet, sessionTitlePlaceholder } from "./session-metadata";

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    id: "session-1",
    cwd: "/Users/eli/projects/bakery",
    piSessionFile: "/tmp/session.jsonl",
    isolationKind: "none",
    sourceCwd: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseCommit: null,
    worktreeSourceDirty: false,
    title: null,
    titleSource: "unset",
    summary: null,
    summarySource: "unset",
    summaryUpdatedAt: null,
    metadataGenerationCount: 0,
    metadataLastGeneratedAt: null,
    autoGenerateMetadataOverride: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("session metadata helpers", () => {
  test("cleans and suppresses generic provisional titles", () => {
    expect(cleanTitleInput("  Build\n\n```ts\nconst x = 1\n``` a useful pane  ")).toBe("Build a useful pane");
    expect(isGenericSessionPrompt("what's next?")).toBe(true);
    expect(isGenericSessionPrompt("sure")).toBe(true);
    expect(provisionalTitleFromPrompt("what's next?")).toBeNull();
    expect(provisionalTitleFromPrompt("Add keyboard support for the tree drawer")).toBe("Add keyboard support for the tree drawer");
  });

  test("derives display title, placeholder, metadata label, and snippet", () => {
    expect(sessionDisplayTitle(session({ lastUserPrompt: "what's next?" }))).toBe("New session");
    expect(sessionDisplayTitle(session({ lastUserPrompt: "Implement the preview pane" }))).toBe("Implement the preview pane");
    expect(sessionDisplayTitle(session())).toBe("bakery");
    expect(sessionTitlePlaceholder(session({ title: "Manual title" }))).toBe("Session title");
    expect(sessionTitlePlaceholder(session({ lastUserPrompt: "what's next?" }))).toBe("New session");
    expect(sessionMetadataLabel(session())).toBe("bakery · Users/eli/projects");
    expect(sessionSnippet(session({ summary: " Short summary ", lastUserPrompt: "ignored" }))).toBe("Short summary");
    expect(sessionSnippet(session({ lastUserPrompt: "/plan Goal: interview the operator" }))).toContain("/plan");
    expect(sessionSnippet(session())).toBe("No prompt yet");
  });

  test("formats provider errors without leaking raw JSON wrappers", () => {
    expect(formatMetadataError(new Error("502: {\"error\":\"model failed\"}"))).toBe("Could not generate metadata (502). model failed");
    expect(formatMetadataError("network down")).toBe("Could not generate metadata. network down");
  });

  test("builds patch bodies for edited suggestion accept actions", () => {
    const draft = { title: "New title", summary: "New summary" };
    expect(metadataPatchForSuggestion("both", draft)).toEqual({ title: "New title", summary: "New summary" });
    expect(metadataPatchForSuggestion("title", draft)).toEqual({ title: "New title" });
    expect(metadataPatchForSuggestion("summary", draft)).toEqual({ summary: "New summary" });
    expect(metadataPatchForSuggestion("both", { title: "", summary: "" })).toEqual({});
  });

  test("renders summary, suggestion actions, running disabled state, and escaped content", () => {
    const html = renderSessionSummary({
      session: session({ titleSource: "manual", summary: "Summary with <tags>", summarySource: "agent" }),
      expanded: false,
      suggestion: { title: "Better <title>", summary: "Better summary", confidence: "medium", reason: "Enough context" },
      draft: { title: "Better <title>", summary: "Better summary" },
      error: "",
      metadataGenerating: false,
      status: "running",
      showSuggestion: true,
    });
    expect(html).toContain("Summary — Summary with &lt;tags&gt;");
    expect(html).toContain('title="Title: manual; summary: agent"');
    expect(html).toContain("Better &lt;title&gt;");
    expect(html).toContain('data-accept-metadata="both"');
    expect(html).toContain("Regenerate</button>");
    expect(html).toContain("disabled");
  });
});
