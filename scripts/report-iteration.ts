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
const sessionHistoryMode = cliArgs.includes("--session-history") || cliArgs.includes("--all-sessions");
const helpMode = cliArgs.includes("--help") || cliArgs.includes("-h");
const outputFlagIndex = cliArgs.findIndex((arg) => arg === "--output" || arg === "-o");
const sessionFlagIndex = cliArgs.findIndex((arg) => arg === "--session");
const positionalOutput = !recommendMode && cliArgs[0] && !cliArgs[0].startsWith("-") ? cliArgs[0] : undefined;
const outputPath = resolve(root, outputFlagIndex >= 0 ? cliArgs[outputFlagIndex + 1] ?? defaultOutputPath : positionalOutput ?? defaultOutputPath);
const maxCommits = Number(process.env.PI_WEB_ITERATION_COMMITS ?? 40);
const maxHarnessRuns = Number(process.env.PI_WEB_ITERATION_HARNESS_RUNS ?? 80);
const maxSessionHistory = Number(process.env.PI_WEB_ITERATION_SESSION_HISTORY ?? 500);

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

type SessionActionSummary = {
  toolCalls: number;
  toolResults: number;
  toolResultChars: number;
  validationRuns: number;
  validationFailures: number;
  validationReruns: number;
  editAttempts: number;
  editFailures: number;
  uniqueReadPaths: number;
  uniqueBashCommands: number;
  largestToolResultChars: number;
  elapsedMs?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
};

type SessionHistoryActionSummary = SessionActionSummary & {
  sessionsWithValidationReruns: number;
  sessionsWithEditFailures: number;
  largestSessionToolResultChars: number;
};

