import { PLAN_ACTIONS_MARKER, type CommandInfo } from "@pi-web-agent/protocol";

export type WorkflowSkill = {
  name: string;
  description: string;
  argumentHint?: string;
  sourceInfo: {
    kind: "bundled-workflow-skill";
    package: "bakery";
  };
  buildPrompt(args: string): string;
};

function planPrompt(args: string): string {
  const focus = args.trim();
  return [
    "Run the bundled `plan` workflow skill for this coding session.",
    "",
    "Goal: interview the operator relentlessly about a plan, design, next implementation slice, architecture decision, or codebase understanding gap until shared understanding is reached.",
    focus ? `Operator-provided focus: ${focus}` : "Operator-provided focus: general project/codebase review.",
    "",
    "Canonical grill-me behavior:",
    "- Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.",
    "- Stress-test fuzzy goals, hidden assumptions, risks, tradeoffs, and sequencing before recommending implementation.",
    "- If a question can be answered by exploring the codebase or project notes, explore instead of asking the operator.",
    "- Continue the interview until the remaining uncertainty no longer changes the recommended slice.",
    "",
    "Context discipline:",
    "- Inspect the codebase and current project notes before asking when that would make your question more concrete.",
    "- For this repository, prefer reading DESIGN.md and PROJECT_LOG.md before recommending next work.",
    "- If the operator asks what's next or to continue planning, follow the repository dev loop: summarize the top 1-3 candidate next slices in priority order, recommend one small default slice, then clarify only what is needed.",
    "",
    "Question discipline:",
    "- Use the ask_question tool for each question instead of writing plain-text questions in the transcript.",
    "- Ask exactly one concise question at a time, then wait for the answer before asking another.",
    "- Do not ask multi-part questions; split decisions into separate questions only if the answer changes the implementation slice.",
    "- For each question, provide your recommended answer.",
    "- When useful, offer 2-4 short selectable options plus custom-answer support, and set recommendedOptionIndex when recommending one of the options.",
    "- Keep the interview practical, pointed, and tied to the current repository; avoid broad generic coaching.",
    "",
    "Finish:",
    "- After enough answers, stop interviewing and summarize the shared understanding and recommendation.",
    "- Propose the smallest next vertical slice, name the key files likely to change, and include a validation plan with exact commands/harness scenarios when practical.",
    `- End the final plan summary with this exact standalone line so Bakery can render mobile-friendly inline actions: ${PLAN_ACTIONS_MARKER}`,
  ].join("\n");
}

export function compactWorkflowLaunchText(text: string, maxLength = 160): string | null {
  const workflowMatch = /^Run the bundled `([^`]+)` workflow skill for this coding session\./m.exec(text);
  if (!workflowMatch) return null;
  const command = workflowMatch[1] ?? "workflow";
  const focusMatch = /^Operator-provided focus:\s*(.+)$/m.exec(text);
  const focus = focusMatch?.[1]?.replace(/\s+/g, " ").trim();
  const summary = [`Launched /${command} workflow`, focus ? `Focus: ${focus}` : ""].filter(Boolean).join(" · ");
  return summary.slice(0, maxLength);
}

export const WORKFLOW_SKILLS: WorkflowSkill[] = [
  {
    name: "plan",
    description: "Plan the next coding slice through a one-question-at-a-time codebase interview",
    argumentHint: "[topic or goal]",
    sourceInfo: { kind: "bundled-workflow-skill", package: "bakery" },
    buildPrompt: planPrompt,
  },
];

export const WORKFLOW_SKILL_COMMANDS: CommandInfo[] = WORKFLOW_SKILLS.map((skill) => ({
  name: skill.name,
  description: skill.description,
  argumentHint: skill.argumentHint,
  source: "skill",
  sourceInfo: skill.sourceInfo,
}));

const workflowSkillsByName = new Map(WORKFLOW_SKILLS.map((skill) => [skill.name, skill]));

export function getWorkflowSkill(name: string): WorkflowSkill | undefined {
  return workflowSkillsByName.get(name);
}

export function isWorkflowSkillCommand(name: string): boolean {
  return workflowSkillsByName.has(name);
}
