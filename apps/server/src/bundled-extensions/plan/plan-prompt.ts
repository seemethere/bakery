import { PLAN_ACTIONS_MARKER } from "@pi-web-agent/protocol";

export type PlanWorkflowSkill = {
  name: string;
  description: string;
  argumentHint?: string;
  sourceInfo: {
    kind: "bundled-workflow-skill";
    package: "bakery";
  };
  buildPrompt(args: string): string;
};

export function planPrompt(args: string): string {
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
    "- For this repository, prefer running bun run project:notes first, then reading DESIGN.md and targeted PROJECT_LOG.md ranges before recommending next work.",
    "- Discover domain documentation before asking documentation or terminology questions: look for CONTEXT-MAP.md, CONTEXT.md, docs/adr/, CONTEXT-FORMAT.md, and ADR-FORMAT.md.",
    "- If a CONTEXT-MAP.md exists, use it to find the relevant context-specific CONTEXT.md and docs/adr/ directory; otherwise treat the root CONTEXT.md and docs/adr/ as the default context.",
    "- If the operator asks what's next or to continue planning, follow the repository dev loop: summarize the top 1-3 candidate next slices in priority order, recommend one small default slice, then clarify only what is needed.",
    "",
    "Subagent-assisted planning discipline:",
    "- When the `subagent` tool is available and the planning uncertainty is non-trivial, prefer using it for bounded read-only reconnaissance that would otherwise consume parent context or make operator questions less concrete.",
    "- Prefer one direct foreground `subagent(...)` tool call by default, usually a `scout` or `context-builder` child for local codebase context; escalate to `researcher`, `oracle`, or parallel children only when external facts, architectural risk, or broad scope justify it.",
    "- Ask child agents for concise evidence, risks, likely files, and candidate operator questions; do not ask them to edit files, run implementation, or own the final plan.",
    "- The parent Agent Session remains responsible for synthesis, all `ask_question` checkpoints, and the final Plan Card response; do not delegate the interactive interview to a child session.",
    "- Use synchronous foreground subagent runs by default so the parent can synthesize before asking or finishing; avoid async/background subagents unless explicitly requested.",
    "- If the `subagent` tool is unavailable, continue the normal codebase inspection and one-question-at-a-time `/plan` flow without treating that as a failure.",
    "",
    "Domain-doc grilling behavior:",
    "- Challenge terminology against the existing glossary immediately: if CONTEXT.md defines a term differently from the operator's usage, call out the conflict and ask which meaning should win.",
    "- Sharpen fuzzy or overloaded language by proposing precise canonical terms tied to the repository's domain model.",
    "- Stress-test domain relationships with concrete scenarios and edge cases before treating a term or decision as resolved.",
    "- Cross-reference operator claims with code and project notes when possible; surface contradictions instead of asking the operator to restate facts the repository can answer.",
    "- When a domain term is resolved, update the relevant CONTEXT.md inline using CONTEXT-FORMAT.md; create CONTEXT.md lazily only when there is a concrete term to record.",
    "- Keep CONTEXT.md domain-focused: do not add implementation trivia, task lists, verification history, or source-file inventories.",
    "- Offer or create an ADR only when the decision is hard to reverse, surprising without context, and tradeoff-driven; use ADR-FORMAT.md and the relevant docs/adr/ directory.",
    "- Do not batch resolved documentation updates until the end when an inline CONTEXT.md or ADR update would preserve shared language or rationale more accurately.",
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
    "- Include any CONTEXT.md or ADR updates made during the interview, and call out any documentation updates intentionally deferred.",
    "- Use these exact level-2 headings in the final plan so Bakery can render the Plan Card: `## Plan summary`, `## Smallest next slice`, `## Key files likely to change`, `## Validation plan`, and `## Full plan`.",
    "- Keep the Plan summary to 1-2 sentences and the Smallest next slice concise; put detailed rationale, tradeoffs, and sequencing under Full plan.",
    "- The Plan Card will carry Accept Plan; do not add a Back to chat action because the normal composer remains available.",
    `- End the final plan summary with this exact standalone line so Bakery can render the Plan Card: ${PLAN_ACTIONS_MARKER}`, 
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

export const PLAN_WORKFLOW_SKILL: PlanWorkflowSkill = {
  name: "plan",
  description: "Plan the next coding slice through a one-question-at-a-time codebase and domain-doc interview",
  argumentHint: "[topic or goal]",
  sourceInfo: { kind: "bundled-workflow-skill", package: "bakery" },
  buildPrompt: planPrompt,
};
