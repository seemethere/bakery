import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const defaultOutputPath = join(root, "test-results", "iteration", "iteration-report.json");
const cliArgs = process.argv.slice(2);
const recommendMode = cliArgs.includes("--recommend");
const agentActionsMode = cliArgs.includes("--agent-actions");
const sessionContextMode = cliArgs.includes("--session-context");
const helpMode = cliArgs.includes("--help") || cliArgs.includes("-h");
const outputFlagIndex = cliArgs.findIndex((arg) => arg === "--output" || arg === "-o");
const sessionFlagIndex = cliArgs.findIndex((arg) => arg === "--session");
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

type AgentActionInsight = {
  area: string;
  confidence: "high" | "medium" | "missing-telemetry";
  evidence: string[];
  optimizeAgentBy: string[];
};

type SessionContextReport = {
  sessionPath?: string;
  sessionCwd?: string;
  lines: number;
  toolCallsByName: Record<string, number>;
  toolResultsByName: Record<string, { calls: number; chars: number; estimatedTokens: number; maxChars: number }>;
  toolInputsByName: Record<string, Array<{ input: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>>;
  repeatedToolInputs: Array<{ toolName: string; input: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  readPaths: Array<{ path: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  bashCommands: Array<{ command: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  largestToolResults: Array<{ toolName: string; chars: number; estimatedTokens: number; timestamp?: string; messageId?: string; input?: string }>;
  assistantResponsesWithUsage: number;
  latestUsage?: Record<string, unknown>;
  maxReportedInputOrCacheRead?: number;
  actionRecommendations: string[];
  notes: string[];
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
  sessionContext?: SessionContextReport;
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

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (typeof record.output === "string") return record.output;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncateOneLine(value: string, maxLength = 180): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolInputLabel(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "read" && typeof args.path === "string") {
    const suffix = [typeof args.offset === "number" ? `offset=${args.offset}` : undefined, typeof args.limit === "number" ? `limit=${args.limit}` : undefined]
      .filter(Boolean)
      .join(", ");
    return suffix ? `${args.path} (${suffix})` : args.path;
  }
  if (toolName === "bash" && typeof args.command === "string") return truncateOneLine(args.command);
  if ((toolName === "edit" || toolName === "write") && typeof args.path === "string") return args.path;
  if (toolName === "ask_question") {
    const title = typeof args.title === "string" ? args.title : undefined;
    const question = typeof args.question === "string" ? args.question : undefined;
    return truncateOneLine([title, question].filter(Boolean).join(" — ") || "question");
  }
  const entries = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "string" ? truncateOneLine(value, 80) : JSON.stringify(value)}`);
  return truncateOneLine(entries.join(", ") || "no arguments");
}

function incrementInputSummary(
  record: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>,
  key: string,
  resultChars: number,
): void {
  record[key] ??= { calls: 0, resultChars: 0, estimatedTokens: 0, maxResultChars: 0 };
  const summary = record[key];
  summary.calls += 1;
  summary.resultChars += resultChars;
  summary.estimatedTokens = estimateTokensFromChars(summary.resultChars);
  summary.maxResultChars = Math.max(summary.maxResultChars, resultChars);
}

function candidateSessionDirs(): string[] {
  const dirs = [process.env.PI_WEB_SESSION_DIR, join(homedir(), ".pi-web-agent", "sessions")].filter((dir): dir is string => Boolean(dir));
  return Array.from(new Set(dirs.map((dir) => resolve(expandHome(dir)))));
}

function readSessionCwd(path: string): string | undefined {
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    if (!firstLine) return undefined;
    const event = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof event.cwd === "string" ? event.cwd : undefined;
  } catch {
    return undefined;
  }
}

function findSessionLogPath(): string | undefined {
  const explicit = sessionFlagIndex >= 0 ? cliArgs[sessionFlagIndex + 1] : undefined;
  if (explicit) return resolve(expandHome(explicit));

  const candidates = candidateSessionDirs().flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => {
        const path = join(dir, entry);
        return { path, mtimeMs: statSync(path).mtimeMs, cwd: readSessionCwd(path) };
      });
  });
  const sorted = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted.find((candidate) => candidate.cwd === root)?.path ?? sorted[0]?.path;
}

function buildSessionContextReport(): SessionContextReport {
  const sessionPath = findSessionLogPath();
  const missingReport: SessionContextReport = {
    lines: 0,
    toolCallsByName: {},
    toolResultsByName: {},
    toolInputsByName: {},
    repeatedToolInputs: [],
    readPaths: [],
    bashCommands: [],
    largestToolResults: [],
    assistantResponsesWithUsage: 0,
    actionRecommendations: [],
    notes: ["No local pi session JSONL log found. Set PI_WEB_SESSION_DIR or pass --session <path> if the session lives elsewhere."],
  };
  if (!sessionPath || !existsSync(sessionPath)) return missingReport;

  const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
  const report: SessionContextReport = {
    sessionPath: relative(root, sessionPath).startsWith("..") ? sessionPath : relative(root, sessionPath),
    sessionCwd: undefined,
    lines: lines.length,
    toolCallsByName: {},
    toolResultsByName: {},
    toolInputsByName: {},
    repeatedToolInputs: [],
    readPaths: [],
    bashCommands: [],
    largestToolResults: [],
    assistantResponsesWithUsage: 0,
    actionRecommendations: [],
    notes: ["Tool-result sizes are character counts with a rough chars/4 token estimate; content is intentionally not printed."],
  };
  const toolCallsById: Record<string, { toolName: string; input: string; args: Record<string, unknown>; timestamp?: string }> = {};
  const toolInputs: Record<string, Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>> = {};
  const readPathSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};
  const bashCommandSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "session" && typeof event.cwd === "string") report.sessionCwd = event.cwd;
    if (event.type !== "message" || !event.message || typeof event.message !== "object") continue;

    const message = event.message as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    if (message.role === "assistant") {
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const record = part as Record<string, unknown>;
        if (record.type === "toolCall" && typeof record.name === "string") {
          increment(report.toolCallsByName, record.name);
          const id = typeof record.id === "string" ? record.id : undefined;
          if (id) {
            const args = parseToolArguments(record.arguments);
            toolCallsById[id] = {
              toolName: record.name,
              input: toolInputLabel(record.name, args),
              args,
              timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
            };
          }
        }
      }
      if (message.usage && typeof message.usage === "object") {
        report.assistantResponsesWithUsage += 1;
        report.latestUsage = message.usage as Record<string, unknown>;
        const usage = message.usage as Record<string, unknown>;
        for (const key of ["input", "cacheRead"] as const) {
          const value = usage[key];
          if (typeof value === "number") report.maxReportedInputOrCacheRead = Math.max(report.maxReportedInputOrCacheRead ?? 0, value);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const toolCall = toolCallId ? toolCallsById[toolCallId] : undefined;
      const input = toolCall?.input ?? "unknown input";
      const chars = textFromContent(message.content).length;
      report.toolResultsByName[toolName] ??= { calls: 0, chars: 0, estimatedTokens: 0, maxChars: 0 };
      const summary = report.toolResultsByName[toolName];
      summary.calls += 1;
      summary.chars += chars;
      summary.estimatedTokens = estimateTokensFromChars(summary.chars);
      summary.maxChars = Math.max(summary.maxChars, chars);

      toolInputs[toolName] ??= {};
      incrementInputSummary(toolInputs[toolName], input, chars);
      if (toolName === "read" && typeof toolCall?.args.path === "string") {
        incrementInputSummary(readPathSummaries, toolCall.args.path, chars);
      }
      if (toolName === "bash" && typeof toolCall?.args.command === "string") {
        incrementInputSummary(bashCommandSummaries, truncateOneLine(toolCall.args.command), chars);
      }

      report.largestToolResults.push({
        toolName,
        chars,
        estimatedTokens: estimateTokensFromChars(chars),
        timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
        messageId: typeof event.id === "string" ? event.id : undefined,
        input,
      });
    }
  }

  report.toolInputsByName = Object.fromEntries(
    Object.entries(toolInputs).map(([toolName, inputs]) => [
      toolName,
      Object.entries(inputs)
        .sort((a, b) => b[1].resultChars - a[1].resultChars)
        .slice(0, 10)
        .map(([input, summary]) => ({ input, ...summary })),
    ]),
  );
  report.repeatedToolInputs = Object.entries(toolInputs)
    .flatMap(([toolName, inputs]) => Object.entries(inputs).map(([input, summary]) => ({ toolName, input, ...summary })))
    .filter((item) => item.calls > 1)
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, 8);
  report.readPaths = Object.entries(readPathSummaries)
    .map(([path, summary]) => ({ path, ...summary }))
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, 8);
  report.bashCommands = Object.entries(bashCommandSummaries)
    .map(([command, summary]) => ({ command, ...summary }))
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, 8);
  report.largestToolResults.sort((a, b) => b.chars - a.chars);
  report.largestToolResults = report.largestToolResults.slice(0, 8);

  const repeatedReadPaths = report.readPaths.filter((item) => item.calls > 1);
  if (repeatedReadPaths.length > 0) {
    const top = repeatedReadPaths[0];
    report.actionRecommendations.push(
      `Repeated reads: ${top.path} was read ${top.calls} times for ${top.resultChars.toLocaleString()} result chars; prefer targeted offsets/limits or reuse earlier context when possible.`,
    );
  }
  const largestResult = report.largestToolResults[0];
  if (largestResult && largestResult.chars >= 20_000) {
    report.actionRecommendations.push(
      `Large result: ${largestResult.toolName}${largestResult.input ? ` (${largestResult.input})` : ""} returned ${largestResult.chars.toLocaleString()} chars; use narrower reads/commands before pulling broad artifacts into context.`,
    );
  }
  const repeatedBash = report.bashCommands.filter((item) => item.calls > 1);
  if (repeatedBash.length > 0) {
    const top = repeatedBash[0];
    report.actionRecommendations.push(`Repeated bash command: \`${top.command}\` ran ${top.calls} times; consider saving/using its previous result or narrowing validation reruns.`);
  }
  if (report.actionRecommendations.length === 0) {
    report.actionRecommendations.push("No repeated high-cost tool pattern detected in this session; continue using targeted reads and focused validation selection.");
  }
  return report;
}

function printSessionContextReport(report: SessionContextReport): void {
  console.log("\n## Session context estimate");
  if (!report.sessionPath) {
    report.notes.forEach((note) => console.log(`- ${note}`));
    return;
  }
  console.log(`Session log: ${report.sessionPath}`);
  if (report.sessionCwd) console.log(`Session cwd: ${report.sessionCwd}`);
  console.log(`JSONL lines: ${report.lines}`);
  console.log("\nTool calls requested:");
  const toolCalls = Object.entries(report.toolCallsByName).sort((a, b) => b[1] - a[1]);
  if (toolCalls.length === 0) console.log("- none found");
  toolCalls.forEach(([tool, count]) => console.log(`- ${tool}: ${count}`));
  console.log("\nTool result payloads:");
  const toolResults = Object.entries(report.toolResultsByName).sort((a, b) => b[1].chars - a[1].chars);
  if (toolResults.length === 0) console.log("- none found");
  toolResults.forEach(([tool, summary]) => {
    console.log(`- ${tool}: ${summary.calls} calls, ${summary.chars.toLocaleString()} chars (~${summary.estimatedTokens.toLocaleString()} tokens), largest ${summary.maxChars.toLocaleString()} chars`);
  });
  console.log("\nTop read paths:");
  if (report.readPaths.length === 0) console.log("- none found");
  report.readPaths.forEach((item) => {
    console.log(`- ${item.path}: ${item.calls} reads, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens), largest ${item.maxResultChars.toLocaleString()} chars`);
  });
  console.log("\nTop bash commands:");
  if (report.bashCommands.length === 0) console.log("- none found");
  report.bashCommands.forEach((item) => {
    console.log(`- ${item.command}: ${item.calls} runs, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens), largest ${item.maxResultChars.toLocaleString()} chars`);
  });
  console.log("\nRepeated tool inputs:");
  if (report.repeatedToolInputs.length === 0) console.log("- none found");
  report.repeatedToolInputs.forEach((item) => {
    console.log(`- ${item.toolName} ${item.input}: ${item.calls} calls, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)`);
  });
  console.log("\nLargest tool results:");
  if (report.largestToolResults.length === 0) console.log("- none found");
  report.largestToolResults.forEach((item) => {
    const suffix = [item.input, item.timestamp, item.messageId].filter(Boolean).join(" · ");
    console.log(`- ${item.toolName}: ${item.chars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)${suffix ? ` · ${suffix}` : ""}`);
  });
  console.log("\nModel usage:");
  console.log(`- assistant responses with usage: ${report.assistantResponsesWithUsage}`);
  if (report.latestUsage) console.log(`- latest usage: ${JSON.stringify(report.latestUsage)}`);
  if (typeof report.maxReportedInputOrCacheRead === "number") console.log(`- max reported input/cacheRead: ${report.maxReportedInputOrCacheRead.toLocaleString()} tokens`);
  console.log("\nAction recommendations:");
  report.actionRecommendations.forEach((item) => console.log(`- ${item}`));
  console.log("\nNotes:");
  report.notes.forEach((note) => console.log(`- ${note}`));
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
    matches: ["scripts/report-iteration.ts", "scripts/project-notes.ts"],
    commands: ["bun run report:iteration", "bun run project:notes", "bun run check"],
    reason: "Iteration/project-notes reporting changes are script-only and can usually avoid browser harness runs.",
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
    scenarios: ["mobile-layout", "theme-gallery", "themes", "tool-grouping", "question-answer"],
    reason: "Theme/CSS changes are fastest to validate through the mobile layout check, gallery, and focused component screenshots.",
  },
  {
    name: "harness",
    matches: ["scripts/ui-harness.ts"],
    scenarios: ["mobile-layout", "slash-commands", "question-answer", "streaming-responsiveness"],
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

function fullSuiteDecision(recommendation: ValidationRecommendation): string {
  const recommendsFullSuite = recommendation.commands.includes("bun run test:web-perf") || recommendation.optionalCommands.includes("bun run test:web-perf");
  if (recommendsFullSuite) {
    return "Run `bun run test:web-perf` after the focused commands if the touched behavior is broad, protocol/session-lifecycle related, or focused validation fails.";
  }
  return "Full `bun run test:web-perf` not recommended by the selector for these files; skip it unless focused validation fails or the change proves broader than expected.";
}

function printValidationDecisionBlock(recommendation: ValidationRecommendation): void {
  console.log("\n## Validation decision");
  if (recommendation.files.length === 0) {
    console.log("Files: none provided/detected");
    console.log("Commands:");
    console.log("1. bun run check");
    console.log("Full suite: not selected; rerun with `bun run report:iteration --recommend <changed files>` once files are known.");
    return;
  }
  console.log(`Files: ${recommendation.files.join(", ")}`);
  console.log("Commands:");
  recommendation.commands.forEach((command, index) => console.log(`${index + 1}. ${command}`));
  if (recommendation.optionalCommands.length > 0) {
    console.log("Optional / escalation:");
    recommendation.optionalCommands.forEach((command) => console.log(`- ${command}`));
  }
  console.log(`Full suite: ${fullSuiteDecision(recommendation)}`);
}

function printValidationRecommendation(recommendation: ValidationRecommendation): void {
  console.log("\nSuggested validation:");
  if (recommendation.files.length === 0) {
    console.log("No changed files were provided or detected; run `bun run check` first.");
    printValidationDecisionBlock(recommendation);
    return;
  }
  recommendation.commands.forEach((command, index) => console.log(`${index + 1}. ${command}`));
  if (recommendation.optionalCommands.length > 0) {
    console.log("\nOptional / escalation:");
    recommendation.optionalCommands.forEach((command) => console.log(`- ${command}`));
  }
  console.log("\nWhy:");
  recommendation.reasons.forEach((reason) => console.log(`- ${reason}`));
  printValidationDecisionBlock(recommendation);
}

function topEntries(record: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function buildAgentActionInsights(report: IterationReport): AgentActionInsight[] {
  const fullHarnessRuns = report.validation.harnessRuns.filter((run) => run.scenario === "all" || run.scenarioCount > 10).length;
  const focusedRuns = report.validation.harnessRuns.length - fullHarnessRuns;
  const commandMentions = report.validation.projectLogCommandMentions;
  const topScenarios = topEntries(report.validation.scenarioFrequency, 6).map(([scenario, count]) => `${scenario} (${count})`);
  const topFiles = report.git.topChangedFiles.slice(0, 6).map((file) => `${file.path} (${file.changes} changed lines)`);

  return [
    {
      area: "Validation action selection",
      confidence: "high",
      evidence: [
        `${fullHarnessRuns} recent full/all harness runs vs ${focusedRuns} focused harness runs in collected metrics.`,
        `PROJECT_LOG command mentions: bun run check=${commandMentions["bun run check"] ?? 0}, bun scripts/ui-harness.ts=${commandMentions["bun scripts/ui-harness.ts"] ?? 0}, bun run test:web-perf=${commandMentions["bun run test:web-perf"] ?? 0}.`,
      ],
      optimizeAgentBy: [
        "Run `bun run report:iteration --recommend <changed files>` before choosing validation commands.",
        "Prefer focused harness scenarios first; escalate to `bun run test:web-perf` for protocol/shared WebSocket changes, broad UI interaction changes, lifecycle/restart changes, or unexpected focused failures.",
        "Include the selector output in handoffs so future agents can tune bad recommendations.",
      ],
    },
    {
      area: "High-churn edit surfaces",
      confidence: "high",
      evidence: topFiles,
      optimizeAgentBy: [
        "Before editing high-churn files, search for the smallest existing function/CSS section and patch that island rather than rewriting broad regions.",
        "When touching `apps/web/src/main.ts` or `apps/web/src/styles.css`, consider whether a small helper/module/style section extraction would reduce future edit blast radius.",
        "Use focused harness scenarios tied to the touched surface instead of assuming the full suite is the first validation step.",
      ],
    },
    {
      area: "Recurring UX/harness loops",
      confidence: "medium",
      evidence: [`Most frequent focused scenarios: ${topScenarios.join(", ") || "none collected"}.`],
      optimizeAgentBy: [
        "Treat high-frequency scenarios as hot paths: keep scenario names in final handoffs and prefer extending existing scenarios over adding human-only validation.",
        "When a change lands near one of these hot paths, run the specific scenario early to catch regressions before broad cleanup or polish.",
      ],
    },
    {
      area: "Missing per-tool action telemetry",
      confidence: "missing-telemetry",
      evidence: [
        "Current local artifacts do not include structured counts for agent `read`, `bash`, `edit`, `ask_question`, failed edit attempts, or phase durations.",
        "Available evidence comes from git churn, PROJECT_LOG command mentions, and UI harness artifacts, not raw agent tool-call traces.",
      ],
      optimizeAgentBy: [
        "Add future session-level action summaries if we want to optimize specific tool calls, e.g. reads per file, bash commands, edit failures, validation reruns, and time by phase.",
        "Until then, optimize the high-confidence behaviors visible in existing telemetry: validation selection, high-churn edit surfaces, and hot-path harness loops.",
      ],
    },
  ];
}

function printAgentActionInsights(report: IterationReport, recommendation?: ValidationRecommendation): void {
  console.log("\n## Agent action insights");
  for (const insight of buildAgentActionInsights(report)) {
    console.log(`\n### ${insight.area} (${insight.confidence})`);
    console.log("Evidence:");
    insight.evidence.forEach((item) => console.log(`- ${item}`));
    console.log("Optimize agents by:");
    insight.optimizeAgentBy.forEach((item) => console.log(`- ${item}`));
  }
  if (recommendation && recommendation.files.length > 0) {
    console.log("\n### Immediate validation for current files");
    recommendation.commands.forEach((command, index) => console.log(`${index + 1}. ${command}`));
    if (recommendation.optionalCommands.length > 0) {
      console.log("Optional / escalation:");
      recommendation.optionalCommands.forEach((command) => console.log(`- ${command}`));
    }
  }
  console.log("\nNext instrumentation if this is not enough: record per-session action summaries for tool-call counts, failed edit attempts, validation reruns, and phase timing.");
}

function printHelp(): void {
  console.log(`Usage:
  bun run report:iteration
  bun run report:iteration --output test-results/iteration/report.json
  bun run report:iteration --recommend <changed files...>
  bun run report:iteration --agent-actions [--recommend <changed files...>]
  bun run report:iteration --session-context [--session ~/.pi-web-agent/sessions/session.jsonl]

When --recommend is passed without files, changed files are read from git status. Session-context mode reads local pi JSONL logs and reports counts/sizes without printing tool content.`);
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

const sessionContext = sessionContextMode ? buildSessionContextReport() : undefined;
const report: IterationReport = { ...baseReport, candidates: buildCandidates(baseReport), ...(sessionContext ? { sessionContext } : {}) };
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Wrote ${relative(root, outputPath)}`);
console.log(`Analyzed ${report.git.commitsAnalyzed} commits and ${report.validation.harnessRuns.length} harness metric artifacts.`);
console.log(`Top candidate: ${report.candidates[0]?.area ?? "none"}`);

const recommendation = recommendMode ? buildValidationRecommendation(recommendationFilesFromArgs(cliArgs)) : undefined;

if (recommendation) {
  printValidationRecommendation(recommendation);
}

if (agentActionsMode) {
  printAgentActionInsights(report, recommendation);
}

if (sessionContext) {
  printSessionContextReport(sessionContext);
}
