import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const defaultOutputPath = join(root, "test-results", "iteration", "iteration-report.json");
const outputPath = resolve(root, process.argv[2] ?? defaultOutputPath);
const maxCommits = Number(process.env.PI_WEB_ITERATION_COMMITS ?? 40);
const maxHarnessRuns = Number(process.env.PI_WEB_ITERATION_HARNESS_RUNS ?? 80);

type GitCommit = {
  hash: string;
  subject: string;
  type?: string;
  timestamp: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

type HarnessRun = {
  scenario: string;
  artifactDir: string;
  scenarioCount: number;
  failed: boolean;
  failureSummary?: string;
  metricsBytes?: number;
  generatedAtFromPath?: string;
};

type IterationReport = {
  generatedAt: string;
  source: {
    root: string;
    projectLog: string;
    harnessRoot: string;
    outputPath: string;
  };
  git: {
    commitsAnalyzed: number;
    commits: GitCommit[];
    commitTypeFrequency: Record<string, number>;
    topChangedFiles: Array<{ path: string; changes: number }>;
  };
  validation: {
    projectLogCommandMentions: Record<string, number>;
    latestVerificationLines: string[];
    harnessRuns: HarnessRun[];
    scenarioFrequency: Record<string, number>;
    failedRuns: number;
  };
  candidates: Array<{
    area: string;
    evidence: string[];
    suggestedAction: string;
  }>;
};

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trimEnd();
}

function increment(record: Record<string, number>, key: string, amount = 1): void {
  record[key] = (record[key] ?? 0) + amount;
}

function parseCommitType(subject: string): string | undefined {
  return subject.match(/^([a-z]+)(?:\([^)]+\))?!?:/)?.[1];
}

function readGitCommits(): { commits: GitCommit[]; typeFrequency: Record<string, number>; topChangedFiles: Array<{ path: string; changes: number }> } {
  const raw = run("git", ["log", `-${maxCommits}`, "--date=iso-strict", "--pretty=format:@@COMMIT@@%H%x09%ad%x09%s", "--numstat"]);
  const typeFrequency: Record<string, number> = {};
  const fileChanges: Record<string, number> = {};
  const commits: GitCommit[] = [];
  let current: GitCommit | undefined;

  for (const line of raw.split("\n")) {
    if (line.startsWith("@@COMMIT@@")) {
      const [hash = "", timestamp = "", subject = ""] = line.slice("@@COMMIT@@".length).split("\t");
      current = { hash, timestamp, subject, type: parseCommitType(subject), filesChanged: 0, insertions: 0, deletions: 0 };
      commits.push(current);
      increment(typeFrequency, current.type ?? "untyped");
      continue;
    }
    if (!current || !line.trim()) continue;
    const [added, removed, path] = line.split("\t");
    if (!path) continue;
    const insertions = added === "-" ? 0 : Number(added) || 0;
    const deletions = removed === "-" ? 0 : Number(removed) || 0;
    current.filesChanged += 1;
    current.insertions += insertions;
    current.deletions += deletions;
    increment(fileChanges, path, insertions + deletions || 1);
  }

  const topChangedFiles = Object.entries(fileChanges)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, changes]) => ({ path, changes }));

  return { commits, typeFrequency, topChangedFiles };
}

function walkFiles(dir: string, fileName: string, limit: number): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        stack.push(path);
      } else if (entry === fileName) {
        results.push(path);
        if (results.length >= limit) break;
      }
    }
  }
  return results.sort();
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pathTimestamp(path: string): string | undefined {
  return path.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/)?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

function readHarnessRuns(): { runs: HarnessRun[]; scenarioFrequency: Record<string, number>; failedRuns: number } {
  const harnessRoot = join(root, "test-results", "ui-harness");
  const metricFiles = walkFiles(harnessRoot, "metrics.json", maxHarnessRuns * 2);
  const runs = metricFiles
    .map((path): HarnessRun | null => {
      const json = readJson(path) as { scenario?: unknown; scenarios?: unknown; metrics?: unknown } | null;
      if (!json || typeof json !== "object") return null;
      const artifactDir = dirname(path);
      const scenario = typeof json.scenario === "string" ? json.scenario : artifactDir.split(/[\\/]/).pop()?.replace(/-\d{4}-.*$/, "") ?? "unknown";
      const scenarios = Array.isArray(json.scenarios) ? json.scenarios.filter((item): item is string => typeof item === "string") : [];
      const failurePath = join(artifactDir, "failure.txt");
      const failed = existsSync(failurePath);
      const failureSummary = failed ? readFileSync(failurePath, "utf8").split("\n").find((line) => line.trim())?.slice(0, 240) : undefined;
      return {
        scenario,
        artifactDir: relative(root, artifactDir),
        scenarioCount: scenarios.length || (json.metrics && typeof json.metrics === "object" ? Object.keys(json.metrics).length : 1),
        failed,
        failureSummary,
        metricsBytes: statSync(path).size,
        generatedAtFromPath: pathTimestamp(path),
      };
    })
    .filter((run): run is HarnessRun => Boolean(run))
    .sort((a, b) => (b.generatedAtFromPath ?? "").localeCompare(a.generatedAtFromPath ?? ""))
    .slice(0, maxHarnessRuns);

  const scenarioFrequency: Record<string, number> = {};
  for (const run of runs) {
    const metricsPath = join(root, run.artifactDir, "metrics.json");
    const json = readJson(metricsPath) as { scenarios?: unknown; metrics?: unknown } | null;
    const scenarioNames = Array.isArray(json?.scenarios)
      ? json.scenarios.filter((item): item is string => typeof item === "string")
      : json?.metrics && typeof json.metrics === "object"
        ? Object.keys(json.metrics)
        : [run.scenario];
    for (const scenario of scenarioNames) increment(scenarioFrequency, scenario);
  }

  return { runs, scenarioFrequency, failedRuns: runs.filter((run) => run.failed).length };
}

