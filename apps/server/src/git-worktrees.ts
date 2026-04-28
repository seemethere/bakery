import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

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

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "repo";
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
