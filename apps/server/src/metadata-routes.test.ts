import { describe, expect, test } from "bun:test";
import type { WebSession } from "@pi-web-agent/protocol";
import { applySessionMetadataSuggestion } from "./metadata-routes.js";

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    id: "s1",
    kind: "workspace",
    cwd: "/tmp/project",
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
    pinned: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    lastOpenedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("applySessionMetadataSuggestion", () => {
  test("applies generated metadata with agent provenance", () => {
    let patch: unknown;
    let broadcasted = false;
    const base = session();
    const result = applySessionMetadataSuggestion(base, {
      store: {
        updateSession: (_id: string, input: unknown) => {
          patch = input;
          return session({ title: "Generated Title", titleSource: "agent", summary: "Generated summary.", summarySource: "agent" });
        },
      },
      getBroadcaster: () => ({ broadcastMetadataUpdate: () => { broadcasted = true; } }),
    } as never, { title: "Generated Title", summary: "Generated summary.", confidence: "high" });

    expect(result.applied).toEqual(["title", "summary"]);
    expect(result.skipped).toEqual([]);
    expect(patch).toMatchObject({ title: "Generated Title", titleSource: "agent", summary: "Generated summary.", summarySource: "agent", incrementGenerationCount: true });
    expect(broadcasted).toBe(true);
  });

  test("protects manual fields unless replace is requested", () => {
    let updateCalled = false;
    const base = session({ title: "Manual", titleSource: "manual", summary: null, summarySource: "unset" });
    const result = applySessionMetadataSuggestion(base, {
      store: {
        updateSession: (_id: string, input: unknown) => {
          updateCalled = true;
          return session({ title: "Manual", titleSource: "manual", summary: (input as { summary?: string }).summary ?? null, summarySource: "agent" });
        },
      },
      getBroadcaster: () => undefined,
    } as never, { title: "Generated Title", summary: "Generated summary.", confidence: "high" });

    expect(updateCalled).toBe(true);
    expect(result.applied).toEqual(["summary"]);
    expect(result.skipped).toEqual([{ field: "title", reason: "manual title protected" }]);
  });

  test("replace allows manual fields to be overwritten", () => {
    let patch: unknown;
    const base = session({ title: "Manual", titleSource: "manual", summary: "Manual summary", summarySource: "manual" });
    const result = applySessionMetadataSuggestion(base, {
      store: {
        updateSession: (_id: string, input: unknown) => {
          patch = input;
          return session({ title: "Generated Title", titleSource: "agent", summary: "Generated summary.", summarySource: "agent" });
        },
      },
      getBroadcaster: () => undefined,
    } as never, { title: "Generated Title", summary: "Generated summary.", confidence: "high" }, { replaceManual: true });

    expect(result.applied).toEqual(["title", "summary"]);
    expect(result.skipped).toEqual([]);
    expect(patch).toMatchObject({ titleSource: "agent", summarySource: "agent" });
  });
});