function readProjectLogSignals(): { commandMentions: Record<string, number>; latestVerificationLines: string[] } {
  const path = join(root, "PROJECT_LOG.md");
  if (!existsSync(path)) return { commandMentions: {}, latestVerificationLines: [] };
  const text = readFileSync(path, "utf8");
  const commands = [
    "bun run check",
    "bun run test:web-perf",
    "bun scripts/ui-harness.ts",
    "bun run ui:manual",
    "dev:server",
    "dev:web",
  ];
  const commandMentions: Record<string, number> = {};
  for (const command of commands) {
    commandMentions[command] = (text.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  }
  const verificationIndex = text.indexOf("## Verification");
  const nextIndex = verificationIndex >= 0 ? text.indexOf("## ", verificationIndex + 1) : -1;
  const verificationText = verificationIndex >= 0 ? text.slice(verificationIndex, nextIndex >= 0 ? nextIndex : undefined) : "";
  const latestVerificationLines = verificationText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Latest:") || line.startsWith("Previous latest:") || line.startsWith("bun "))
    .slice(0, 20);
  return { commandMentions, latestVerificationLines };
}

function buildCandidates(report: Omit<IterationReport, "candidates">): IterationReport["candidates"] {
  const candidates: IterationReport["candidates"] = [];
  const fullHarnessRuns = report.validation.harnessRuns.filter((run) => run.scenario === "all" || run.scenarioCount > 10).length;
  const focusedRuns = report.validation.harnessRuns.length - fullHarnessRuns;
  candidates.push({
    area: "Validation selection",
    evidence: [
      `${fullHarnessRuns} recent full/all harness runs vs ${focusedRuns} focused runs in collected metrics.`,
      `PROJECT_LOG mentions bun run test:web-perf ${report.validation.projectLogCommandMentions["bun run test:web-perf"] ?? 0} times.`,
    ],
    suggestedAction: "Use this report to identify high-signal focused scenarios per file/feature area before running the full harness by default.",
  });
  if (report.validation.failedRuns > 0) {
    candidates.push({
      area: "Failure/retry loop",
      evidence: [`${report.validation.failedRuns} collected harness runs include failure.txt artifacts.`],
      suggestedAction: "Summarize recurring failure scenarios and promote flaky waits or deterministic setup fixes ahead of new UX polish.",
    });
  }
  candidates.push({
    area: "High-churn implementation surfaces",
    evidence: report.git.topChangedFiles.slice(0, 5).map((file) => `${file.path}: ${file.changes} changed lines`),
    suggestedAction: "Add narrower checks or module boundaries around the highest-churn files if they keep dominating iteration slices.",
  });
  return candidates;
}

const git = readGitCommits();
const validation = readProjectLogSignals();
const harness = readHarnessRuns();

const baseReport = {
  generatedAt: new Date().toISOString(),
  source: {
    root,
    projectLog: relative(root, join(root, "PROJECT_LOG.md")),
    harnessRoot: relative(root, join(root, "test-results", "ui-harness")),
    outputPath: relative(root, outputPath),
  },
  git: {
    commitsAnalyzed: git.commits.length,
    commits: git.commits,
    commitTypeFrequency: git.typeFrequency,
    topChangedFiles: git.topChangedFiles,
  },
  validation: {
    projectLogCommandMentions: validation.commandMentions,
    latestVerificationLines: validation.latestVerificationLines,
    harnessRuns: harness.runs,
    scenarioFrequency: harness.scenarioFrequency,
    failedRuns: harness.failedRuns,
  },
} satisfies Omit<IterationReport, "candidates">;

const report: IterationReport = { ...baseReport, candidates: buildCandidates(baseReport) };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Wrote ${relative(root, outputPath)}`);
console.log(`Analyzed ${report.git.commitsAnalyzed} commits and ${report.validation.harnessRuns.length} harness metric artifacts.`);
console.log(`Top candidate: ${report.candidates[0]?.area ?? "none"}`);
