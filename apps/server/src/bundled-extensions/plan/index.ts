import type { BakeryExtension } from "../../extensions.js";
import { resolvePlanChain } from "./plan-chain-config.js";
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
      handler: (ctx, args) => {
        const chain = resolvePlanChain({
          cwd: ctx.services?.getSessionCwd?.(),
          hasPiSubagents: ctx.services?.hasCommand ? ctx.services.hasCommand("run-chain") || ctx.services.hasCommand("subagents-doctor") : undefined,
        });
        const chainConfig = chain.kind === "resolved"
          ? { kind: "resolved" as const, source: chain.source, chainName: chain.chainName, recipe: chain.recipe }
          : chain.kind === "warning"
            ? { kind: "warning" as const, source: chain.source, chainName: chain.chainName, reason: chain.reason }
            : { kind: "none" as const };
        return {
          kind: "launchPrompt",
          title: `/${PLAN_WORKFLOW_SKILL.name}`,
          prompt: PLAN_WORKFLOW_SKILL.buildPrompt(args, chainConfig),
        };
      },
    },
  ],
};
