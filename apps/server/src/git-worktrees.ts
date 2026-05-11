import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionReviewFile, SessionReviewSummary } from "@pi-web-agent/protocol";

export type GitWorktreeSession = {
  cwd: string;
  sourceCwd: string;
  worktreePath: string;
  worktreeBranch: string;
  worktreeBaseCommit: string;
  worktreeSourceDirty: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

async function git(args: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  return result.stdout.trim();
}

function parseNameStatusLine(line: string): SessionReviewFile | null {
  const parts = line.split("\t");
  const status = parts[0]?.trim();
  const path = parts.at(-1)?.trim();
  if (!status || !path) return null;
  return { status, path };
}

function parseUntrackedStatusLine(line: string): SessionReviewFile | null {
  if (!line.startsWith("?? ")) return null;
  const path = line.slice(3).trim();
  return path ? { status: "??", path } : null;
}

function summarizeFiles(files: SessionReviewFile[], limit: number): Pick<SessionReviewSummary, "changedFileCount" | "files" | "truncated"> {
  // Keep one row per path. The caller adds tracked diff rows first and untracked
  // status rows second, so this only replaces a path when Git reports a clearer
  // working-tree/untracked state for the same display path.
  const byPath = new Map<string, SessionReviewFile>();
  for (const file of files) byPath.set(file.path, file);
  const all = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { changedFileCount: all.length, files: all.slice(0, limit), truncated: all.length > limit };
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "repo";
}

export async function summarizeGitWorktreeChanges(options: {
  worktreePath: string | null;
  baseCommit: string | null;
  limit?: number;
}): Promise<SessionReviewSummary> {
  if (!options.worktreePath || !options.baseCommit) {
    return { state: "unavailable", baseCommit: options.baseCommit, changedFileCount: 0, files: [], truncated: false, message: "Session review requires an isolated Git worktree." };
  }
  if (!existsSync(options.worktreePath)) {
    return { state: "unavailable", baseCommit: options.baseCommit, changedFileCount: 0, files: [], truncated: false, message: "The session worktree no longer exists." };
  }
  try {
    const diff = await gitOk(["diff", "--name-status", "--find-renames", options.baseCommit], options.worktreePath);
    const status = await gitOk(["status", "--porcelain=v1", "--untracked-files=all"], options.worktreePath);
    const files = [
      ...diff.split("\n").map(parseNameStatusLine).filter((file): file is SessionReviewFile => Boolean(file)),
      ...status.split("\n").map(parseUntrackedStatusLine).filter((file): file is SessionReviewFile => Boolean(file)),
    ];
    return { state: "available", baseCommit: options.baseCommit, ...summarizeFiles(files, options.limit ?? 50) };
  } catch (error) {
    return { state: "error", baseCommit: options.baseCommit, changedFileCount: 0, files: [], truncated: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function createGitWorktreeSession(options: {
  sourceCwd: string;
  sessionId: string;
  worktreeDir: string;
}): Promise<GitWorktreeSession> {
  const sourceRoot = await gitOk(["rev-parse", "--show-toplevel"], options.sourceCwd);
  const baseCommit = await gitOk(["rev-parse", "HEAD"], sourceRoot);
  const status = await gitOk(["status", "--porcelain"], sourceRoot);
  const shortId = safePathSegment(options.sessionId.slice(0, 8));
  const repoName = safePathSegment(basename(sourceRoot));
  const branch = `bakery/session/${shortId}`;
  const worktreePath = join(options.worktreeDir, repoName, shortId);

  await mkdir(join(options.worktreeDir, repoName), { recursive: true });
  await gitOk(["worktree", "add", "-b", branch, worktreePath, baseCommit], sourceRoot);

  return {
    cwd: worktreePath,
    sourceCwd: sourceRoot,
    worktreePath,
    worktreeBranch: branch,
    worktreeBaseCommit: baseCommit,
    worktreeSourceDirty: status.length > 0,
  };
}
