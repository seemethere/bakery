import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createForkFile } from "./session-routes.js";

function writeSessionFile(dir: string): string {
  const sourceFile = join(dir, "source.jsonl");
  const entries = [
    { type: "session", version: 3, id: "source-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Build the tree" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "Done" } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "Try again" } },
  ];
  writeFileSync(sourceFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return sourceFile;
}

function forkEntries(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("session fork files", () => {
  test("forks before user messages and returns editor text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-session-fork-"));
    try {
      const sourceFile = writeSessionFile(dir);
      const fork = await createForkFile(sourceFile, dir, "u2", dir, "auto");
      expect(fork.editorText).toBe("Try again");
      expect(forkEntries(fork.piSessionFile).map((entry) => entry.id)).toEqual([expect.any(String), "u1", "a1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forks through non-user events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-session-fork-"));
    try {
      const sourceFile = writeSessionFile(dir);
      const fork = await createForkFile(sourceFile, dir, "a1", dir, "auto");
      expect(fork.editorText).toBeUndefined();
      expect(forkEntries(fork.piSessionFile).map((entry) => entry.id)).toEqual([expect.any(String), "u1", "a1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
