import type { CommandInfo } from "@pi-web-agent/protocol";

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
    "Goal: interview the operator to clarify the next useful implementation slice, architecture decision, or codebase understanding gap.",
    focus ? `Operator-provided focus: ${focus}` : "Operator-provided focus: general project/codebase review.",
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
    "- Include a recommended answer whenever it helps the operator decide quickly.",
    "- When useful, offer 2-4 short selectable options plus custom-answer support, and set recommendedOptionIndex when recommending one of the options.",
    "- Keep the interview practical and tied to the current repository; avoid broad generic coaching.",
    "",
    "Finish:",
    "- After enough answers, stop interviewing and summarize the recommendation.",
    "- Propose the smallest next vertical slice, name the key files likely to change, and include a validation plan with exact commands/harness scenarios when practical.",
  ].join("\n");
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
