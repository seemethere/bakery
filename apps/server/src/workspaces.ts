import { mkdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { Workspace } from "@pi-web-agent/protocol";

const execFileAsync = promisify(execFile);

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
  return roots.map((path) => ({ path, label: basename(path) || path }));
}

export function mergeWorkspaces(configRoots: string[], stored: Workspace[]): Workspace[] {
  const byPath = new Map<string, Workspace>();
  for (const workspace of [...toWorkspaces(configRoots), ...stored]) byPath.set(workspace.path, workspace);
  return [...byPath.values()].sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

export async function assertAllowedCwd(cwd: string, allowedRoots: string[]): Promise<string> {
  const resolved = await realpath(cwd);
  for (const root of allowedRoots) {
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return resolved;
  }
  throw new Error(`Workspace is not under an allowed root: ${cwd}`);
}

export async function addExistingWorkspace(path: string): Promise<Workspace> {
  const resolved = await realpath(path);
  return { path: resolved, label: basename(resolved) || resolved };
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
