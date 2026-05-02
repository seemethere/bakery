import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { CommandInfo, ExtensionCardContribution, ExtensionWebModule } from "@pi-web-agent/protocol";
import { BAKERY_BUNDLED_EXTENSION } from "./bundled-extensions/bakery/index.js";
import { PLAN_BUNDLED_EXTENSION } from "./bundled-extensions/plan/index.js";
import type { ServerConfig } from "./config.js";
import type { GenerateSessionDetailsOptions, GenerateSessionDetailsResult } from "./metadata-routes.js";

export type ExtensionCapability = "commands" | "ui:transcript.customCard";

export type ExtensionCommandResult =
  | { kind: "handled"; title?: string; body?: string; isError?: boolean; data?: unknown; card?: { kind: string; props?: unknown } }
  | { kind: "launchPrompt"; title?: string; prompt: string; compactLaunchText?: string };

export type GenerateSessionDetailsCommandOptions = GenerateSessionDetailsOptions;

export type ExtensionCommandServices = {
  generateSessionDetails?: (options: GenerateSessionDetailsOptions) => Promise<GenerateSessionDetailsResult>;
};

export type ExtensionCommandContext = {
  extensionId: string;
  services?: ExtensionCommandServices;
};

export type ExtensionCommand = {
  name: string;
  description?: string;
  argumentHint?: string;
  source?: CommandInfo["source"];
  sourceInfo?: unknown;
  handler: (ctx: ExtensionCommandContext, args: string) => ExtensionCommandResult | Promise<ExtensionCommandResult>;
};

export type ExtensionUiContribution = {
  slot: "transcript.customCard";
  kind: string;
  component: string;
};

export type BakeryExtension = {
  id: string;
  displayName: string;
  version?: string;
  capabilities?: ExtensionCapability[];
  commands?: ExtensionCommand[];
  ui?: ExtensionUiContribution[];
  web?: { entry: string };
  rootDir?: string;
  activate?(ctx: { extensionId: string }): void | Promise<void>;
};

export type LoadedBakeryExtension = BakeryExtension & { rootDir?: string; webModule?: ExtensionWebModule };

export type ExtensionLoadIssue = { path: string; message: string };

type ExtensionCandidate = { extension: BakeryExtension; sourcePath: string };

const componentTagPattern = /^[a-z][a-z0-9]*-[a-z0-9-]*$/;
const extensionCapabilitySchema = z.enum(["commands", "ui:transcript.customCard"]);
const extensionUiContributionSchema = z.object({
  slot: z.literal("transcript.customCard"),
  kind: z.string().min(1),
  component: z.string().min(1).regex(componentTagPattern, "component must be a valid custom-element tag such as local-demo-card"),
}).passthrough();
const extensionWebSchema = z.object({ entry: z.string().min(1) }).passthrough();
const bakeryExtensionManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().optional(),
  capabilities: z.array(extensionCapabilitySchema).optional(),
  ui: z.array(extensionUiContributionSchema).optional(),
  web: extensionWebSchema.optional(),
}).passthrough();

export type BakeryExtensionRegistry = {
  extensions: LoadedBakeryExtension[];
  issues: ExtensionLoadIssue[];
};

export const BUNDLED_EXTENSIONS: BakeryExtension[] = [PLAN_BUNDLED_EXTENSION, BAKERY_BUNDLED_EXTENSION];

let activeRegistry: BakeryExtensionRegistry = normalizeExtensions(BUNDLED_EXTENSIONS.map((extension) => ({ extension, sourcePath: `bundled:${extension.id}` })));

function validateExtensionShape(extension: BakeryExtension): string | undefined {
  const parsed = bakeryExtensionManifestSchema.safeParse(extension);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ");
  if ((extension.commands ?? []).some((command) => !command || typeof command.name !== "string" || command.name.trim() === "" || typeof command.handler !== "function")) return "commands must declare a non-empty name and function handler";
  if ((extension.ui ?? []).length > 0 && !extension.web?.entry) return "extensions with UI contributions must declare web.entry";
  return undefined;
}

function normalizeExtensions(candidates: ExtensionCandidate[]): BakeryExtensionRegistry {
  const issues: ExtensionLoadIssue[] = [];
  const extensions: LoadedBakeryExtension[] = [];
  const commandOwners = new Map<string, string>();
  const cardOwners = new Map<string, string>();

  for (const { extension, sourcePath } of candidates) {
    const shapeError = validateExtensionShape(extension);
    if (shapeError) {
      issues.push({ path: sourcePath, message: shapeError });
      continue;
    }

    const duplicateCommands = (extension.commands ?? [])
      .map((command) => command.name)
      .filter((name, index, names) => names.indexOf(name) !== index || (commandOwners.has(name) && commandOwners.get(name) !== extension.id));
    if (duplicateCommands.length > 0) {
      issues.push({ path: sourcePath, message: `duplicate extension command(s): ${Array.from(new Set(duplicateCommands)).join(", ")}` });
      continue;
    }

    const duplicateCards = (extension.ui ?? [])
      .map((ui) => ui.kind)
      .filter((kind, index, kinds) => kinds.indexOf(kind) !== index || (cardOwners.has(kind) && cardOwners.get(kind) !== extension.id));
    if (duplicateCards.length > 0) {
      issues.push({ path: sourcePath, message: `duplicate extension card kind(s): ${Array.from(new Set(duplicateCards)).join(", ")}` });
      continue;
    }

    for (const command of extension.commands ?? []) commandOwners.set(command.name, extension.id);
    for (const ui of extension.ui ?? []) cardOwners.set(ui.kind, extension.id);
    const webModule = webModuleFor(extension);
    extensions.push(webModule ? { ...extension, webModule } : { ...extension });
  }
  return { extensions, issues };
}