type SessionContextReport = {
  sessionPath?: string;
  sessionCwd?: string;
  lines: number;
  actionSummary: SessionActionSummary;
  toolCallsByName: Record<string, number>;
  toolResultsByName: Record<string, { calls: number; chars: number; estimatedTokens: number; maxChars: number }>;
  toolInputsByName: Record<string, Array<{ input: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>>;
  repeatedToolInputs: Array<{ toolName: string; input: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  readPaths: Array<{ path: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  bashCommands: Array<{ command: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  validationCommands: Array<{ command: string; runs: number; failures: number; resultChars: number; estimatedTokens: number; maxDurationMs?: number }>;
  editAttempts: Array<{ path: string; attempts: number; successes: number; failures: number; resultChars: number }>;
  largestToolResults: Array<{ toolName: string; chars: number; estimatedTokens: number; timestamp?: string; messageId?: string; input?: string; durationMs?: number }>;
  assistantResponsesWithUsage: number;
  latestUsage?: Record<string, unknown>;
  maxReportedInputOrCacheRead?: number;
  actionRecommendations: string[];
  notes: string[];
};

type SessionHistoryReport = {
  actionSummary: SessionHistoryActionSummary;
  sessionCount: number;
  totalLines: number;
  totalBytes: number;
  oldestMtime?: string;
  newestMtime?: string;
  cwdFrequency: Array<{ cwd: string; sessions: number }>;
  toolCallsByName: Record<string, number>;
  toolResultsByName: Record<string, { calls: number; chars: number; estimatedTokens: number; maxChars: number }>;
  validationCommands: Array<{ command: string; runs: number; failures: number; resultChars: number; estimatedTokens: number; maxDurationMs?: number }>;
  editAttempts: Array<{ path: string; attempts: number; successes: number; failures: number; resultChars: number }>;
  topReadPaths: Array<{ path: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  topBashCommands: Array<{ command: string; calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>;
  largestSessions: Array<{ sessionPath: string; cwd?: string; lines: number; bytes: number; mtime: string; toolResultChars: number; validationRuns: number; editFailures: number }>;
  largestToolResults: Array<{ sessionPath?: string; toolName: string; chars: number; estimatedTokens: number; timestamp?: string; input?: string; durationMs?: number }>;
  sessionsWithEditFailures: Array<{ sessionPath?: string; failures: number; attempts: number; files: string[] }>;
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
  sessionHistory?: SessionHistoryReport;
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

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function validationLabelsFromCommand(command: string): string[] {
  const labels: string[] = [];
  if (/\bbun run check\b/.test(command)) labels.push("bun run check");
  if (/\bbun run test:web-perf\b/.test(command) || /\bbun scripts\/ui-harness\.ts --scenario all\b/.test(command)) labels.push("bun run test:web-perf / all harness");
  for (const match of command.matchAll(/\bbun scripts\/ui-harness\.ts --scenario\s+([^\s&;]+)/g)) {
    const scenario = match[1];
    if (scenario && scenario !== "all") labels.push(`ui-harness:${scenario}`);
  }
  if (/\bbun run report:iteration\b/.test(command) || /\bbun scripts\/report-iteration\.ts\b/.test(command)) labels.push("bun run report:iteration");
  return Array.from(new Set(labels));
}

function addInputSummary(
  record: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>,
  key: string,
  summary: { calls: number; resultChars: number; maxResultChars: number },
): void {
  record[key] ??= { calls: 0, resultChars: 0, estimatedTokens: 0, maxResultChars: 0 };
  const existing = record[key];
  existing.calls += summary.calls;
  existing.resultChars += summary.resultChars;
  existing.estimatedTokens = estimateTokensFromChars(existing.resultChars);
  existing.maxResultChars = Math.max(existing.maxResultChars, summary.maxResultChars);
}

function incrementValidationSummary(
  record: Record<string, { runs: number; failures: number; resultChars: number; estimatedTokens: number; maxDurationMs?: number }>,
  command: string,
  failed: boolean,
  resultChars: number,
  durationMs?: number,
): void {
  record[command] ??= { runs: 0, failures: 0, resultChars: 0, estimatedTokens: 0 };
  const summary = record[command];
  summary.runs += 1;
  if (failed) summary.failures += 1;
  summary.resultChars += resultChars;
  summary.estimatedTokens = estimateTokensFromChars(summary.resultChars);
  if (typeof durationMs === "number") summary.maxDurationMs = Math.max(summary.maxDurationMs ?? 0, durationMs);
}

function incrementEditAttempt(
  record: Record<string, { attempts: number; successes: number; failures: number; resultChars: number }>,
  path: string,
  failed: boolean,
  resultChars: number,
): void {
  record[path] ??= { attempts: 0, successes: 0, failures: 0, resultChars: 0 };
  const summary = record[path];
  summary.attempts += 1;
  if (failed) summary.failures += 1;
  else summary.successes += 1;
  summary.resultChars += resultChars;
}

function emptySessionActionSummary(): SessionActionSummary {
  return {
    toolCalls: 0,
    toolResults: 0,
    toolResultChars: 0,
    validationRuns: 0,
    validationFailures: 0,
    validationReruns: 0,
    editAttempts: 0,
    editFailures: 0,
    uniqueReadPaths: 0,
    uniqueBashCommands: 0,
    largestToolResultChars: 0,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
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

function sessionLogCandidates(): Array<{ path: string; mtimeMs: number; cwd?: string; bytes: number }> {
  return candidateSessionDirs().flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => {
        const path = join(dir, entry);
        const stat = statSync(path);
        return { path, mtimeMs: stat.mtimeMs, cwd: readSessionCwd(path), bytes: stat.size };
      });
  });
}

function findSessionLogPath(): string | undefined {
  const explicit = sessionFlagIndex >= 0 ? cliArgs[sessionFlagIndex + 1] : undefined;
  if (explicit) return resolve(expandHome(explicit));

  const sorted = sessionLogCandidates().sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sorted.find((candidate) => candidate.cwd === root)?.path ?? sorted[0]?.path;
}

function findSessionHistoryPaths(): string[] {
  return sessionLogCandidates()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessionHistory)
    .map((candidate) => candidate.path);
}

function buildSessionContextReport(sessionPathOverride?: string): SessionContextReport {
  const sessionPath = sessionPathOverride ?? findSessionLogPath();
  const missingReport: SessionContextReport = {
    lines: 0,
    actionSummary: emptySessionActionSummary(),
    toolCallsByName: {},
    toolResultsByName: {},
    toolInputsByName: {},
    repeatedToolInputs: [],
    readPaths: [],
    bashCommands: [],
    validationCommands: [],
    editAttempts: [],
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
    actionSummary: emptySessionActionSummary(),
    toolCallsByName: {},
    toolResultsByName: {},
    toolInputsByName: {},
    repeatedToolInputs: [],
    readPaths: [],
    bashCommands: [],
    validationCommands: [],
    editAttempts: [],
    largestToolResults: [],
    assistantResponsesWithUsage: 0,
    actionRecommendations: [],
    notes: ["Tool-result sizes are character counts with a rough chars/4 token estimate; content is intentionally not printed."],
  };
  const toolCallsById: Record<string, { toolName: string; input: string; args: Record<string, unknown>; timestamp?: string; startedAtMs?: number }> = {};
  const toolInputs: Record<string, Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }>> = {};
  const readPathSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};
  const bashCommandSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};
  const validationCommandSummaries: Record<string, { runs: number; failures: number; resultChars: number; estimatedTokens: number; maxDurationMs?: number }> = {};
  const editAttemptSummaries: Record<string, { attempts: number; successes: number; failures: number; resultChars: number }> = {};
  let firstEventMs: number | undefined;
  let lastEventMs: number | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventMs = timestampMs(event.timestamp);
    if (typeof eventMs === "number") {
      if (firstEventMs === undefined || eventMs < firstEventMs) {
        firstEventMs = eventMs;
        firstTimestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
      }
      if (lastEventMs === undefined || eventMs > lastEventMs) {
        lastEventMs = eventMs;
        lastTimestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
      }
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
              startedAtMs: timestampMs(event.timestamp),
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
      const failed = message.isError === true;
      const endedAtMs = timestampMs(event.timestamp);
      const durationMs = typeof endedAtMs === "number" && typeof toolCall?.startedAtMs === "number" ? Math.max(0, endedAtMs - toolCall.startedAtMs) : undefined;
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
        const command = truncateOneLine(toolCall.args.command);
        incrementInputSummary(bashCommandSummaries, command, chars);
        for (const validationLabel of validationLabelsFromCommand(toolCall.args.command)) {
          incrementValidationSummary(validationCommandSummaries, validationLabel, failed, chars, durationMs);
        }
      }
      if ((toolName === "edit" || toolName === "write") && typeof toolCall?.args.path === "string") {
        incrementEditAttempt(editAttemptSummaries, toolCall.args.path, failed, chars);
      }

      report.largestToolResults.push({
        toolName,
        chars,
        estimatedTokens: estimateTokensFromChars(chars),
        timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
        messageId: typeof event.id === "string" ? event.id : undefined,
        input,
        durationMs,
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
  report.validationCommands = Object.entries(validationCommandSummaries)
    .map(([command, summary]) => ({ command, ...summary }))
    .sort((a, b) => b.runs - a.runs || b.resultChars - a.resultChars)
    .slice(0, 10);
  report.editAttempts = Object.entries(editAttemptSummaries)
    .map(([path, summary]) => ({ path, ...summary }))
    .sort((a, b) => b.failures - a.failures || b.attempts - a.attempts || b.resultChars - a.resultChars)
    .slice(0, 10);
  report.largestToolResults.sort((a, b) => b.chars - a.chars);
  report.largestToolResults = report.largestToolResults.slice(0, 8);
  report.actionSummary = {
    toolCalls: Object.values(report.toolCallsByName).reduce((sum, count) => sum + count, 0),
    toolResults: Object.values(report.toolResultsByName).reduce((sum, item) => sum + item.calls, 0),
    toolResultChars: Object.values(report.toolResultsByName).reduce((sum, item) => sum + item.chars, 0),
    validationRuns: report.validationCommands.reduce((sum, item) => sum + item.runs, 0),
    validationFailures: report.validationCommands.reduce((sum, item) => sum + item.failures, 0),
    validationReruns: report.validationCommands.reduce((sum, item) => sum + Math.max(0, item.runs - 1), 0),
    editAttempts: report.editAttempts.reduce((sum, item) => sum + item.attempts, 0),
    editFailures: report.editAttempts.reduce((sum, item) => sum + item.failures, 0),
    uniqueReadPaths: Object.keys(readPathSummaries).length,
    uniqueBashCommands: Object.keys(bashCommandSummaries).length,
    largestToolResultChars: report.largestToolResults[0]?.chars ?? 0,
    elapsedMs: typeof firstEventMs === "number" && typeof lastEventMs === "number" ? Math.max(0, lastEventMs - firstEventMs) : undefined,
    firstTimestamp,
    lastTimestamp,
  };

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
  const repeatedValidation = report.validationCommands.find((item) => item.runs > 1);
  if (repeatedValidation) {
    report.actionRecommendations.push(
      `Validation rerun: ${repeatedValidation.command} ran ${repeatedValidation.runs} times${repeatedValidation.failures ? ` with ${repeatedValidation.failures} failure(s)` : ""}; capture the reason in the handoff when reruns are intentional.`,
    );
  }
  const failedEdit = report.editAttempts.find((item) => item.failures > 0);
  if (failedEdit) {
    report.actionRecommendations.push(`Edit retry loop: ${failedEdit.path} had ${failedEdit.failures}/${failedEdit.attempts} failed edit/write attempts; inspect nearby context and patch smaller unique blocks.`);
  }
  const mobileValidation = report.validationCommands.find((item) => item.command === "ui-harness:mobile-layout");
  if (mobileValidation) {
    report.actionRecommendations.push("Mobile workflow: include the latest `mobile-layout` artifact directory and key PNGs in handoffs when mobile UI behavior or harness screenshots changed.");
  }
  if (report.actionRecommendations.length === 0) {
    report.actionRecommendations.push("No repeated high-cost tool pattern detected in this session; continue using targeted reads and focused validation selection.");
  }
  return report;
}

function addToolResultSummary(
  record: Record<string, { calls: number; chars: number; estimatedTokens: number; maxChars: number }>,
  toolName: string,
  summary: { calls: number; chars: number; maxChars: number },
): void {
  record[toolName] ??= { calls: 0, chars: 0, estimatedTokens: 0, maxChars: 0 };
  const existing = record[toolName];
  existing.calls += summary.calls;
  existing.chars += summary.chars;
  existing.estimatedTokens = estimateTokensFromChars(existing.chars);
  existing.maxChars = Math.max(existing.maxChars, summary.maxChars);
}

function buildSessionHistoryReport(): SessionHistoryReport {
  const paths = findSessionHistoryPaths();
  const cwdCounts: Record<string, number> = {};
  const toolCallsByName: Record<string, number> = {};
  const toolResultsByName: Record<string, { calls: number; chars: number; estimatedTokens: number; maxChars: number }> = {};
  const validationSummaries: Record<string, { runs: number; failures: number; resultChars: number; estimatedTokens: number; maxDurationMs?: number }> = {};
  const editSummaries: Record<string, { attempts: number; successes: number; failures: number; resultChars: number }> = {};
  const readSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};
  const bashSummaries: Record<string, { calls: number; resultChars: number; estimatedTokens: number; maxResultChars: number }> = {};
  const largestSessions: SessionHistoryReport["largestSessions"] = [];
  const largestToolResults: SessionHistoryReport["largestToolResults"] = [];
  const sessionsWithEditFailures: SessionHistoryReport["sessionsWithEditFailures"] = [];
  const actionSummary: SessionHistoryActionSummary = {
    ...emptySessionActionSummary(),
    sessionsWithValidationReruns: 0,
    sessionsWithEditFailures: 0,
    largestSessionToolResultChars: 0,
  };
  let totalLines = 0;
  let totalBytes = 0;
  let oldestMtimeMs: number | undefined;
  let newestMtimeMs: number | undefined;

  for (const path of paths) {
    const stat = statSync(path);
    oldestMtimeMs = Math.min(oldestMtimeMs ?? stat.mtimeMs, stat.mtimeMs);
    newestMtimeMs = Math.max(newestMtimeMs ?? stat.mtimeMs, stat.mtimeMs);
    const report = buildSessionContextReport(path);
    const displayPath = report.sessionPath;
    totalLines += report.lines;
    totalBytes += stat.size;
    if (report.sessionCwd) increment(cwdCounts, report.sessionCwd);
    for (const [tool, count] of Object.entries(report.toolCallsByName)) increment(toolCallsByName, tool, count);
    for (const [tool, summary] of Object.entries(report.toolResultsByName)) addToolResultSummary(toolResultsByName, tool, summary);
    for (const item of report.validationCommands) {
      validationSummaries[item.command] ??= { runs: 0, failures: 0, resultChars: 0, estimatedTokens: 0 };
      const summary = validationSummaries[item.command];
      summary.runs += item.runs;
      summary.failures += item.failures;
      summary.resultChars += item.resultChars;
      summary.estimatedTokens = estimateTokensFromChars(summary.resultChars);
      if (typeof item.maxDurationMs === "number") summary.maxDurationMs = Math.max(summary.maxDurationMs ?? 0, item.maxDurationMs);
    }
    for (const item of report.editAttempts) {
      editSummaries[item.path] ??= { attempts: 0, successes: 0, failures: 0, resultChars: 0 };
      const summary = editSummaries[item.path];
      summary.attempts += item.attempts;
      summary.successes += item.successes;
      summary.failures += item.failures;
      summary.resultChars += item.resultChars;
    }
    for (const item of report.readPaths) addInputSummary(readSummaries, item.path, item);
    for (const item of report.bashCommands) addInputSummary(bashSummaries, item.command, item);
    const toolResultChars = Object.values(report.toolResultsByName).reduce((sum, item) => sum + item.chars, 0);
    const validationRuns = report.validationCommands.reduce((sum, item) => sum + item.runs, 0);
    const editFailures = report.editAttempts.reduce((sum, item) => sum + item.failures, 0);
    actionSummary.toolCalls += report.actionSummary.toolCalls;
    actionSummary.toolResults += report.actionSummary.toolResults;
    actionSummary.toolResultChars += report.actionSummary.toolResultChars;
    actionSummary.validationRuns += report.actionSummary.validationRuns;
    actionSummary.validationFailures += report.actionSummary.validationFailures;
    actionSummary.validationReruns += report.actionSummary.validationReruns;
    actionSummary.editAttempts += report.actionSummary.editAttempts;
    actionSummary.editFailures += report.actionSummary.editFailures;
    actionSummary.largestToolResultChars = Math.max(actionSummary.largestToolResultChars, report.actionSummary.largestToolResultChars);
    actionSummary.largestSessionToolResultChars = Math.max(actionSummary.largestSessionToolResultChars, toolResultChars);
    if (report.actionSummary.validationReruns > 0) actionSummary.sessionsWithValidationReruns += 1;
    if (editFailures > 0) actionSummary.sessionsWithEditFailures += 1;
    if (typeof report.actionSummary.elapsedMs === "number") actionSummary.elapsedMs = (actionSummary.elapsedMs ?? 0) + report.actionSummary.elapsedMs;
    largestSessions.push({
      sessionPath: displayPath ?? path,
      cwd: report.sessionCwd,
      lines: report.lines,
      bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      toolResultChars,
      validationRuns,
      editFailures,
    });
    for (const item of report.largestToolResults) largestToolResults.push({ sessionPath: displayPath, ...item });
    if (editFailures > 0) {
      sessionsWithEditFailures.push({
        sessionPath: displayPath,
        failures: editFailures,
        attempts: report.editAttempts.reduce((sum, item) => sum + item.attempts, 0),
        files: report.editAttempts.filter((item) => item.failures > 0).map((item) => item.path).slice(0, 6),
      });
    }
  }

  const validationCommands = Object.entries(validationSummaries)
    .map(([command, summary]) => ({ command, ...summary }))
    .sort((a, b) => b.runs - a.runs || b.failures - a.failures || b.resultChars - a.resultChars)
    .slice(0, 20);
  const editAttempts = Object.entries(editSummaries)
    .map(([path, summary]) => ({ path, ...summary }))
    .sort((a, b) => b.failures - a.failures || b.attempts - a.attempts || b.resultChars - a.resultChars)
    .slice(0, 20);
  const topReadPaths = Object.entries(readSummaries)
    .map(([path, summary]) => ({ path, ...summary }))
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, 20);
  const topBashCommands = Object.entries(bashSummaries)
    .map(([command, summary]) => ({ command, ...summary }))
    .sort((a, b) => b.resultChars - a.resultChars)
    .slice(0, 20);

  actionSummary.uniqueReadPaths = Object.keys(readSummaries).length;
  actionSummary.uniqueBashCommands = Object.keys(bashSummaries).length;
  actionSummary.firstTimestamp = typeof oldestMtimeMs === "number" ? new Date(oldestMtimeMs).toISOString() : undefined;
  actionSummary.lastTimestamp = typeof newestMtimeMs === "number" ? new Date(newestMtimeMs).toISOString() : undefined;

  const actionRecommendations: string[] = [];
  const topValidation = validationCommands.find((item) => item.runs > 1);
  if (topValidation) actionRecommendations.push(`Across backfilled sessions, ${topValidation.command} ran ${topValidation.runs} times with ${topValidation.failures} reported failure result(s); use this to tune validation selectors and rerun guidance.`);
  const topEditFailure = editAttempts.find((item) => item.failures > 0);
  if (topEditFailure) actionRecommendations.push(`Edit failures cluster around ${topEditFailure.path} (${topEditFailure.failures}/${topEditFailure.attempts} failures); prefer narrower context reads and smaller exact replacements there.`);
  const topContext = [...topReadPaths.map((item) => ({ label: `read ${item.path}`, chars: item.resultChars })), ...topBashCommands.map((item) => ({ label: `bash ${item.command}`, chars: item.resultChars }))].sort((a, b) => b.chars - a.chars)[0];
  if (topContext) actionRecommendations.push(`Largest historical context contributor: ${topContext.label} produced ${topContext.chars.toLocaleString()} chars; consider a narrower report or command pattern.`);
  const mobileRuns = validationCommands.find((item) => item.command === "ui-harness:mobile-layout");
  if (mobileRuns) actionRecommendations.push(`Mobile validation appears in history (${mobileRuns.runs} runs); keep mobile artifact paths/screenshots in handoffs for mobile UI slices.`);
  if (actionRecommendations.length === 0) actionRecommendations.push("No obvious cross-session retry/context hotspot found in the backfilled JSONL logs yet.");

  return {
    actionSummary,
    sessionCount: paths.length,
    totalLines,
    totalBytes,
    oldestMtime: typeof oldestMtimeMs === "number" ? new Date(oldestMtimeMs).toISOString() : undefined,
    newestMtime: typeof newestMtimeMs === "number" ? new Date(newestMtimeMs).toISOString() : undefined,
    cwdFrequency: Object.entries(cwdCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([cwd, sessions]) => ({ cwd, sessions })),
    toolCallsByName,
    toolResultsByName,
    validationCommands,
    editAttempts,
    topReadPaths,
    topBashCommands,
    largestSessions: largestSessions.sort((a, b) => b.toolResultChars - a.toolResultChars || b.bytes - a.bytes).slice(0, 20),
    largestToolResults: largestToolResults.sort((a, b) => b.chars - a.chars).slice(0, 20),
    sessionsWithEditFailures: sessionsWithEditFailures.sort((a, b) => b.failures - a.failures || b.attempts - a.attempts).slice(0, 20),
    actionRecommendations,
    notes: [
      `Scanned up to ${maxSessionHistory.toLocaleString()} local JSONL session logs from ${candidateSessionDirs().join(", ")}.`,
      "Backfill is metadata-only: raw prompts/tool outputs are not printed; deleted/unlogged sessions and human intent for reruns cannot be reconstructed.",
      "Action summaries count all parsed tool calls/results; history-level unique read/bash counts and top input lists are capped per session, so long-tail per-input counts may be underreported while totals remain accurate.",
    ],
  };
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
  console.log("\nAction summary:");
  const summary = report.actionSummary;
  console.log(`- tools: ${summary.toolCalls.toLocaleString()} calls requested, ${summary.toolResults.toLocaleString()} results, ${summary.toolResultChars.toLocaleString()} result chars`);
  console.log(`- validation: ${summary.validationRuns.toLocaleString()} runs, ${summary.validationFailures.toLocaleString()} failures, ${summary.validationReruns.toLocaleString()} reruns`);
  console.log(`- edits: ${summary.editAttempts.toLocaleString()} attempts, ${summary.editFailures.toLocaleString()} failures`);
  console.log(`- context shape: ${summary.uniqueReadPaths.toLocaleString()} read path(s), ${summary.uniqueBashCommands.toLocaleString()} bash command(s), largest result ${summary.largestToolResultChars.toLocaleString()} chars`);
  if (typeof summary.elapsedMs === "number") console.log(`- elapsed event span: ${formatDuration(summary.elapsedMs)}${summary.firstTimestamp && summary.lastTimestamp ? ` (${summary.firstTimestamp} → ${summary.lastTimestamp})` : ""}`);
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
  console.log("\nValidation command summary:");
  if (report.validationCommands.length === 0) console.log("- none found");
  report.validationCommands.forEach((item) => {
    const duration = typeof item.maxDurationMs === "number" ? `, max ${(item.maxDurationMs / 1000).toFixed(1)}s` : "";
    console.log(`- ${item.command}: ${item.runs} runs, ${item.failures} failures, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)${duration}`);
  });
  console.log("\nEdit/write attempts:");
  if (report.editAttempts.length === 0) console.log("- none found");
  report.editAttempts.forEach((item) => {
    console.log(`- ${item.path}: ${item.attempts} attempts, ${item.successes} successes, ${item.failures} failures, ${item.resultChars.toLocaleString()} result chars`);
  });
  console.log("\nRepeated tool inputs:");
  if (report.repeatedToolInputs.length === 0) console.log("- none found");
  report.repeatedToolInputs.forEach((item) => {
    console.log(`- ${item.toolName} ${item.input}: ${item.calls} calls, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)`);
  });
  console.log("\nLargest tool results:");
  if (report.largestToolResults.length === 0) console.log("- none found");
  report.largestToolResults.forEach((item) => {
    const duration = typeof item.durationMs === "number" ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined;
    const suffix = [item.input, duration, item.timestamp, item.messageId].filter(Boolean).join(" · ");
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

function printSessionHistoryReport(report: SessionHistoryReport): void {
  console.log("\n## Session history backfill");
  console.log(`Sessions scanned: ${report.sessionCount}`);
  console.log(`JSONL lines: ${report.totalLines.toLocaleString()}`);
  console.log(`JSONL bytes: ${report.totalBytes.toLocaleString()}`);
  if (report.oldestMtime || report.newestMtime) console.log(`Mtime range: ${report.oldestMtime ?? "unknown"} → ${report.newestMtime ?? "unknown"}`);
  console.log("\nAction summary:");
  const summary = report.actionSummary;
  console.log(`- tools: ${summary.toolCalls.toLocaleString()} calls requested, ${summary.toolResults.toLocaleString()} results, ${summary.toolResultChars.toLocaleString()} result chars`);
  console.log(`- validation: ${summary.validationRuns.toLocaleString()} runs, ${summary.validationFailures.toLocaleString()} failures, ${summary.validationReruns.toLocaleString()} reruns across ${summary.sessionsWithValidationReruns.toLocaleString()} session(s)`);
  console.log(`- edits: ${summary.editAttempts.toLocaleString()} attempts, ${summary.editFailures.toLocaleString()} failures across ${summary.sessionsWithEditFailures.toLocaleString()} session(s)`);
  console.log(`- context shape: ${summary.uniqueReadPaths.toLocaleString()} read path(s), ${summary.uniqueBashCommands.toLocaleString()} bash command(s), largest result ${summary.largestToolResultChars.toLocaleString()} chars, largest session ${summary.largestSessionToolResultChars.toLocaleString()} chars`);
  if (typeof summary.elapsedMs === "number") console.log(`- summed event spans: ${formatDuration(summary.elapsedMs)}`);
  console.log("\nTop workspaces:");
  if (report.cwdFrequency.length === 0) console.log("- none found");
  report.cwdFrequency.forEach((item) => console.log(`- ${item.cwd}: ${item.sessions} sessions`));
  console.log("\nTool calls requested:");
  const toolCalls = Object.entries(report.toolCallsByName).sort((a, b) => b[1] - a[1]);
  if (toolCalls.length === 0) console.log("- none found");
  toolCalls.forEach(([tool, count]) => console.log(`- ${tool}: ${count}`));
  console.log("\nTool result payloads:");
  const toolResults = Object.entries(report.toolResultsByName).sort((a, b) => b[1].chars - a[1].chars);
  if (toolResults.length === 0) console.log("- none found");
  toolResults.forEach(([tool, summary]) => console.log(`- ${tool}: ${summary.calls} calls, ${summary.chars.toLocaleString()} chars (~${summary.estimatedTokens.toLocaleString()} tokens), largest ${summary.maxChars.toLocaleString()} chars`));
  console.log("\nValidation command summary:");
  if (report.validationCommands.length === 0) console.log("- none found");
  report.validationCommands.slice(0, 12).forEach((item) => {
    const duration = typeof item.maxDurationMs === "number" ? `, max ${(item.maxDurationMs / 1000).toFixed(1)}s` : "";
    console.log(`- ${item.command}: ${item.runs} runs, ${item.failures} failures, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)${duration}`);
  });
  console.log("\nEdit/write attempts:");
  if (report.editAttempts.length === 0) console.log("- none found");
  report.editAttempts.slice(0, 12).forEach((item) => console.log(`- ${item.path}: ${item.attempts} attempts, ${item.successes} successes, ${item.failures} failures, ${item.resultChars.toLocaleString()} result chars`));
  console.log("\nTop read paths:");
  if (report.topReadPaths.length === 0) console.log("- none found");
  report.topReadPaths.slice(0, 10).forEach((item) => console.log(`- ${item.path}: ${item.calls} reads, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)`));
  console.log("\nTop bash commands:");
  if (report.topBashCommands.length === 0) console.log("- none found");
  report.topBashCommands.slice(0, 10).forEach((item) => console.log(`- ${item.command}: ${item.calls} runs, ${item.resultChars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)`));
  console.log("\nLargest sessions:");
  if (report.largestSessions.length === 0) console.log("- none found");
  report.largestSessions.slice(0, 10).forEach((item) => console.log(`- ${item.sessionPath}: ${item.toolResultChars.toLocaleString()} tool-result chars, ${item.lines} lines, ${item.validationRuns} validation runs, ${item.editFailures} edit failures`));
  console.log("\nLargest tool results:");
  if (report.largestToolResults.length === 0) console.log("- none found");
  report.largestToolResults.slice(0, 10).forEach((item) => {
    const duration = typeof item.durationMs === "number" ? `${(item.durationMs / 1000).toFixed(1)}s` : undefined;
    const suffix = [item.sessionPath, item.input, duration, item.timestamp].filter(Boolean).join(" · ");
    console.log(`- ${item.toolName}: ${item.chars.toLocaleString()} chars (~${item.estimatedTokens.toLocaleString()} tokens)${suffix ? ` · ${suffix}` : ""}`);
  });
  console.log("\nSessions with edit failures:");
  if (report.sessionsWithEditFailures.length === 0) console.log("- none found");
  report.sessionsWithEditFailures.slice(0, 10).forEach((item) => console.log(`- ${item.sessionPath ?? "unknown"}: ${item.failures}/${item.attempts} failures · ${item.files.join(", ")}`));
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

function fullSuiteDecision(recommendation: ValidationRecommendation): { mode: "skip" | "escalate" | "run"; text: string } {
  if (recommendation.commands.includes("bun run test:web-perf")) {
    return {
      mode: "run",
      text: "RUN: the selector included the full fake-agent suite in the primary command list.",
    };
  }
  if (recommendation.optionalCommands.includes("bun run test:web-perf")) {
    return {
      mode: "escalate",
      text:
        "ESCALATE ONLY: do not run the full fake-agent suite by default; run it after focused commands only if the touched behavior is broad, protocol/session-lifecycle related, or focused validation fails unexpectedly.",
    };
  }
  return {
    mode: "skip",
    text: "SKIP by default: full fake-agent suite is not selected for these files; run it only if focused validation fails or the change proves broader than expected.",
  };
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
  console.log("Strategy: focused-first; stop and fix if an earlier command fails.");
  console.log("Commands:");
  recommendation.commands.forEach((command, index) => console.log(`${index + 1}. ${command}`));
  if (recommendation.optionalCommands.length > 0) {
    console.log("Optional / escalation:");
    recommendation.optionalCommands.forEach((command) => console.log(`- ${command}`));
  }
  const fullSuite = fullSuiteDecision(recommendation);
  console.log(`Full suite: ${fullSuite.text}`);
}

function printValidationRecommendation(recommendation: ValidationRecommendation): void {
  console.log("\nSuggested validation:");
  if (recommendation.files.length === 0) {
    console.log("No changed files were provided or detected; run `bun run check` first.");
    printValidationDecisionBlock(recommendation);
    return;
  }
  console.log("Strategy: focused-first; stop and fix if an earlier command fails.");
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
        "Follow the selector's focused-first command list; stop after the first failure instead of running later harness commands.",
        "Treat full `bun run test:web-perf` as an explicit escalation, not the default: use it for protocol/shared WebSocket changes, broad UI interaction changes, lifecycle/restart changes, or unexpected focused failures.",
        "Include the selector's `## Validation decision` block in handoffs so future agents can tune bad recommendations.",
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
      area: "Session action telemetry",
      confidence: "medium",
      evidence: [
        "`--session-context` and `--session-history` now include compact action summaries for tool calls/results, validation reruns, edit failures, unique read/bash inputs, largest result size, and event-span timing.",
        "Phase timing is still approximate because JSONL logs expose event timestamps, not explicit plan/edit/validate phase markers.",
      ],
      optimizeAgentBy: [
        "Use `bun run report:iteration --session-context` near the end of long sessions to spot repeated validation, edit retry loops, and context-heavy commands before handoff.",
        "Use `bun run report:iteration --session-history` periodically to decide whether more main-file extraction, harness output trimming, or selector tuning is paying off.",
        "If this remains too coarse, add explicit phase markers or per-command intent labels rather than printing raw prompts/tool outputs.",
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
  console.log("\nNext instrumentation if this is not enough: add explicit phase markers or intent labels so timing can distinguish planning, editing, validation, and handoff without printing raw content.");
}

function printHelp(): void {
  console.log(`Usage:
  bun run report:iteration
  bun run report:iteration --output test-results/iteration/report.json
  bun run report:iteration --recommend <changed files...>
  bun run report:iteration --agent-actions [--recommend <changed files...>]
  bun run report:iteration --session-context [--session ~/.pi-web-agent/sessions/session.jsonl]
  bun run report:iteration --session-history

When --recommend is passed without files, changed files are read from git status. Session-context and session-history modes read local pi JSONL logs and report counts/sizes without printing tool content.`);
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
const sessionHistory = sessionHistoryMode ? buildSessionHistoryReport() : undefined;
const report: IterationReport = { ...baseReport, candidates: buildCandidates(baseReport), ...(sessionContext ? { sessionContext } : {}), ...(sessionHistory ? { sessionHistory } : {}) };
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

if (sessionHistory) {
  printSessionHistoryReport(sessionHistory);
}
