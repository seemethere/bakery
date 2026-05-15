import { describe, expect, test } from "bun:test";
import type { WebSession, Workspace } from "@pi-web-agent/protocol";
import { groupedByWorkspace, groupedSessions, pinnedSessions, sessionWorkRecencyValue } from "./session-utils";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function session(overrides: Partial<WebSession> & Pick<WebSession, "id">): WebSession {
  return {
    id: overrides.id,
    kind: "workspace",
    cwd: "/work/repo",
    piSessionFile: `/sessions/${overrides.id}.jsonl`,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("session work recency", () => {
  test("empty sessions use created time instead of last opened time", () => {
    const oldCreated = "2026-01-01T00:00:00.000Z";
    const reopenedNow = "2026-01-10T00:00:00.000Z";

    expect(sessionWorkRecencyValue(session({
      id: "empty-reopened",
      createdAt: oldCreated,
      lastOpenedAt: reopenedNow,
      lastActivityAt: undefined,
    }))).toBe(oldCreated);
  });

  test("sessions with transcript work use last activity even when reopened later", () => {
    const transcriptActivity = "2026-01-03T00:00:00.000Z";
    const reopenedNow = "2026-01-10T00:00:00.000Z";

    expect(sessionWorkRecencyValue(session({
      id: "worked-reopened",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: transcriptActivity,
      lastOpenedAt: reopenedNow,
    }))).toBe(transcriptActivity);
  });

  test("recent grouping and sorting ignore last opened time", () => {
    const now = Date.now();
    const emptyOldReopened = session({
      id: "empty-old-reopened",
      createdAt: iso(now - 10 * 24 * 60 * 60 * 1000),
      lastOpenedAt: iso(now),
    });
    const workedYesterday = session({
      id: "worked-yesterday",
      createdAt: iso(now - 10 * 24 * 60 * 60 * 1000),
      lastActivityAt: iso(now - 25 * 60 * 60 * 1000),
      lastOpenedAt: iso(now - 5_000),
    });

    const groups = groupedSessions([emptyOldReopened, workedYesterday]);
    expect(groups.find((group) => group.id === "older")?.sessions.map((s) => s.id)).toEqual(["empty-old-reopened"]);
    expect(groups.flatMap((group) => group.sessions).map((s) => s.id).indexOf("worked-yesterday"))
      .toBeLessThan(groups.flatMap((group) => group.sessions).map((s) => s.id).indexOf("empty-old-reopened"));
  });

  test("pinned and workspace session ordering ignore last opened time", () => {
    const oldActivity = "2026-01-02T00:00:00.000Z";
    const newerActivity = "2026-01-03T00:00:00.000Z";
    const recentlyOpened = "2026-01-10T00:00:00.000Z";
    const older = session({ id: "older-work", pinned: true, lastActivityAt: oldActivity, lastOpenedAt: recentlyOpened });
    const newer = session({ id: "newer-work", pinned: true, lastActivityAt: newerActivity, lastOpenedAt: "2026-01-03T00:01:00.000Z" });

    expect(pinnedSessions([older, newer]).map((s) => s.id)).toEqual(["newer-work", "older-work"]);

    const workspace: Workspace = { path: "/work/repo", label: "repo" };
    expect(groupedByWorkspace([{ ...older, pinned: false }, { ...newer, pinned: false }], [workspace])[0]?.sessions.map((s) => s.id))
      .toEqual(["newer-work", "older-work"]);
  });
});