function webModuleFor(extension: BakeryExtension): ExtensionWebModule | undefined {
  if (!extension.web?.entry) return undefined;
  return {
    extensionId: extension.id,
    entryUrl: `/api/extensions/${encodeURIComponent(extension.id)}/web/${extension.web.entry.replace(/^\/+/, "")}`,
  };
}

function extensionCommandEntries() {
  return activeRegistry.extensions.flatMap((extension) => (extension.commands ?? []).map((command) => ({ extension, command })));
}

function extensionCommandsByName(): Map<string, { extension: LoadedBakeryExtension; command: ExtensionCommand }> {
  return new Map(extensionCommandEntries().map((entry) => [entry.command.name, entry]));
}

export function setBakeryExtensionRegistry(registry: BakeryExtensionRegistry): void {
  activeRegistry = registry;
}

export function getBakeryExtensionRegistry(): BakeryExtensionRegistry {
  return activeRegistry;
}

export function getBakeryExtensionWebModules(): ExtensionWebModule[] {
  return activeRegistry.extensions.map((extension) => extension.webModule).filter((module): module is ExtensionWebModule => Boolean(module));
}

export function getBakeryExtensionCardContributions(): ExtensionCardContribution[] {
  return activeRegistry.extensions.flatMap((extension) => (extension.ui ?? [])
    .filter((ui) => ui.slot === "transcript.customCard")
    .map((ui) => ({
      slot: "transcript.customCard" as const,
      extensionId: extension.id,
      kind: ui.kind,
      component: ui.component,
    })));
}

export function getBakeryExtensionCommands(): CommandInfo[] {
  return extensionCommandEntries().map(({ extension, command }) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    source: command.source ?? "extension",
    sourceInfo: command.sourceInfo ?? { kind: "bakery-extension", extensionId: extension.id, displayName: extension.displayName },
  }));
}

export const BUNDLED_EXTENSION_COMMANDS = getBakeryExtensionCommands;

export function isBundledExtensionCommand(name: string): boolean {
  return extensionCommandsByName().has(name);
}

export function getBundledExtensionCommand(name: string): ExtensionCommand | undefined {
  return extensionCommandsByName().get(name)?.command;
}

export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([\w:-]+(?:-[\w:-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", args: match[2]?.trim() ?? "" };
}

export async function runBundledExtensionCommand(name: string, args: string, services?: ExtensionCommandServices): Promise<ExtensionCommandResult | undefined> {
  const entry = extensionCommandsByName().get(name);
  if (!entry) return undefined;
  return await entry.command.handler({ extensionId: entry.extension.id, ...(services ? { services } : {}) }, args);
}

async function resolveExtensionEntry(inputPath: string): Promise<{ entry: string; rootDir: string }> {
  const path = resolve(inputPath);
  if (!existsSync(path)) throw new Error("extension path does not exist");
  const stat = statSync(path);
  if (stat.isFile()) return { entry: path, rootDir: dirname(path) };
  if (!stat.isDirectory()) throw new Error("extension path is not a file or directory");

  const packagePath = resolve(path, "package.json");
  if (existsSync(packagePath)) {
    const raw = JSON.parse(await readFile(packagePath, "utf8")) as { bakery?: { extension?: string }; pi?: { extensions?: string[] }; main?: string };
    const configured = raw.bakery?.extension ?? raw.pi?.extensions?.[0] ?? raw.main;
    if (configured) {
      const candidate = resolve(path, configured);
      if (existsSync(candidate)) return { entry: candidate, rootDir: path };
    }
  }

  for (const name of ["bakery.extension.ts", "bakery.extension.js", "index.ts", "index.js"]) {
    const candidate = resolve(path, name);
    if (existsSync(candidate)) return { entry: candidate, rootDir: path };
  }
  throw new Error("no extension entry found");
}

function isBakeryExtension(value: unknown): value is BakeryExtension {
  if (!value || typeof value !== "object") return false;
  const extension = value as Partial<BakeryExtension>;
  return typeof extension.id === "string" && typeof extension.displayName === "string";
}

async function importExtension(entry: string, rootDir: string): Promise<BakeryExtension> {
  const module = await import(`${pathToFileURL(entry).href}?t=${Date.now()}`) as { default?: unknown };
  const exported = typeof module.default === "function" ? await module.default() : module.default;
  if (!isBakeryExtension(exported)) throw new Error("extension default export must be a BakeryExtension object or factory returning one");
  return { ...exported, rootDir };
}

export async function loadConfiguredBakeryExtensions(config: ServerConfig): Promise<BakeryExtensionRegistry> {
  const candidates: ExtensionCandidate[] = BUNDLED_EXTENSIONS.map((extension) => ({ extension, sourcePath: `bundled:${extension.id}` }));
  const loadIssues: ExtensionLoadIssue[] = [];
  if (config.resourcePolicy.allowExtensions) {
    for (const inputPath of config.resourcePolicy.additionalExtensionPaths ?? []) {
      try {
        const { entry, rootDir } = await resolveExtensionEntry(inputPath);
        candidates.push({ extension: await importExtension(entry, rootDir), sourcePath: inputPath });
      } catch (error) {
        loadIssues.push({ path: inputPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const registry = normalizeExtensions(candidates);
  registry.issues.unshift(...loadIssues);
  setBakeryExtensionRegistry(registry);
  return registry;
}

export async function reloadConfiguredBakeryExtensions(config: ServerConfig): Promise<BakeryExtensionRegistry> {
  return loadConfiguredBakeryExtensions(config);
}
