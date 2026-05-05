import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type LatestHarnessArtifact = {
  scenario: string;
  artifactDir: string;
  absoluteArtifactDir: string;
  failed: boolean;
  failureSummary?: string;
  generatedAt?: string;
  latestMtimeMs: number;
  debugFiles: string[];
  screenshots: string[];
  availableScenarios: string[];
};

export type LatestHarnessArtifactResult =
  | { found: true; artifact: LatestHarnessArtifact }
  | { found: false; scenario?: string; harnessRoot: string; availableScenarios: string[]; reason: string };

type MetricsJson = { scenario?: unknown; scenarios?: unknown; metrics?: unknown };

const debugFileNames = ["failure.txt", "server.log", "web.log", "console.log", "trace.zip"];

export function normalizeHarnessScenario(input?: string): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  const commandMatch = trimmed.match(/(?:^|\s)--scenario(?:=|\s+)([^\s]+)/);
  const raw = commandMatch?.[1] ?? trimmed.replace(/^ui-harness:/, "");
  return raw.replace(/^['"]|['"]$/g, "");
}

export function pathTimestamp(path: string): string | undefined {
  return path.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/)?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function scenarioFromDirName(name: string): string {
  return name.replace(/-\d{4}-.*$/, "") || "unknown";
}

function newestMtimeMs(dir: string): number {
  let newest = statSync(dir).mtimeMs;
  for (const entry of readdirSync(dir)) {
    try {
      newest = Math.max(newest, statSync(join(dir, entry)).mtimeMs);
    } catch {
      // Ignore files deleted between readdir/stat.
    }
  }
  return newest;
}

function scenarioNamesForArtifact(artifactDir: string): string[] {
  const dirScenario = scenarioFromDirName(artifactDir.split(/[\\/]/).pop() ?? "unknown");
  const metrics = readJson(join(artifactDir, "metrics.json")) as MetricsJson | null;
  const names = new Set<string>();
  if (metrics && typeof metrics === "object") {
    if (typeof metrics.scenario === "string" && metrics.scenario.trim()) names.add(metrics.scenario.trim());
    if (Array.isArray(metrics.scenarios)) {
      for (const item of metrics.scenarios) if (typeof item === "string" && item.trim()) names.add(item.trim());
    }
    if (metrics.metrics && typeof metrics.metrics === "object" && !Array.isArray(metrics.metrics)) {
      for (const key of Object.keys(metrics.metrics)) if (key.trim()) names.add(key.trim());
    }
  }
  names.add(dirScenario);
  return Array.from(names);
}

export function findLatestHarnessArtifact(options: { root: string; scenario?: string; harnessRoot?: string }): LatestHarnessArtifactResult {
  const harnessRoot = options.harnessRoot ?? join(options.root, "test-results", "ui-harness");
  const scenario = normalizeHarnessScenario(options.scenario);
  if (!existsSync(harnessRoot)) {
    return { found: false, scenario, harnessRoot, availableScenarios: [], reason: "artifact root does not exist" };
  }

  const candidates: LatestHarnessArtifact[] = [];
  const availableScenarios = new Set<string>();
  for (const entry of readdirSync(harnessRoot)) {
    const absoluteArtifactDir = join(harnessRoot, entry);
    let stat;
    try {
      stat = statSync(absoluteArtifactDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const names = scenarioNamesForArtifact(absoluteArtifactDir);
    names.forEach((name) => availableScenarios.add(name));
    if (scenario && !names.includes(scenario)) continue;
    const artifactDir = relative(options.root, absoluteArtifactDir);
    const failurePath = join(absoluteArtifactDir, "failure.txt");
    const failed = existsSync(failurePath);
    const failureSummary = failed ? readFileSync(failurePath, "utf8").split("\n").find((line) => line.trim())?.slice(0, 240) : undefined;
    const debugFiles = debugFileNames.filter((name) => existsSync(join(absoluteArtifactDir, name))).map((name) => join(artifactDir, name));
    const screenshots = readdirSync(absoluteArtifactDir)
      .filter((name) => name.endsWith(".png") && name !== "fixture.png")
      .sort()
      .map((name) => join(artifactDir, name));
    candidates.push({
      scenario: scenario ?? names[0] ?? "unknown",
      artifactDir,
      absoluteArtifactDir,
      failed,
      failureSummary,
      generatedAt: pathTimestamp(absoluteArtifactDir),
      latestMtimeMs: newestMtimeMs(absoluteArtifactDir),
      debugFiles,
      screenshots,
      availableScenarios: names,
    });
  }

  candidates.sort((a, b) => {
    const aGeneratedMs = a.generatedAt ? Date.parse(a.generatedAt) : 0;
    const bGeneratedMs = b.generatedAt ? Date.parse(b.generatedAt) : 0;
    return bGeneratedMs - aGeneratedMs || b.latestMtimeMs - a.latestMtimeMs;
  });
  const artifact = candidates[0];
  if (!artifact) {
    return {
      found: false,
      scenario,
      harnessRoot,
      availableScenarios: Array.from(availableScenarios).sort(),
      reason: scenario ? `no artifacts found for scenario ${scenario}` : "no artifact directories found",
    };
  }
  return { found: true, artifact };
}

export function formatLatestHarnessArtifactResult(result: LatestHarnessArtifactResult): string {
  if (!result.found) {
    const lines = [`No harness artifact found${result.scenario ? ` for ${result.scenario}` : ""}: ${result.reason}.`, `Artifact root: ${result.harnessRoot}`];
    if (result.availableScenarios.length > 0) lines.push(`Available scenarios: ${result.availableScenarios.slice(0, 12).join(", ")}`);
    return lines.join("\n");
  }
  const item = result.artifact;
  const status = item.failed ? "failed" : "completed/unknown";
  const lines = [
    `Latest artifact: ${item.artifactDir}`,
    `Scenario: ${item.scenario}${item.availableScenarios.length > 1 ? ` (also: ${item.availableScenarios.filter((name) => name !== item.scenario).join(", ")})` : ""}`,
    `Status: ${status}`,
  ];
  if (item.generatedAt) lines.push(`Generated: ${item.generatedAt}`);
  if (item.failureSummary) lines.push(`Failure: ${item.failureSummary}`);
  const failureFile = item.debugFiles.find((path) => path.endsWith("failure.txt"));
  if (failureFile) lines.push(`Inspect failure: sed -n '1,160p' ${failureFile}`);
  const logFiles = item.debugFiles.filter((path) => /(?:server|web|console)\.log$/.test(path));
  if (logFiles.length > 0) lines.push(`Inspect logs: ${logFiles.map((path) => `tail -n 120 ${path}`).join(" && ")}`);
  const trace = item.debugFiles.find((path) => path.endsWith("trace.zip"));
  if (trace) lines.push(`Trace: ${trace}`);
  if (item.screenshots.length > 0) lines.push(`Screenshots: ${item.screenshots.slice(0, 6).join(", ")}`);
  lines.push(item.failed ? "Next step: inspect the artifact, patch one cause, then rerun only this focused scenario." : "Next step: use this artifact for handoff or rerun only if the scenario behavior changed.");
  return lines.join("\n");
}
