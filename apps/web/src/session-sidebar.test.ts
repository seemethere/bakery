import { describe, expect, test } from "bun:test";
import type { WebSession } from "@pi-web-agent/protocol";
import { groupedSessions, renderSessionGroups } from "./session-sidebar";

function session(overrides: Partial<WebSession>): WebSession {
  return {
    id: overrides.id ?? "session-1",
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
    createdAt: "2026-04-27T20:00:00.000Z",
    lastOpenedAt: "2026-04-27T20:00:00.000Z",
    ...overrides,
  };
}

describe("session sidebar recency", () => {
  test("sorts by most recent access or activity, whichever is newer", () => {
    const olderActivityButRecentlyOpened = session({
      id: "opened-later",
      title: "Validation Rerun Observability",
      lastOpenedAt: "2026-04-27T21:20:00.000Z",
      lastActivityAt: "2026-04-27T21:10:00.000Z",
    });
    const newerActivityButOpenedEarlier = session({
      id: "active-earlier",
      title: "Queued Messages UI Spike",
      lastOpenedAt: "2026-04-27T21:00:00.000Z",
      lastActivityAt: "2026-04-27T21:11:00.000Z",
    });

    const groups = groupedSessions([newerActivityButOpenedEarlier, olderActivityButRecentlyOpened]);

    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["opened-later", "active-earlier"]);
  });

  test("renders the newest access time instead of an older transcript activity time", () => {
    const html = renderSessionGroups({
      groups: [{
        id: "today",
        label: "Today",
        defaultExpanded: true,
        sessions: [session({
          id: "opened-later",
          title: "Validation Rerun Observability",
          lastOpenedAt: new Date(Date.now() - 5_000).toISOString(),
          lastActivityAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        })],
      }],
      selectedSessionId: "opened-later",
      collapsedGroups: new Set(),
      status: "idle",
    });

    expect(html).toContain("now · bakery");
  });
});
