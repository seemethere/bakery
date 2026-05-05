import { readFileSync } from "node:fs";
import { BUNDLED_EXTENSIONS, getBakeryExtensionCommands, runBundledExtensionCommand } from "../apps/server/src/extensions.js";
import { compactWorkflowLaunchText } from "../apps/server/src/workflow-skills.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bundledWorkflowExtension = BUNDLED_EXTENSIONS.find((extension) => extension.id === "bakery.workflow");
assert(bundledWorkflowExtension, "expected bundled workflow extension to be registered");
assert(bundledWorkflowExtension.capabilities?.includes("commands"), "expected bundled workflow extension to declare command capability");

const bundledCommands = getBakeryExtensionCommands();
const commands = bundledCommands.map((command) => command.name);
assert(commands.includes("plan"), "expected /plan bundled extension command to be registered");
assert(!commands.includes("grill-me"), "expected /grill-me workflow skill command to be removed");

const planCommand = bundledCommands.find((command) => command.name === "plan");
assert(planCommand?.source === "skill", "expected /plan to preserve its current slash autocomplete source");
assert(planCommand.sourceInfo && typeof planCommand.sourceInfo === "object", "expected /plan to preserve source info");

const planResult = await runBundledExtensionCommand("plan", "what should be next?");
assert(planResult?.kind === "launchPrompt", "expected /plan bundled extension command to launch a prompt");
const prompt = planResult.prompt;
const requiredSnippets = [
  "Run the bundled `plan` workflow skill",
  "Operator-provided focus: what should be next?",
  "bun run project:notes first",
  "DESIGN.md and targeted PROJECT_LOG.md ranges",
  "CONTEXT-MAP.md, CONTEXT.md, docs/adr/, CONTEXT-FORMAT.md, and ADR-FORMAT.md",
  "interview the operator relentlessly",
  "shared understanding is reached",
  "Walk down each branch of the design tree",
  "resolving dependencies between decisions one-by-one",
  "If a question can be answered by exploring the codebase or project notes, explore instead of asking",
  "top 1-3 candidate next slices",
  "Subagent-assisted planning discipline",
  "When the `subagent` tool is available",
  "bounded read-only reconnaissance",
  "one direct foreground `subagent(...)` tool call by default",
  "`scout` or `context-builder` child",
  "do not ask them to edit files, run implementation",
  "synchronous foreground subagent runs by default",
  "The parent Agent Session remains responsible",
  "all `ask_question` checkpoints",
  "do not delegate the interactive interview to a child session",
  "If the `subagent` tool is unavailable",
  "Challenge terminology against the existing glossary immediately",
  "Sharpen fuzzy or overloaded language",
  "Stress-test domain relationships with concrete scenarios",
  "Cross-reference operator claims with code and project notes",
  "update the relevant CONTEXT.md inline using CONTEXT-FORMAT.md",
  "create CONTEXT.md lazily only when there is a concrete term to record",
  "hard to reverse, surprising without context, and tradeoff-driven",
  "use ADR-FORMAT.md and the relevant docs/adr/ directory",
  "Do not batch resolved documentation updates until the end",
  "Use the ask_question tool",
  "Ask exactly one concise question at a time",
  "Do not ask multi-part questions",
  "For each question, provide your recommended answer",
  "2-4 short selectable options",
  "recommendedOptionIndex",
  "Include any CONTEXT.md or ADR updates made during the interview",
  "Smallest next slice",
  "exact level-2 headings in the final plan",
  "## Plan summary",
  "## Full plan",
  "normal composer remains available",
  "Plan actions: Accept plan",
];

for (const snippet of requiredSnippets) {
  assert(prompt.includes(snippet), `expected /plan prompt to include: ${snippet}`);
}

const defaultResult = await runBundledExtensionCommand("plan", "   ");
assert(defaultResult?.kind === "launchPrompt", "expected default /plan command to launch a prompt");
const defaultPrompt = defaultResult.prompt;
assert(defaultPrompt.includes("Operator-provided focus: general project/codebase review."), "expected default focus copy");

assert(compactWorkflowLaunchText(prompt) === "Launched /plan workflow · Focus: what should be next?", "expected compact /plan launch summary");
assert(compactWorkflowLaunchText("ordinary prompt") === null, "expected non-workflow prompts to stay unchanged");

const agentGuidance = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const localSkill = readFileSync(new URL("../.pi/skills/iteration-observability/SKILL.md", import.meta.url), "utf8");
const guidanceSnippets = [
  "bun run report:iteration --agent-actions --recommend",
  "bun run report:iteration --recommend <changed files>",
  "validation actions to run or skip",
  "high-churn files",
  "recurring hot-path harness scenarios",
  "missing telemetry",
  "Treat full `bun run test:web-perf` as an explicit escalation",
  "focused-first command list",
  "## Validation decision",
  "full suite was run or intentionally skipped",
  "bun run report:iteration --session-context",
  "bun run report:iteration --session-history",
  ".pi/skills/iteration-observability/SKILL.md",
  "per-tool result payload size",
];

for (const snippet of guidanceSnippets) {
  assert(agentGuidance.includes(snippet), `expected AGENTS.md to include iteration telemetry guidance: ${snippet}`);
}

const localSkillSnippets = [
  "name: iteration-observability",
  "bun run report:iteration --session-context",
  "bun run report:iteration --session-history",
  "Validation command summary",
  "Edit/write attempts",
  "Do not print raw prompts",
  "Recommendation format",
];

for (const snippet of localSkillSnippets) {
  assert(localSkill.includes(snippet), `expected iteration-observability skill to include: ${snippet}`);
}

console.log("workflow skill assertions passed");
