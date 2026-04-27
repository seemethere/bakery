import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const defaultOutputPath = join(root, "test-results", "iteration", "iteration-report.json");
const cliArgs = process.argv.slice(2);
const recommendMode = cliArgs.includes("--recommend");
const helpMode = cliArgs.includes("--help") || cliArgs.includes("-h");
const outputFlagIndex = cliArgs.findIndex((arg) => arg === "--output" || arg === "-o");
const positionalOutput = !recommendMode && cliArgs[0] && !cliArgs[0].startsWith("-") ? cliArgs[0] : undefined;
const outputPath = resolve(root, outputFlagIndex >= 0 ? cliArgs[outputFlagIndex + 1] ?? defaultOutputPath : positionalOutput ?? defaultOutputPath);
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

type ValidationRecommendation = {
  files: string[];
  commands: string[];
  optionalCommands: string[];
  scenarios: string[];
  reasons: string[];
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

type ValidationRule = {
  name: string;
  matches: Array<string | RegExp>;
  scenarios?: string[];
  commands?: string[];
  optionalCommands?: string[];
  reason: string;
};

const validationRules: ValidationRule[] = [
  {
    name: "root-checks",
    matches: ["package.json", "bun.lock", "tsconfig", "scripts/assert-workflow-skills.ts"],
    commands: ["bun run check"],
    reason: "Root/package/typecheck changes should at least run the repository check pipeline.",
  },
  {
    name: "iteration-reporting",
    matches: ["scripts/report-iteration.ts"],
    commands: ["bun run report:iteration", "bun run check"],
    reason: "Iteration-reporting changes are script-only and can usually avoid browser harness runs.",
  },
  {
    name: "project-notes",
    matches: ["PROJECT_LOG.md", "AGENTS.md", "DESIGN.md", /^docs\//],
    commands: ["bun run check"],
    reason: "Project-note/documentation edits normally need the static check only unless they change product behavior.",
  },
  {
    name: "workflow-skills",
    matches: ["apps/server/src/workflow-skills.ts", "scripts/assert-workflow-skills.ts"],
    scenarios: ["slash-commands"],
    reason: "Workflow skill launchers surface through slash-command metadata and transcript/sidebar compaction.",
  },
  {
    name: "protocol",
    matches: ["packages/protocol/src/", "packages/protocol/package.json"],
    optionalCommands: ["bun run test:web-perf"],
    reason: "Shared protocol changes can affect both HTTP/WebSocket boundaries and browser rendering, so consider the full fake-agent suite after focused checks.",
  },
  {
    name: "server-session-lifecycle",
    matches: ["apps/server/src/index.ts", "apps/server/src/pi-runner.ts"],
    scenarios: ["reconnect-controller", "controller-handoff-edges", "backend-restart", "slash-commands"],
    reason: "Server runner/session-hub changes often affect WebSocket lifecycle, controller state, slash commands, and restart behavior.",
  },
  {
    name: "fake-runner",
    matches: ["apps/server/src/fake-runner.ts"],
    scenarios: ["streaming-responsiveness", "narrow-tool-stream", "question-answer", "slash-commands"],
    reason: "Fake-agent changes should validate the deterministic scenarios whose synthetic events may have changed.",
  },
  {
    name: "web-main-core",
    matches: ["apps/web/src/main.ts"],
    scenarios: ["streaming-responsiveness", "slash-commands", "question-answer", "inspector-preview", "transcript-scroll-stability"],
    optionalCommands: ["bun run test:web-perf"],
    reason: "The main web component is high-churn and cross-cutting; start with the nearest focused UI scenarios, then use the full suite if multiple interaction paths changed.",
  },
  {
    name: "web-theme",
    matches: ["apps/web/src/styles.css"],
    scenarios: ["theme-gallery", "themes", "tool-grouping", "question-answer"],
    reason: "Theme/CSS changes are fastest to validate through the gallery plus focused component screenshots.",
  },
  {
    name: "harness",
    matches: ["scripts/ui-harness.ts"],
    scenarios: ["slash-commands", "question-answer", "streaming-responsiveness"],
    optionalCommands: ["bun run test:web-perf"],
    reason: "Harness changes need at least one focused scenario to prove the runner still works; run the full suite when scenario orchestration changed broadly.",
  },
];

function normalizeRepoPath(path: string): string {
  const withoutStatus = path.replace(/^\s*(?:[MADRCU?!]{1,2}\s+)?/, "").trim();
  const renamed = withoutStatus.includes(" -> ") ? withoutStatus.split(" -> ").at(-1) ?? withoutStatus : withoutStatus;
  return relative(root, resolve(root, renamed)).replace(/\\/g, "/");
}

function matchesRule(file: string, matcher: string | RegExp): boolean {
  if (typeof matcher === "string") return file === matcher || file.startsWith(matcher);
  return matcher.test(file);
}

function readChangedFilesFromGit(): string[] {
  const raw = run("git", ["status", "--porcelain"]);
  return Array.from(new Set(raw.split("\n").map((line) => normalizeRepoPath(line.slice(3))).filter(Boolean)));
}

function recommendationFilesFromArgs(args: string[]): string[] {
  const recommendIndex = args.indexOf("--recommend");
  if (recommendIndex < 0) return [];
  const files: string[] = [];
  for (let index = recommendIndex + 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--output" || arg === "-o") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    files.push(normalizeRepoPath(arg));
  }
  return files.length > 0 ? Array.from(new Set(files)) : readChangedFilesFromGit();
}

function uniquePush(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function buildValidationRecommendation(files: string[]): ValidationRecommendation {
  const commands: string[] = [];
  const optionalCommands: string[] = [];
  const scenarios: string[] = [];
  const reasons: string[] = [];
  uniquePush(commands, "bun run check");

  for (const file of files) {
    const matchedRules = validationRules.filter((rule) => rule.matches.some((matcher) => matchesRule(file, matcher)));
    if (matchedRules.length === 0) {
      uniquePush(reasons, `${file}: no specific rule matched; defaulting to static checks.`);
      continue;
    }
    for (const rule of matchedRules) {
      uniquePush(reasons, `${file}: ${rule.reason}`);
      for (const command of rule.commands ?? []) uniquePush(commands, command);
      for (const scenario of rule.scenarios ?? []) uniquePush(scenarios, scenario);
      for (const command of rule.optionalCommands ?? []) uniquePush(optionalCommands, command);
    }
  }

  for (const scenario of scenarios.slice(0, 6)) {
    uniquePush(commands, `bun scripts/ui-harness.ts --scenario ${scenario}`);
  }
  if (scenarios.length > 6) {
    uniquePush(optionalCommands, `Additional focused scenarios to consider: ${scenarios.slice(6).join(", ")}`);
  }

  return { files, commands, optionalCommands, scenarios, reasons };
}

function printValidationRecommendation(recommendation: ValidationRecommendation): void {
  console.log("\nSuggested validation:");
  if (recommendation.files.length === 0) {
    console.log("No changed files were provided or detected; run `bun run check` first.");
    return;
  }
  recommendation.commands.forEach((command, index) => console.log(`${index + 1}. ${command}`));
  if (recommendation.optionalCommands.length > 0) {
    console.log("\nOptional / escalation:");
    recommendation.optionalCommands.forEach((command) => console.log(`- ${command}`));
  }
  console.log("\nWhy:");
  recommendation.reasons.forEach((reason) => console.log(`- ${reason}`));
}

function printHelp(): void {
  console.log(`Usage:
  bun run report:iteration
  bun run report:iteration --output test-results/iteration/report.json
  bun run report:iteration --recommend <changed files...>

When --recommend is passed without files, changed files are read from git status.`);
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

if (helpMode) {
  printHelp();
  process.exit(0);
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

if (recommendMode) {
  printValidationRecommendation(buildValidationRecommendation(recommendationFilesFromArgs(cliArgs)));
}
