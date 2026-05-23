import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { banner, launcherConfig, parseArgs, publicHost, resolveWorkspaceRoot } from "./bakery-cli-core";

const cliPath = resolve(import.meta.dir, "bakery-cli.ts");

describe("bakery CLI argument parsing", () => {
  test("accepts MVP flags", () => {
    const parsed = parseArgs(["--no-open", "--workspace", ".", "--host=0.0.0.0", "--port", "4123"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options.open).toBe(false);
      expect(parsed.options.workspace).toBe(".");
      expect(parsed.options.host).toBe("0.0.0.0");
      expect(parsed.options.port).toBe("4123");
    }
  });

  test("rejects unknown flags and missing values", () => {
    expect(parseArgs(["--bogus"])).toEqual({ ok: false, message: "unknown option --bogus" });
    expect(parseArgs(["--workspace"])).toEqual({ ok: false, message: "--workspace requires a value" });
  });

  test("prints help without requiring the configured workspace to exist", () => {
    const result = Bun.spawnSync([process.execPath, cliPath, "--help"], {
      env: { ...process.env, PI_WEB_WORKSPACE_ROOT: join(tmpdir(), "bakery-missing-workspace-for-help") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("--workspace PATH");
    expect(result.stderr.toString()).toBe("");
  });
});

describe("bakery CLI launcher config", () => {
  test("normalizes public hosts for printed URLs", () => {
    expect(publicHost("0.0.0.0")).toBe("127.0.0.1");
    expect(publicHost("::")).toBe("127.0.0.1");
    expect(publicHost("localhost")).toBe("localhost");
  });

  test("resolves the workspace real path and applies CLI host/port overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-cli-workspace-"));
    try {
      const config = launcherConfig(
        { ...process.env, PI_WEB_HOST: "127.0.0.1", PI_WEB_PORT: "3141", PI_WEB_WORKSPACE_ROOT: undefined },
        dir,
        { help: false, version: false, open: false, host: "0.0.0.0", port: "4222", workspace: dir },
      );
      expect("error" in config).toBe(false);
      if (!("error" in config)) {
        expect(config.workspaceRoot).toBe(resolve(dir));
        expect(config.backendHost).toBe("0.0.0.0");
        expect(config.backendPort).toBe("4222");
        expect(config.backendUrl).toBe("http://127.0.0.1:4222");
        expect(config.openBrowser).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("warns for overly broad workspace roots", () => {
    const result = resolveWorkspaceRoot(resolve("/"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toContain("Workspace is a filesystem root; prefer a narrower project directory.");
  });

  test("prints browser-open and workspace warning status", () => {
    const text = banner({
      repoRoot: "/repo",
      invocationCwd: "/repo",
      workspaceRoot: "/",
      workspaceWarnings: ["Workspace is a filesystem root; prefer a narrower project directory."],
      openBrowser: true,
      backendHost: "127.0.0.1",
      backendPort: "3141",
      webHost: "127.0.0.1",
      webPort: "5173",
      backendUrl: "http://127.0.0.1:3141",
      uiUrl: "http://127.0.0.1:5173",
    });

    expect(text).toContain("Opening browser automatically");
    expect(text).toContain("Warnings:");
    expect(text).toContain("filesystem root");
  });
});
