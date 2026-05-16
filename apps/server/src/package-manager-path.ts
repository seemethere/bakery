import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";

type EnsurePackageManagerPathOptions = {
  candidateDirs?: string[];
  loginShell?: string | false;
};

function splitPath(pathValue: string | undefined): string[] {
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

function hasExecutable(command: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of splitPath(env.PATH)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function prependPathDirs(env: NodeJS.ProcessEnv, dirs: string[]): void {
  const existing = splitPath(env.PATH);
  const seen = new Set(existing);
  const additions = dirs.filter((dir) => dir && existsSync(dir) && !seen.has(dir));
  if (additions.length === 0) return;
  env.PATH = [...additions, ...existing].join(delimiter);
}

function npmDirFromLoginShell(shell: string | false): string | null {
  if (!shell) return null;
  const result = spawnSync(shell, ["-lc", "command -v npm"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) return null;
  const npmPath = result.stdout.trim().split(/\r?\n/)[0];
  return npmPath ? dirname(npmPath) : null;
}

export function ensurePackageManagerPath(env: NodeJS.ProcessEnv = process.env, options: EnsurePackageManagerPathOptions = {}): void {
  if (hasExecutable("npm", env)) return;

  const candidateDirs = options.candidateDirs ?? [
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".bun", "bin"),
  ];
  prependPathDirs(env, candidateDirs);
  if (hasExecutable("npm", env)) return;

  const shellDir = npmDirFromLoginShell(options.loginShell === undefined ? "/bin/zsh" : options.loginShell);
  if (shellDir) prependPathDirs(env, [shellDir]);
}
