import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { WebSession, Workspace, WorkspaceBrowseEntry, WorkspaceBrowseResponse } from "@pi-web-agent/protocol";

const execFileAsync = promisify(execFile);

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type WorkspacePermissionScope = {
  browseRoots: string[];
  approvedWorkspaces: Workspace[];
  worktreeDir?: string;
};

async function run(command: string, args: string[], options: ExecOptions = {}): Promise<void> {
  try {
    await execFileAsync(command, args, { cwd: options.cwd, env: options.env, maxBuffer: 1024 * 1024 * 8 });
  } catch (error) {
    const details = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`${command} ${args.join(" ")} failed${details ? `: ${details.trim()}` : ""}`);
  }
}

export async function resolveWorkspaceRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root)));
  return [...new Set(resolved)];
}

export function toWorkspaces(roots: string[]): Workspace[] {
  return roots.map((path) => ({ path, label: workspaceDisplayName(path) }));
}

export function mergeWorkspaces(configRoots: string[], stored: Workspace[]): Workspace[] {
  const byPath = new Map<string, Workspace>();
  for (const workspace of [...toWorkspaces(configRoots), ...stored]) byPath.set(workspace.path, workspace);
  return [...byPath.values()].sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function permissionRoots(scope: WorkspacePermissionScope): string[] {
  return [...scope.browseRoots, ...scope.approvedWorkspaces.map((workspace) => workspace.path)];
}

async function existingRealpaths(paths: string[]): Promise<string[]> {
  const results = await Promise.all(paths.map(async (path) => {
    try {
      return await realpath(path);
    } catch {
      return null;
    }
  }));
  return results.filter((path): path is string => path !== null);
}

export async function assertAllowedCwd(cwd: string, allowedRoots: string[]): Promise<string> {
  const resolved = await realpath(cwd);
  const roots = await existingRealpaths(allowedRoots);
  for (const root of roots) {
    if (isWithin(root, resolved)) return resolved;
  }
  throw new Error(`Workspace is not under an allowed root: ${cwd}`);
}

export async function assertAllowedWorkspacePath(path: string, scope: WorkspacePermissionScope): Promise<string> {
  const roots = await existingRealpaths(permissionRoots(scope));
  const resolved = await realpath(path);
  for (const root of roots) {
    if (isWithin(root, resolved)) return resolved;
  }
  throw new Error(`Workspace is not under a Browse Root or Approved Workspace: ${path}`);
}

export async function assertAllowedSessionWorkspace(session: WebSession, scope: WorkspacePermissionScope): Promise<void> {
  if (session.cwd === null) return;
  try {
    await assertAllowedWorkspacePath(session.cwd, scope);
    return;
  } catch (error) {
    if (session.isolationKind !== "git_worktree" || !session.sourceCwd || !scope.worktreeDir) throw error;
  }

  const worktreePath = await realpath(session.cwd);
  const worktreeRoot = await realpath(scope.worktreeDir);
  if (!isWithin(worktreeRoot, worktreePath)) throw new Error(`Session worktree is outside Bakery's managed worktree directory: ${session.cwd}`);
  await assertAllowedWorkspacePath(session.sourceCwd, scope);
}

export async function browseWorkspaceDirectory(path: string | undefined, scope: WorkspacePermissionScope): Promise<WorkspaceBrowseResponse> {
  if (!path) {
    const byPath = new Map<string, WorkspaceBrowseEntry>();
    for (const root of scope.browseRoots) byPath.set(root, { path: root, name: workspaceDisplayName(root), kind: "directory", source: "browse_root" });
    for (const workspace of scope.approvedWorkspaces) byPath.set(workspace.path, { path: workspace.path, name: workspace.label, kind: "directory", source: "approved_workspace" });
    return {
      path: null,
      entries: [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    };
  }

  const resolved = await assertAllowedWorkspacePath(path, scope);
  const entries = await readdir(resolved, { withFileTypes: true });
  const browseEntries: WorkspaceBrowseEntry[] = [];
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const child = join(resolved, entry.name);
    const stats = await lstat(child);
    if (stats.isSymbolicLink()) continue;
    if (!stats.isDirectory() && !stats.isFile()) continue;
    browseEntries.push({
      path: child,
      name: entry.name,
      kind: stats.isDirectory() ? "directory" : "file",
      source: "child",
    });
  }
  browseEntries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { path: resolved, entries: browseEntries };
}

export async function addExistingWorkspace(path: string): Promise<Workspace> {
  const resolved = await realpath(path);
  const stats = await lstat(resolved);
  if (!stats.isDirectory()) throw new Error("Workspace must be an existing directory");
  return { path: resolved, label: basename(resolved) || resolved };
}

function workspaceDisplayName(path: string): string {
  return path === homedir() ? "~" : basename(path) || path;
}

function safeDirectoryName(value: string): string {
  const name = value
    .replace(/\.git$/i, "")
    .split(/[/:]/)
    .filter(Boolean)
    .at(-1)
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!name) throw new Error("Could not infer a target directory name");
  return name;
}

export async function cloneWorkspace(input: { url: string; basePath: string; targetName?: string }): Promise<Workspace> {
  const base = await realpath(input.basePath);
  const target = resolve(base, input.targetName ?? safeDirectoryName(input.url));
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) throw new Error("Clone target must stay under the selected base workspace root");
  await mkdir(base, { recursive: true });
  await run("git", ["clone", input.url, target]);
  return addExistingWorkspace(target);
}

type GithubRepositoryResponse = {
  full_name?: string;
  clone_url?: string;
};

export async function createGithubRepositoryWorkspace(input: {
  name: string;
  owner?: string;
  description?: string;
  private?: boolean;
  basePath: string;
  token?: string;
}): Promise<Workspace> {
  const token = input.token?.trim();
  if (!token) throw new Error("GitHub repository creation requires GH_TOKEN or GITHUB_TOKEN on the backend");
  const endpoint = input.owner ? `https://api.github.com/orgs/${encodeURIComponent(input.owner)}/repos` : "https://api.github.com/user/repos";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "bakery-local-workspaces",
    },
    body: JSON.stringify({
      name: input.name,
      description: input.description || undefined,
      private: input.private ?? true,
      auto_init: true,
    }),
  });
  if (!response.ok) throw new Error(`GitHub repository creation failed: ${response.status} ${await response.text()}`);
  const repo = await response.json() as GithubRepositoryResponse;
  const fullName = repo.full_name;
  const cloneUrl = repo.clone_url;
  if (!fullName || !cloneUrl) throw new Error("GitHub repository response did not include clone details");

  const base = await realpath(input.basePath);
  const target = join(base, safeDirectoryName(input.name));
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) throw new Error("Repository target must stay under the selected base workspace root");

  try {
    await run("gh", ["repo", "clone", fullName, target], { env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token } });
  } catch {
    await run("git", ["clone", cloneUrl, target]);
  }
  return addExistingWorkspace(target);
}
