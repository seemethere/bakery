import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerConfig } from "./config.js";
import { getBakeryExtensionCardContributions, getBakeryExtensionCommands, getBakeryExtensionRegistry, loadConfiguredBakeryExtensions, runBundledExtensionCommand } from "./extensions.js";

const baseConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 3141,
  authRequired: false,
  workspaceRoots: [],
  metadataDbPath: ":memory:",
  sessionDir: "",
  artifactDir: "",
  worktreeDir: "",
  previewRuntimeDir: "",
  allowedOrigins: [],
  fakeAgent: true,
  toolPermissionPolicy: { allowedModes: ["bypass", "confirm"], defaultMode: "bypass", confirmTools: [], denyTools: [] },
  modelPolicy: { defaultThinkingLevel: "medium", allowedThinkingLevels: ["medium"] },
  resourcePolicy: { loadGlobalResources: true, loadProjectResources: true, allowExtensions: true, allowSkills: true, allowPromptTemplates: true, allowContextFiles: true, additionalExtensionPaths: [] },
  sessionLifecycle: { disconnectedIdleTimeoutMs: 0, disconnectedRunningPolicy: "let-finish" },
};

afterEach(async () => {
  await loadConfiguredBakeryExtensions(baseConfig);
});

describe("Bakery extension registry", () => {
  test("bundled metadata command declares an extension card", async () => {
    await loadConfiguredBakeryExtensions(baseConfig);
    expect(getBakeryExtensionCommands().map((command) => command.name)).toContain("bakery:generate-details");
    expect(getBakeryExtensionCardContributions()).toContainEqual({
      slot: "transcript.customCard",
      extensionId: "bakery.core",
      kind: "bakery.metadataDetails",
      component: "bakery-metadata-details-card",
    });
  });

  test("loads configured directory extensions with commands and web cards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakery-extension-"));
    await writeFile(join(dir, "index.js"), `export default {
      id: "local.demo",
      displayName: "Local Demo",
      capabilities: ["commands", "ui:transcript.customCard"],
      web: { entry: "web/card.js" },
      ui: [{ slot: "transcript.customCard", kind: "local.demo.card", component: "local-demo-card" }],
      commands: [{ name: "demo", description: "Demo", handler: () => ({ kind: "handled", title: "/demo", card: { kind: "local.demo.card", props: { ok: true } } }) }],
    };`);

    const registry = await loadConfiguredBakeryExtensions({
      ...baseConfig,
      resourcePolicy: { ...baseConfig.resourcePolicy, additionalExtensionPaths: [dir] },
    });

    expect(registry.issues).toEqual([]);
    expect(getBakeryExtensionCommands().map((command) => command.name)).toContain("demo");
    expect(getBakeryExtensionCardContributions()).toContainEqual({ slot: "transcript.customCard", extensionId: "local.demo", kind: "local.demo.card", component: "local-demo-card" });
    expect(getBakeryExtensionRegistry().extensions.find((extension) => extension.id === "local.demo")?.webModule?.entryUrl).toBe("/api/extensions/local.demo/web/web/card.js");
    expect(await runBundledExtensionCommand("demo", "")).toEqual({ kind: "handled", title: "/demo", card: { kind: "local.demo.card", props: { ok: true } } });
  });

  test("reports configured extension load issues without dropping bundled extensions", async () => {
    const registry = await loadConfiguredBakeryExtensions({
      ...baseConfig,
      resourcePolicy: { ...baseConfig.resourcePolicy, additionalExtensionPaths: [join(tmpdir(), "missing-bakery-extension")] },
    });

    expect(registry.issues).toHaveLength(1);
    expect(getBakeryExtensionCommands().map((command) => command.name)).toContain("plan");
  });

  test("rejects unsafe or ambiguous configured contributions while keeping bundled extensions", async () => {
    const invalidTagDir = await mkdtemp(join(tmpdir(), "bakery-extension-invalid-tag-"));
    await writeFile(join(invalidTagDir, "index.js"), `export default {
      id: "local.invalidTag",
      displayName: "Invalid Tag",
      capabilities: ["ui:transcript.customCard"],
      web: { entry: "web/card.js" },
      ui: [{ slot: "transcript.customCard", kind: "local.invalid.card", component: "LocalDemoCard" }],
    };`);

    const duplicateCommandDir = await mkdtemp(join(tmpdir(), "bakery-extension-duplicate-command-"));
    await writeFile(join(duplicateCommandDir, "index.js"), `export default {
      id: "local.duplicateCommand",
      displayName: "Duplicate Command",
      capabilities: ["commands"],
      commands: [{ name: "plan", handler: () => ({ kind: "handled" }) }],
    };`);

    const registry = await loadConfiguredBakeryExtensions({
      ...baseConfig,
      resourcePolicy: { ...baseConfig.resourcePolicy, additionalExtensionPaths: [invalidTagDir, duplicateCommandDir] },
    });

    expect(registry.issues.map((issue) => issue.message).join("\n")).toContain("component must be a valid custom-element tag");
    expect(registry.issues.map((issue) => issue.message).join("\n")).toContain("duplicate extension command(s): plan");
    expect(getBakeryExtensionCommands().map((command) => command.name)).toContain("plan");
    expect(getBakeryExtensionCommands().map((command) => command.name)).not.toContain("local-invalid");
  });
});
