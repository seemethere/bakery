import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MetadataStore } from "./metadata-store.js";

describe("MetadataStore workspaces", () => {
  test("persists managed workspaces with upserted labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      store.addWorkspace({ path: "/repo/z", label: "Zed" });
      store.addWorkspace({ path: "/repo/a", label: "Alpha" });
      store.addWorkspace({ path: "/repo/z", label: "Zed renamed" });

      expect(store.listWorkspaces()).toEqual([
        { path: "/repo/a", label: "Alpha" },
        { path: "/repo/z", label: "Zed renamed" },
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("deletes approved workspaces without deleting sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: "/repo/a", piSessionFile: join(dir, "session.jsonl") });
      store.addWorkspace({ path: "/repo/a", label: "Alpha" });

      expect(store.deleteWorkspace("/repo/a")).toBe(true);
      expect(store.listWorkspaces()).toEqual([]);
      expect(store.getSession(session.id)).toMatchObject({ id: session.id, cwd: "/repo/a" });
      expect(store.deleteWorkspace("/repo/a")).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaults review state only for isolated worktree sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const standard = store.createSession({ id: "standard-1", cwd: dir, piSessionFile: join(dir, "standard.jsonl") });
      const isolated = store.createSession({
        id: "isolated-1",
        cwd: join(dir, "worktree"),
        piSessionFile: join(dir, "isolated.jsonl"),
        isolationKind: "git_worktree",
        sourceCwd: dir,
        worktreePath: join(dir, "worktree"),
        worktreeBranch: "bakery/session/test",
        worktreeBaseCommit: "abc123",
      });

      expect(standard.reviewStatus).toBeNull();
      expect(standard.reviewUpdatedAt).toBeNull();
      expect(isolated.reviewStatus).toBe("pending");
      expect(isolated.reviewUpdatedAt).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("updates session review state", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({
        id: "isolated-1",
        cwd: join(dir, "worktree"),
        piSessionFile: join(dir, "isolated.jsonl"),
        isolationKind: "git_worktree",
        sourceCwd: dir,
        worktreePath: join(dir, "worktree"),
        worktreeBranch: "bakery/session/test",
        worktreeBaseCommit: "abc123",
      });

      const updated = store.updateSessionReview(session.id, "approved");

      expect(updated).toMatchObject({ id: session.id, reviewStatus: "approved" });
      expect(typeof updated?.reviewUpdatedAt).toBe("string");
      expect(store.getSession(session.id)?.reviewStatus).toBe("approved");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("attaching a workspace promotes draft sessions to workspace sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({
        id: "draft-1",
        cwd: null,
        piSessionFile: join(dir, "session.jsonl"),
        kind: "draft",
      });

      const updated = store.attachWorkspace(session.id, dir);

      expect(updated).toMatchObject({ id: session.id, kind: "workspace", cwd: dir });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MetadataStore web command results", () => {
  test("persists extension card command results for session refresh snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: dir, piSessionFile: join(dir, "session.jsonl") });
      store.addWebCommandResult(session.id, {
        id: "command:metadata",
        title: "/bakery:generate-details",
        body: "Updated title and summary.",
        data: { kind: "extension_card", card: { kind: "bakery.metadataDetails", props: { title: "Details" } } },
        timestamp: "2026-05-03T00:00:00.000Z",
      });

      expect(store.listWebCommandResults(session.id)).toEqual([
        {
          id: "command:metadata",
          title: "/bakery:generate-details",
          body: "Updated title and summary.",
          isError: false,
          data: { kind: "extension_card", card: { kind: "bakery.metadataDetails", props: { title: "Details" } } },
          timestamp: "2026-05-03T00:00:00.000Z",
        },
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MetadataStore submitted prompt receipts", () => {
  test("stores pending receipts and reconciles the oldest matching prompt by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: null, kind: "chat_only", piSessionFile: join(dir, "session.jsonl") });
      const first = store.addSubmittedPrompt(session.id, { id: "prompt:1", kind: "prompt", text: "hello", timestamp: "2026-05-03T00:00:00.000Z" });
      store.addSubmittedPrompt(session.id, { id: "prompt:2", kind: "ask", text: "why?", timestamp: "2026-05-03T00:00:01.000Z" });

      expect(store.listUnreconciledSubmittedPrompts(session.id).map((record) => record.id)).toEqual(["prompt:1", "prompt:2"]);
      expect(store.markSubmittedPromptReconciled(session.id, first.id, "2026-05-03T00:00:02.000Z")).toMatchObject({ id: "prompt:1", reconciledAt: "2026-05-03T00:00:02.000Z" });
      expect(store.listUnreconciledSubmittedPrompts(session.id).map((record) => record.id)).toEqual(["prompt:2"]);
      expect(store.markSubmittedPromptError(session.id, "prompt:2", "model unavailable")).toMatchObject({ id: "prompt:2", error: "model unavailable" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
