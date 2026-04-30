import type { BakeryExtension } from "../../extensions.js";
import { PLAN_WORKFLOW_SKILL } from "./plan-prompt.js";

export const PLAN_BUNDLED_EXTENSION: BakeryExtension = {
  id: "bakery.workflow",
  displayName: "Bakery workflow commands",
  version: "0.1.0",
  capabilities: ["commands"],
  commands: [
    {
      name: PLAN_WORKFLOW_SKILL.name,
      description: PLAN_WORKFLOW_SKILL.description,
      ...(PLAN_WORKFLOW_SKILL.argumentHint ? { argumentHint: PLAN_WORKFLOW_SKILL.argumentHint } : {}),
      source: "skill",
      sourceInfo: PLAN_WORKFLOW_SKILL.sourceInfo,
      handler: (_ctx, args) => ({
        kind: "launchPrompt",
        title: `/${PLAN_WORKFLOW_SKILL.name}`,
        prompt: PLAN_WORKFLOW_SKILL.buildPrompt(args),
      }),
    },
  ],
};
