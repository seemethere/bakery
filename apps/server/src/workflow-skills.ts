import type { CommandInfo } from "@pi-web-agent/protocol";
import { compactWorkflowLaunchText, PLAN_WORKFLOW_SKILL, type PlanWorkflowSkill } from "./bundled-extensions/plan/plan-prompt.js";

export type WorkflowSkill = PlanWorkflowSkill;

export { compactWorkflowLaunchText };

export const WORKFLOW_SKILLS: WorkflowSkill[] = [PLAN_WORKFLOW_SKILL];

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
