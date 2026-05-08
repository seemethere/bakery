import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addExistingWorkspace, assertAllowedCwd, mergeWorkspaces } from "./workspaces.js";

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
});
