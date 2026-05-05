import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PlanChainStep = {
  agent: string;
  task?: string;
  output?: string | false;
  outputMode?: "inline" | "file-only";
  reads?: string[] | false;
  progress?: boolean;
  skill?: string[] | false;
  model?: string;
};

export type PlanChainResolution =
  | { kind: "none" }
  | { kind: "resolved"; source: "project" | "user"; chainName: string; recipe: string; steps: PlanChainStep[] }
  | { kind: "warning"; source: "project"; chainName: string; reason: string };

type SettingsDefault = { specified: boolean; value?: string | false };

type ResolveOptions = {
  cwd?: string | undefined;
  userHome?: string | undefined;
  hasPiSubagents?: boolean | undefined;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultChainFromSettings(path: string): SettingsDefault {
  if (!existsSync(path)) return { specified: false };
  const data = readJson(path);
  if (!data || typeof data !== "object") return { specified: false };
  const bakery = (data as { bakery?: unknown }).bakery;
  if (!bakery || typeof bakery !== "object") return { specified: false };
  const plan = (bakery as { plan?: unknown }).plan;
  if (!plan || typeof plan !== "object") return { specified: false };
  if (!Object.prototype.hasOwnProperty.call(plan, "defaultChain")) return { specified: false };
  const value = (plan as { defaultChain?: unknown }).defaultChain;
  if (value === false || value === null || value === "none") return { specified: true, value: false };
  if (typeof value === "string" && value.trim()) return { specified: true, value: value.trim() };
  return { specified: true, value: false };
}

function walkChainFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walkChainFiles(path, files);
    else if (entry.endsWith(".chain.md")) files.push(path);
  }
  return files;
}

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fields: {}, body: text };
  const raw = text.slice(4, end).trim();
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1]!] = match[2]!.trim();
  }
  return { fields, body: text.slice(end + "\n---".length).replace(/^\r?\n/, "") };
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseListOrFalse(value: string): string[] | false {
  if (value === "false") return false;
  return value.split(/[,+]/).map((item) => item.trim()).filter(Boolean);
}

export function parsePlanChainMarkdown(text: string): { name: string; description?: string; steps: PlanChainStep[] } {
  const { fields, body } = parseFrontmatter(text);
  const steps: PlanChainStep[] = [];
  const matches = Array.from(body.matchAll(/^##\s+(.+)\s*$/gm));
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const agent = match[1]!.trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index ?? body.length : body.length;
    const section = body.slice(start, end).replace(/^\r?\n/, "");
    const lines = section.split(/\r?\n/);
    const step: PlanChainStep = { agent };
    let taskStart = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      if (!line.trim()) {
        taskStart = lineIndex + 1;
        break;
      }
      const config = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
      if (!config) {
        taskStart = lineIndex;
        break;
      }
      const key = config[1]!;
      const value = config[2]!.trim();
      if (key === "output") step.output = value === "false" ? false : value;
      else if (key === "outputMode" && (value === "inline" || value === "file-only")) step.outputMode = value;
      else if (key === "reads") step.reads = parseListOrFalse(value);
      else if (key === "skills" || key === "skill") step.skill = parseListOrFalse(value);
      else if (key === "progress") step.progress = parseBoolean(value) ?? true;
      else if (key === "model" && value) step.model = value;
      taskStart = lineIndex + 1;
    }
    const task = lines.slice(taskStart).join("\n").trim();
    if (task) step.task = task;
    steps.push(step);
  }
  const fallbackName = fields.name || "";
  return { name: fallbackName, ...(fields.description ? { description: fields.description } : {}), steps };
}

function discoverChains(dir: string, source: "project" | "user"): Map<string, { source: "project" | "user"; path: string; steps: PlanChainStep[] }> {
  const chains = new Map<string, { source: "project" | "user"; path: string; steps: PlanChainStep[] }>();
  for (const file of walkChainFiles(dir)) {
    const parsed = parsePlanChainMarkdown(readFileSync(file, "utf8"));
    const name = parsed.name || file.split(/[\\/]/).pop()?.replace(/\.chain\.md$/, "") || "";
    if (name) chains.set(name, { source, path: file, steps: parsed.steps });
  }
  return chains;
}

function recipeForSteps(steps: PlanChainStep[]): string {
  return `subagent(${JSON.stringify({ chain: steps, context: "fresh", clarify: false }, null, 2)})`;
}

function resolveNamedChain(name: string, cwd: string | undefined, userHome: string): { source: "project" | "user"; steps: PlanChainStep[] } | null {
  const userChains = discoverChains(join(userHome, ".pi", "agent", "chains"), "user");
  const chains = new Map(userChains);
  if (cwd) {
    const projectChains = discoverChains(join(resolve(cwd), ".pi", "chains"), "project");
    for (const [chainName, chain] of projectChains) chains.set(chainName, chain);
  }
  const found = chains.get(name);
  return found ? { source: found.source, steps: found.steps } : null;
}

export function resolvePlanChain(options: ResolveOptions = {}): PlanChainResolution {
  const userHome = options.userHome ?? homedir();
  const cwd = options.cwd ? resolve(options.cwd) : undefined;
  const userSettings = (() => {
    try { return defaultChainFromSettings(join(userHome, ".pi", "agent", "settings.json")); }
    catch { return { specified: false } satisfies SettingsDefault; }
  })();
  let projectSettings: SettingsDefault = { specified: false };
  if (cwd) {
    try { projectSettings = defaultChainFromSettings(join(cwd, ".pi", "settings.json")); }
    catch { projectSettings = { specified: false }; }
  }

  const selected = projectSettings.specified ? { source: "project" as const, setting: projectSettings } : userSettings.specified ? { source: "user" as const, setting: userSettings } : null;
  if (!selected || selected.setting.value === false || !selected.setting.value) return { kind: "none" };

  const chainName = selected.setting.value;
  if (selected.source === "project" && options.hasPiSubagents === false) {
    return { kind: "warning", source: "project", chainName, reason: "pi-subagents does not appear to be installed or loaded for this session" };
  }

  try {
    const resolvedChain = resolveNamedChain(chainName, cwd, userHome);
    if (!resolvedChain) {
      if (selected.source === "project") return { kind: "warning", source: "project", chainName, reason: "configured chain was not found" };
      return { kind: "none" };
    }
    if (resolvedChain.steps.length === 0) {
      if (selected.source === "project") return { kind: "warning", source: "project", chainName, reason: "configured chain has no steps" };
      return { kind: "none" };
    }
    return { kind: "resolved", source: selected.source, chainName, steps: resolvedChain.steps, recipe: recipeForSteps(resolvedChain.steps) };
  } catch (error) {
    if (selected.source === "project") return { kind: "warning", source: "project", chainName, reason: error instanceof Error ? error.message : String(error) };
    return { kind: "none" };
  }
}
