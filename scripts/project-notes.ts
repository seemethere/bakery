import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const projectLogPath = join(root, "PROJECT_LOG.md");
const designPath = join(root, "DESIGN.md");

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next >= 0 ? next : undefined).trim();
}

function lineNumberForIndex(text: string, index: number): number | undefined {
  if (index < 0) return undefined;
  return text.slice(0, index).split("\n").length;
}

function headingLine(text: string, heading: string): number | undefined {
  return lineNumberForIndex(text, text.indexOf(`## ${heading}`));
}

function firstLineMatching(text: string, pattern: RegExp): { line: number; text: string } | undefined {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  return index >= 0 ? { line: index + 1, text: lines[index].trim() } : undefined;
}

function matchingLines(text: string, pattern: RegExp, limit: number): Array<{ line: number; text: string }> {
  const matches: Array<{ line: number; text: string }> = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (matches.length < limit && pattern.test(trimmed)) matches.push({ line: index + 1, text: trimmed });
  });
  return matches;
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function bulletLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function numberedLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line));
}

function firstParagraphAfterHeading(value: string): string | undefined {
  const lines = value.split("\n").slice(1);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("-") || /^\d+\.\s+/.test(trimmed) || trimmed.startsWith("```")) break;
    paragraph.push(trimmed);
  }
  return paragraph.length > 0 ? paragraph.join(" ") : undefined;
}

function printList(items: string[], empty = "- none found"): void {
  if (items.length === 0) {
    console.log(empty);
    return;
  }
  items.forEach((item) => console.log(item));
}

function printLineReferences(items: Array<{ line: number; text: string }>, empty = "- none found"): void {
  if (items.length === 0) {
    console.log(empty);
    return;
  }
  items.forEach((item) => console.log(`- L${item.line}: ${truncate(item.text, 240)}`));
}

function latestCommit(): string | undefined {
  try {
    return execFileSync("git", ["log", "-1", "--oneline"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const handoffMode = Bun.argv.includes("--handoff");
const projectLog = readText(projectLogPath);
const design = readText(designPath);
const currentStatus = section(projectLog, "Current status");
const verification = section(projectLog, "Verification");
const nextPriorities = section(projectLog, "Next priorities");
const designGoal = section(design, "Goal");

const currentIntro = firstParagraphAfterHeading(currentStatus);
const recentStatusBullets = bulletLines(currentStatus).slice(-8).map((line) => `- ${truncate(line.slice(2), 220)}`);
const latestLine = verification
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.startsWith("Latest:"));
const latestSummary = latestLine ? latestLine.split(" Previous latest:")[0] : undefined;
const priorityLines = numberedLines(nextPriorities)
  .slice(0, 8)
  .map((line) => truncate(line, 260));

if (handoffMode) {
  console.log("# Project handoff edit targets");
  console.log("Read-only guidance from PROJECT_LOG.md; use line numbers for targeted reads/edits instead of broad log dumps.\n");

  console.log("## Files");
  console.log(`- ${relative(root, projectLogPath)}`);
  console.log(`- ${relative(root, designPath)} (design reference only; usually no handoff edit needed)`);

  console.log("\n## PROJECT_LOG.md anchors");
  const anchors = ["Current status", "Verification", "Next priorities", "Session handoff convention"].map((heading) => ({ heading, line: headingLine(projectLog, heading) }));
  anchors.forEach(({ heading, line }) => console.log(line ? `- L${line}: ## ${heading}` : `- missing: ## ${heading}`));

  console.log("\n## Latest verification target");
  const latest = firstLineMatching(projectLog, /^Latest:/);
  if (latest) console.log(`- L${latest.line}: ${truncate(latest.text, 700)}`);
  else console.log("- no `Latest:` line found in PROJECT_LOG.md Verification section");

  console.log("\n## Recent status bullets to consider extending");
  const statusStart = headingLine(projectLog, "Current status") ?? 1;
  const recentBullets = matchingLines(currentStatus, /^- /, 200).map((item) => ({ line: statusStart + item.line - 1, text: item.text })).slice(-5);
  printLineReferences(recentBullets);

  console.log("\n## Top next priorities");
  const prioritiesStart = headingLine(projectLog, "Next priorities") ?? 1;
  const topPriorities = matchingLines(nextPriorities, /^\d+\.\s+/, 5).map((item) => ({ line: prioritiesStart + item.line - 1, text: item.text }));
  printLineReferences(topPriorities);

  console.log("\n## Git context");
  console.log(`- latest commit: ${latestCommit() ?? "unavailable"}`);

  console.log("\n## End-of-session checklist");
  console.log("- Run `bun run check` unless the operator asks otherwise.");
  console.log("- Update PROJECT_LOG.md status/latest verification/next priorities with concise notes.");
  console.log("- Tell the operator whether browser refresh or backend/dev-server restart is needed.");
  console.log("- Commit with a concise Conventional Commit message unless asked not to commit.");
  process.exit(0);
}

console.log("# Project notes summary");
console.log("Generated from DESIGN.md and PROJECT_LOG.md with long history intentionally capped.\n");

console.log("## Design goal");
const goalParagraph = firstParagraphAfterHeading(designGoal);
console.log(goalParagraph ? `- ${truncate(goalParagraph, 500)}` : "- DESIGN.md goal not found");

console.log("\n## Current status summary");
if (currentIntro) console.log(`- ${truncate(currentIntro, 500)}`);
printList(recentStatusBullets);

console.log("\n## Latest verification");
if (latestSummary) {
  console.log(`- ${truncate(latestSummary, 700)}`);
  if (latestLine && latestLine.length > latestSummary.length) {
    console.log(`- omitted previous verification history from an oversized ${latestLine.length.toLocaleString()} character line`);
  }
} else {
  console.log("- no Latest: line found in PROJECT_LOG.md Verification section");
}

console.log("\n## Next priorities");
printList(priorityLines);

console.log("\n## Context discipline reminders");
console.log("- Prefer this command over broad PROJECT_LOG.md reads at session start.");
console.log("- If more detail is needed, use `rg -n` to find a small range, then `read` that targeted range.");
console.log("- Avoid dumping full diffs/logs into the transcript; use `git diff --stat`, focused file diffs, or the iteration report selectors first.");
