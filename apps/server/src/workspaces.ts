import { realpath } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { Workspace } from "@pi-web-agent/protocol";

export async function resolveWorkspaceRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root)));
  return [...new Set(resolved)];
}

export function toWorkspaces(roots: string[]): Workspace[] {
  return roots.map((path) => ({ path, label: basename(path) || path }));
}

export async function assertAllowedCwd(cwd: string, allowedRoots: string[]): Promise<string> {
  const resolved = await realpath(cwd);
  for (const root of allowedRoots) {
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return resolved;
  }
  throw new Error(`Workspace is not under an allowed root: ${cwd}`);
}
