import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parsePlanChainMarkdown, resolvePlanChain } from "./plan-chain-config.js";
import { PLAN_BUNDLED_EXTENSION } from "./index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "bakery-plan-chain-"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeChain(root: string, name: string, marker = "project"): void {
  const dir = join(root, ".pi", "chains");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.chain.md`), `---
name: ${name}
description: ${marker} chain
---

## scout
output: ${marker}.md
outputMode: file-only
reads: DESIGN.md, PROJECT_LOG.md
progress: true

Scan {task}

## planner

Plan from {previous}
`);
}

describe("plan chain config", () => {
  test("parses supported saved chain fields", () => {
    const parsed = parsePlanChainMarkdown(`---
name: dev-loop-plan
description: Dev loop
---

## scout
output: context.md
outputMode: file-only
reads: DESIGN.md, PROJECT_LOG.md
skills: iteration-observability, audit
progress: true
model: openai/gpt-5

Gather context
`);

    expect(parsed.name).toBe("dev-loop-plan");
    expect(parsed.steps).toEqual([
      {
        agent: "scout",
        output: "context.md",
        outputMode: "file-only",
        reads: ["DESIGN.md", "PROJECT_LOG.md"],
        skill: ["iteration-observability", "audit"],
        progress: true,
        model: "openai/gpt-5",
        task: "Gather context",
      },
    ]);
  });

  test("project default resolves and overrides user default", () => {
    const project = tempRoot();
    const userHome = tempRoot();
    writeJson(join(project, ".pi", "settings.json"), { bakery: { plan: { defaultChain: "project-plan" } } });
    writeJson(join(userHome, ".pi", "agent", "settings.json"), { bakery: { plan: { defaultChain: "user-plan" } } });
    writeChain(project, "project-plan", "project");
    mkdirSync(join(userHome, ".pi", "agent", "chains"), { recursive: true });
    writeFileSync(join(userHome, ".pi", "agent", "chains", "user-plan.chain.md"), `---
name: user-plan
---

## scout

User scan
`);

    const resolved = resolvePlanChain({ cwd: project, userHome, hasPiSubagents: true });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.source).toBe("project");
    expect(resolved.chainName).toBe("project-plan");
    expect(resolved.recipe).toContain('"output": "project.md"');
  });

  test("missing project default warns without falling back to user default", () => {
    const project = tempRoot();
    const userHome = tempRoot();
    writeJson(join(project, ".pi", "settings.json"), { bakery: { plan: { defaultChain: "missing-plan" } } });
    writeJson(join(userHome, ".pi", "agent", "settings.json"), { bakery: { plan: { defaultChain: "user-plan" } } });
    mkdirSync(join(userHome, ".pi", "agent", "chains"), { recursive: true });
    writeFileSync(join(userHome, ".pi", "agent", "chains", "user-plan.chain.md"), `---
name: user-plan
---

## scout

User scan
`);

    expect(resolvePlanChain({ cwd: project, userHome, hasPiSubagents: true })).toEqual({
      kind: "warning",
      source: "project",
      chainName: "missing-plan",
      reason: "configured chain was not found",
    });
  });

  test("missing user default silently falls back to normal plan", () => {
    const project = tempRoot();
    const userHome = tempRoot();
    writeJson(join(userHome, ".pi", "agent", "settings.json"), { bakery: { plan: { defaultChain: "missing-user-plan" } } });

    expect(resolvePlanChain({ cwd: project, userHome, hasPiSubagents: true })).toEqual({ kind: "none" });
  });

  test("project default warns when pi-subagents commands are unavailable", () => {
    const project = tempRoot();
    const userHome = tempRoot();
    writeJson(join(project, ".pi", "settings.json"), { bakery: { plan: { defaultChain: "project-plan" } } });
    writeChain(project, "project-plan");

    expect(resolvePlanChain({ cwd: project, userHome, hasPiSubagents: false })).toEqual({
      kind: "warning",
      source: "project",
      chainName: "project-plan",
      reason: "pi-subagents does not appear to be installed or loaded for this session",
    });
  });

  test("plan command embeds resolved project chain recipe", async () => {
    const project = tempRoot();
    const userHome = tempRoot();
    writeJson(join(project, ".pi", "settings.json"), { bakery: { plan: { defaultChain: "project-plan" } } });
    writeChain(project, "project-plan");

    const command = PLAN_BUNDLED_EXTENSION.commands?.[0];
    const result = await command?.handler({
      extensionId: "bakery.workflow",
      services: {
        getSessionCwd: () => project,
        hasCommand: (name) => name === "run-chain",
      },
    }, "test focus");

    expect(result?.kind).toBe("launchPrompt");
    if (result?.kind !== "launchPrompt") return;
    expect(result.prompt).toContain("Configured planning chain:");
    expect(result.prompt).toContain("subagent({");
    expect(result.prompt).toContain("project-plan");
    expect(result.prompt).toContain('"outputMode": "file-only"');
    expect(result.prompt).toContain("temporary chain artifact directory, not the repository root");
  });
});
