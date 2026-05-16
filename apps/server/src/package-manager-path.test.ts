import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ensurePackageManagerPath } from "./package-manager-path.js";

const tempDirs: string[] = [];

function makeBinDir(command: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bakery-path-"));
  tempDirs.push(dir);
  const path = join(dir, command);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

describe("ensurePackageManagerPath", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("prepends a candidate npm directory when PATH cannot find npm", () => {
    const npmDir = makeBinDir("npm");
    const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

    ensurePackageManagerPath(env, { candidateDirs: [npmDir], loginShell: false });

    expect(env.PATH?.split(delimiter)[0]).toBe(npmDir);
  });

  test("keeps PATH unchanged when npm is already available", () => {
    const npmDir = makeBinDir("npm");
    const otherDir = makeBinDir("npm");
    const env = { PATH: npmDir } as NodeJS.ProcessEnv;

    ensurePackageManagerPath(env, { candidateDirs: [otherDir], loginShell: false });

    expect(env.PATH).toBe(npmDir);
  });
});
