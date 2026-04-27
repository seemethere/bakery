import { readFileSync } from "node:fs";
import { compactWorkflowLaunchText, getWorkflowSkill, WORKFLOW_SKILL_COMMANDS } from "../apps/server/src/workflow-skills.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const commands = WORKFLOW_SKILL_COMMANDS.map((command) => command.name);
assert(commands.includes("plan"), "expected /plan workflow skill command to be registered");
assert(!commands.includes("grill-me"), "expected /grill-me workflow skill command to be removed");

const plan = getWorkflowSkill("plan");
assert(plan, "expected plan workflow skill to be retrievable");

const prompt = plan.buildPrompt("what should be next?");
const requiredSnippets = [
  "Run the bundled `plan` workflow skill",
  "Operator-provided focus: what should be next?",
  "DESIGN.md and PROJECT_LOG.md",
  "top 1-3 candidate next slices",
  "Use the ask_question tool",
  "Ask exactly one concise question at a time",
  "Do not ask multi-part questions",
  "2-4 short selectable options",
  "recommendedOptionIndex",
  "smallest next vertical slice",
  "validation plan with exact commands/harness scenarios",
];

for (const snippet of requiredSnippets) {
  assert(prompt.includes(snippet), `expected /plan prompt to include: ${snippet}`);
}

const defaultPrompt = plan.buildPrompt("   ");
assert(defaultPrompt.includes("Operator-provided focus: general project/codebase review."), "expected default focus copy");

assert(compactWorkflowLaunchText(prompt) === "Launched /plan workflow · Focus: what should be next?", "expected compact /plan launch summary");
assert(compactWorkflowLaunchText("ordinary prompt") === null, "expected non-workflow prompts to stay unchanged");

const agentGuidance = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const guidanceSnippets = [
  "bun run report:iteration --agent-actions --recommend",
  "bun run report:iteration --recommend <changed files>",
  "validation actions to run or skip",
  "high-churn files",
  "recurring hot-path harness scenarios",
  "missing telemetry",
  "Escalate to `bun run test:web-perf`",
  "## Validation decision",
  "full suite was run or intentionally skipped",
  "bun run report:iteration --session-context",
  "per-tool result payload size",
];

for (const snippet of guidanceSnippets) {
  assert(agentGuidance.includes(snippet), `expected AGENTS.md to include iteration telemetry guidance: ${snippet}`);
}

console.log("workflow skill assertions passed");
