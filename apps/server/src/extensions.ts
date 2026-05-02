import type { CommandInfo } from "@pi-web-agent/protocol";
import { BAKERY_BUNDLED_EXTENSION } from "./bundled-extensions/bakery/index.js";
import { PLAN_BUNDLED_EXTENSION } from "./bundled-extensions/plan/index.js";
import type { GenerateSessionDetailsOptions, GenerateSessionDetailsResult } from "./metadata-routes.js";

export type ExtensionCapability = "commands";

export type ExtensionCommandResult =
  | { kind: "handled"; title?: string; body?: string; isError?: boolean; data?: unknown }
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

export type BakeryExtension = {
  id: string;
  displayName: string;
  version?: string;
  capabilities?: ExtensionCapability[];
  commands?: ExtensionCommand[];
  activate?(ctx: { extensionId: string }): void | Promise<void>;
};

export const BUNDLED_EXTENSIONS: BakeryExtension[] = [PLAN_BUNDLED_EXTENSION, BAKERY_BUNDLED_EXTENSION];

const bundledExtensionCommandEntries = BUNDLED_EXTENSIONS.flatMap((extension) =>
  (extension.commands ?? []).map((command) => ({ extension, command })),
);

const bundledExtensionCommandsByName = new Map(bundledExtensionCommandEntries.map((entry) => [entry.command.name, entry]));

export const BUNDLED_EXTENSION_COMMANDS: CommandInfo[] = bundledExtensionCommandEntries.map(({ command }) => ({
  name: command.name,
  ...(command.description ? { description: command.description } : {}),
  ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  source: command.source ?? "extension",
  ...(command.sourceInfo ? { sourceInfo: command.sourceInfo } : {}),
}));

export function isBundledExtensionCommand(name: string): boolean {
  return bundledExtensionCommandsByName.has(name);
}

export function getBundledExtensionCommand(name: string): ExtensionCommand | undefined {
  return bundledExtensionCommandsByName.get(name)?.command;
}

export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([\w:-]+(?:-[\w:-]+)*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1] ?? "", args: match[2]?.trim() ?? "" };
}

export async function runBundledExtensionCommand(name: string, args: string, services?: ExtensionCommandServices): Promise<ExtensionCommandResult | undefined> {
  const entry = bundledExtensionCommandsByName.get(name);
  if (!entry) return undefined;
  return await entry.command.handler({ extensionId: entry.extension.id, ...(services ? { services } : {}) }, args);
}
