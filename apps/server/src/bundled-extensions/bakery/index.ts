import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { BakeryExtension, ExtensionCommandResult, GenerateSessionDetailsCommandOptions } from "../../extensions.js";
import type { GenerateSessionDetailsResult } from "../../metadata-routes.js";

export function parseGenerateDetailsArgs(args: string): GenerateSessionDetailsCommandOptions {
  const tokens = args.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const guidance: string[] = [];
  let replaceManual = false;
  for (const token of tokens) {
    const value = token.replace(/^"|"$/g, "");
    if (value === "--replace") replaceManual = true;
    else guidance.push(value);
  }
  const guidanceText = guidance.join(" ").replace(/\s+/g, " ").trim();
  return {
    replaceManual,
    ...(guidanceText ? { guidance: guidanceText } : {}),
  };
}

function generateDetailsCardData(result: GenerateSessionDetailsResult): Record<string, unknown> {
  return {
    applied: result.applied,
    skipped: result.skipped,
    deferred: Boolean(result.suggestion.deferred),
    ...(result.suggestion.title ? { title: result.suggestion.title } : {}),
    ...(result.suggestion.summary ? { summary: result.suggestion.summary } : {}),
    ...(result.suggestion.reason ? { reason: result.suggestion.reason } : {}),
  };
}

function formatGenerateDetailsReceipt(result: GenerateSessionDetailsResult): string {
  const lines: string[] = [];
  if (result.suggestion.deferred) {
    lines.push(result.suggestion.reason ?? "Not enough session context for useful details yet.");
    return lines.join("\n");
  }
  if (result.applied.length > 0) lines.push(`Updated ${result.applied.join(" and ")}.`);
  if (result.skipped.length > 0) {
    for (const skipped of result.skipped) lines.push(`Skipped ${skipped.field}: ${skipped.reason}. Use --replace to overwrite.`);
  }
  if (result.applied.length === 0 && result.skipped.length === 0) lines.push("No usable title or summary was generated.");
  if (result.suggestion.title) lines.push(`Title: ${result.suggestion.title}`);
  if (result.suggestion.summary) lines.push(`Summary: ${result.suggestion.summary}`);
  return lines.join("\n");
}

export const BAKERY_BUNDLED_EXTENSION: BakeryExtension = {
  id: "bakery.core",
  rootDir: dirname(fileURLToPath(import.meta.url)),
  displayName: "Bakery commands",
  version: "0.1.0",
  capabilities: ["commands", "ui:transcript.customCard"],
  web: { entry: "web/metadata-details-card.js" },
  ui: [
    { slot: "transcript.customCard", kind: "bakery.metadataDetails", component: "bakery-metadata-details-card" },
  ],
  commands: [
    {
      name: "bakery:generate-details",
      description: "Generate and apply this session's title and summary metadata",
      argumentHint: "[--replace] [guidance]",
      source: "extension",
      sourceInfo: { kind: "bundled-bakery-command", package: "bakery" },
      handler: async (ctx, args): Promise<ExtensionCommandResult> => {
        if (!ctx.services?.generateSessionDetails) {
          return { kind: "handled", title: "/bakery:generate-details", body: "This command is available from an active Bakery web session.", isError: true };
        }
        const result = await ctx.services.generateSessionDetails(parseGenerateDetailsArgs(args));
        return {
          kind: "handled",
          title: "/bakery:generate-details",
          body: formatGenerateDetailsReceipt(result),
          isError: Boolean(result.suggestion.deferred),
          card: { kind: "bakery.metadataDetails", props: generateDetailsCardData(result) },
        };
      },
    },
  ],
};
