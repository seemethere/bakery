import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addExistingWorkspace, assertAllowedCwd, assertAllowedSessionWorkspace, assertAllowedWorkspacePath, browseWorkspaceDirectory, mergeWorkspaces } from "./workspaces.js";

describe("workspace helpers", () => {
  test("adds existing workspaces by real path and basename label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakery-workspace-"));
    try {
      const workspace = await addExistingWorkspace(dir);
      expect(workspace.path).toBe(await realpath(dir));
      expect(workspace.label).toBe(workspace.path.split("/").at(-1) ?? workspace.path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges configured and stored workspaces without duplicating paths", () => {
    expect(mergeWorkspaces(["/repos/b"], [{ path: "/repos/a", label: "A" }, { path: "/repos/b", label: "B custom" }])).toEqual([
      { path: "/repos/a", label: "A" },
      { path: "/repos/b", label: "B custom" },
    ]);
  });

  test("keeps session cwd checks constrained to allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bakery-outside-"));
    try {
      await expect(assertAllowedCwd(root, [root])).resolves.toBe(await realpath(root));
      await expect(assertAllowedCwd(outside, [root])).rejects.toThrow("Workspace is not under an allowed root");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("allows runtime paths under configured roots or approved workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-root-"));
    const approved = await mkdtemp(join(tmpdir(), "bakery-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "bakery-outside-"));
    const child = join(approved, "child");
    try {
      await mkdir(child);
      const approvedReal = await realpath(approved);
      const scope = { browseRoots: [await realpath(root)], approvedWorkspaces: [{ path: approvedReal, label: "Approved" }] };

      await expect(assertAllowedWorkspacePath(root, scope)).resolves.toBe(await realpath(root));
      await expect(assertAllowedWorkspacePath(child, scope)).resolves.toBe(await realpath(child));
      await expect(assertAllowedWorkspacePath(outside, scope)).rejects.toThrow("Browse Root or Approved Workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(approved, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("ignores deleted approved workspace roots when checking unrelated allowed paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-root-"));
    const deleted = await mkdtemp(join(tmpdir(), "bakery-deleted-"));
    try {
      const deletedReal = await realpath(deleted);
      await rm(deleted, { recursive: true, force: true });
      await expect(assertAllowedWorkspacePath(root, { browseRoots: [root], approvedWorkspaces: [{ path: deletedReal, label: "Deleted" }] })).resolves.toBe(await realpath(root));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(deleted, { recursive: true, force: true });
    }
  });

  test("lists browse roots and approved workspaces at the workspace browser top level", async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-root-"));
    const approved = await mkdtemp(join(tmpdir(), "bakery-approved-"));
    try {
      const rootReal = await realpath(root);
      const approvedReal = await realpath(approved);
      const result = await browseWorkspaceDirectory(undefined, { browseRoots: [rootReal], approvedWorkspaces: [{ path: approvedReal, label: "Approved" }] });
      expect(result.path).toBeNull();
      expect(result.entries).toEqual([
        { path: approvedReal, name: "Approved", kind: "directory", source: "approved_workspace" },
        { path: rootReal, name: rootReal.split("/").at(-1) ?? rootReal, kind: "directory", source: "browse_root" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(approved, { recursive: true, force: true });
    }
  });

  test("labels the home browse root as tilde", async () => {
    const home = await realpath(homedir());
    const result = await browseWorkspaceDirectory(undefined, { browseRoots: [home], approvedWorkspaces: [] });
    expect(result.entries).toEqual([
      { path: home, name: "~", kind: "directory", source: "browse_root" },
    ]);
  });

  test("browses allowed directory children without following symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "bakery-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bakery-outside-"));
    try {
      await mkdir(join(root, "app"));
      await writeFile(join(root, "README.md"), "hello");
      await symlink(outside, join(root, "outside-link"));
      const rootReal = await realpath(root);
      const result = await browseWorkspaceDirectory(root, { browseRoots: [rootReal], approvedWorkspaces: [] });
      expect(result.path).toBe(rootReal);
      expect(result.entries).toEqual([
        { path: join(rootReal, "app"), name: "app", kind: "directory", source: "child" },
        { path: join(rootReal, "README.md"), name: "README.md", kind: "file", source: "child" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("allows managed worktree sessions when the source workspace is approved", async () => {
    const source = await mkdtemp(join(tmpdir(), "bakery-source-"));
    const worktreeDir = await mkdtemp(join(tmpdir(), "bakery-worktrees-"));
    const worktree = join(worktreeDir, "repo", "session");
    try {
      await mkdir(worktree, { recursive: true });
      await expect(assertAllowedSessionWorkspace({
        id: "session-1",
        kind: "workspace",
        cwd: worktree,
        piSessionFile: join(worktree, "session.jsonl"),
        isolationKind: "git_worktree",
        sourceCwd: source,
        worktreePath: worktree,
        worktreeBranch: "bakery/session/test",
        worktreeBaseCommit: "abc123",
        worktreeSourceDirty: false,
        reviewStatus: "pending",
        reviewUpdatedAt: null,
        title: null,
        titleSource: "unset",
        summary: null,
        summarySource: "unset",
        summaryUpdatedAt: null,
        metadataGenerationCount: 0,
        metadataLastGeneratedAt: null,
        autoGenerateMetadataOverride: "default",
        pinned: false,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      }, { browseRoots: [], approvedWorkspaces: [{ path: await realpath(source), label: "Source" }], worktreeDir })).resolves.toBeUndefined();
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(worktreeDir, { recursive: true, force: true });
    }
  });
});
