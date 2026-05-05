import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findLatestHarnessArtifact, formatLatestHarnessArtifactResult, normalizeHarnessScenario } from "./report-iteration-artifacts";

const tempRoots: string[] = [];
const scriptPath = resolve(import.meta.dir, "report-iteration.ts");

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bakery-iteration-artifacts-"));
  tempRoots.push(root);
  mkdirSync(join(root, "test-results", "ui-harness"), { recursive: true });
  return root;
}

function writeArtifact(root: string, dirName: string, options: { scenario?: string; scenarios?: string[]; failed?: boolean; screenshot?: string; log?: boolean } = {}): string {
  const dir = join(root, "test-results", "ui-harness", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metrics.json"), `${JSON.stringify({ scenario: options.scenario, scenarios: options.scenarios })}\n`);
  if (options.failed) writeFileSync(join(dir, "failure.txt"), "Expected completed state\nStack details omitted\n");
  if (options.log) {
    writeFileSync(join(dir, "server.log"), "server log\n");
    writeFileSync(join(dir, "web.log"), "web log\n");
    writeFileSync(join(dir, "console.log"), "console log\n");
  }
  if (options.screenshot) writeFileSync(join(dir, options.screenshot), "not-a-real-png-but-listed\n");
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("report iteration harness artifact helpers", () => {
  test("normalizes scenario inputs", () => {
    expect(normalizeHarnessScenario("ui-harness:slash-commands")).toBe("slash-commands");
    expect(normalizeHarnessScenario("bun scripts/ui-harness.ts --scenario question-answer")).toBe("question-answer");
  });

  test("selects the latest overall artifact by harness timestamp before mtime fallback", () => {
    const root = makeRoot();
    writeArtifact(root, "question-answer-2026-05-05T02-00-00-000Z", { scenario: "question-answer", failed: true, log: true });
    writeArtifact(root, "slash-commands-2026-05-05T01-00-00-000Z", { scenario: "slash-commands" });

    const result = findLatestHarnessArtifact({ root });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.artifact.scenario).toBe("question-answer");
      expect(result.artifact.failed).toBe(true);
    }
  });

  test("selects scenario-specific artifacts via metrics and directory fallback", () => {
    const root = makeRoot();
    writeArtifact(root, "grouped-run-2026-05-05T01-00-00-000Z", { scenarios: ["slash-commands", "question-answer"] });
    writeArtifact(root, "subagent-card-2026-05-05T02-00-00-000Z", { failed: true });

    const metricsResult = findLatestHarnessArtifact({ root, scenario: "ui-harness:slash-commands" });
    expect(metricsResult.found).toBe(true);
    if (metricsResult.found) expect(metricsResult.artifact.availableScenarios).toContain("slash-commands");

    const fallbackResult = findLatestHarnessArtifact({ root, scenario: "subagent-card" });
    expect(fallbackResult.found).toBe(true);
    if (fallbackResult.found) expect(fallbackResult.artifact.scenario).toBe("subagent-card");
  });

  test("reports missing scenarios with available scenario names", () => {
    const root = makeRoot();
    writeArtifact(root, "slash-commands-2026-05-05T01-00-00-000Z", { scenario: "slash-commands" });

    const result = findLatestHarnessArtifact({ root, scenario: "missing-scenario" });
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toContain("missing-scenario");
      expect(result.availableScenarios).toContain("slash-commands");
    }
  });

  test("formats inspect commands for a failed artifact", () => {
    const root = makeRoot();
    writeArtifact(root, "slash-commands-2026-05-05T01-00-00-000Z", { scenario: "slash-commands", failed: true, log: true, screenshot: "slash-commands.png" });

    const result = findLatestHarnessArtifact({ root, scenario: "slash-commands" });
    const text = formatLatestHarnessArtifactResult(result);
    expect(text).toContain("Latest artifact: test-results/ui-harness/slash-commands");
    expect(text).toContain("Inspect failure: sed -n '1,160p'");
    expect(text).toContain("Inspect logs: tail -n 120");
    expect(text).toContain("Screenshots:");
  });
});

describe("report iteration latest-artifact CLI", () => {
  test("short-circuits generic report writes", () => {
    const root = makeRoot();
    writeArtifact(root, "slash-commands-2026-05-05T01-00-00-000Z", { scenario: "slash-commands", failed: true, log: true });

    const result = Bun.spawnSync([process.execPath, scriptPath, "--latest-artifact", "slash-commands"], {
      env: { ...process.env, PI_WEB_ITERATION_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Latest artifact: test-results/ui-harness/slash-commands");
    expect(result.stdout.toString()).not.toContain("Wrote test-results/iteration/iteration-report.json");
    expect(existsSync(join(root, "test-results", "iteration", "iteration-report.json"))).toBe(false);
  });

  test("accepts --latest-artifact --scenario scenario syntax", () => {
    const root = makeRoot();
    writeArtifact(root, "slash-commands-2026-05-05T01-00-00-000Z", { scenario: "slash-commands", failed: true, log: true });

    const result = Bun.spawnSync([process.execPath, scriptPath, "--latest-artifact", "--scenario", "slash-commands"], {
      env: { ...process.env, PI_WEB_ITERATION_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Scenario: slash-commands");
  });

  test("rejects unknown flags before writing reports", () => {
    const root = makeRoot();
    const result = Bun.spawnSync([process.execPath, scriptPath, "--bogus"], {
      env: { ...process.env, PI_WEB_ITERATION_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown option --bogus");
    expect(existsSync(join(root, "test-results", "iteration", "iteration-report.json"))).toBe(false);
  });

  test("rejects missing flag values", () => {
    const root = makeRoot();
    const result = Bun.spawnSync([process.execPath, scriptPath, "--session"], {
      env: { ...process.env, PI_WEB_ITERATION_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("--session requires a value");
  });
});
