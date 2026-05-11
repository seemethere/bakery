import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { summarizeGitWorktreeChanges } from "./git-worktrees.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("summarizeGitWorktreeChanges", () => {
  test("summarizes tracked and untracked changes since the base commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-review-summary-"));
    try {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test User"]);
      writeFileSync(join(dir, "tracked.txt"), "one\n", "utf8");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "initial"]);
      const baseCommit = git(dir, ["rev-parse", "HEAD"]);

      writeFileSync(join(dir, "tracked.txt"), "two\n", "utf8");
      writeFileSync(join(dir, "untracked.txt"), "new\n", "utf8");

      const summary = await summarizeGitWorktreeChanges({ worktreePath: dir, baseCommit });

      expect(summary).toMatchObject({ state: "available", baseCommit, changedFileCount: 2, truncated: false });
      expect(summary.files).toEqual([
        { status: "M", path: "tracked.txt" },
        { status: "??", path: "untracked.txt" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a missing worktree as unavailable", async () => {
    const summary = await summarizeGitWorktreeChanges({ worktreePath: "/tmp/bakery-missing-worktree", baseCommit: "abc123" });

    expect(summary).toMatchObject({ state: "unavailable", baseCommit: "abc123", changedFileCount: 0, files: [] });
  });
});
