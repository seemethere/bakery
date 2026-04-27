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

function grillMePrompt(args: string): string {
  const focus = args.trim();
  return [
    "Run the bundled `grill-me` skill for this coding session.",
    "",
    "Goal: interview the operator to clarify the next useful implementation slice, architecture decision, or codebase understanding gap.",
    focus ? `Operator-provided focus: ${focus}` : "Operator-provided focus: general project/codebase review.",
    "",
    "Instructions:",
    "- Inspect the codebase and current project notes when that would make your questions more concrete.",
    "- Use the `ask_question` tool for each question instead of writing plain-text questions in the transcript.",
    "- Ask exactly one concise question at a time, then wait for the answer before asking another.",
    "- Include a recommended answer whenever it helps the operator decide quickly.",
    "- When useful, offer 2-4 short selectable options plus custom-answer support.",
    "- Keep the interview practical and tied to the current repository; avoid broad generic coaching.",
    "- After enough answers, summarize the recommendation and propose the smallest next vertical slice with a validation plan.",
  ].join("\n");
}

export const WORKFLOW_SKILLS: WorkflowSkill[] = [
  {
    name: "grill-me",
    description: "Start a one-question-at-a-time codebase interview using ask_question",
    argumentHint: "[topic or goal]",
    sourceInfo: { kind: "bundled-workflow-skill", package: "bakery" },
    buildPrompt: grillMePrompt,
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
