import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
