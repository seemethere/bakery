---
name: dev-loop-plan
description: Start-of-slice Bakery dev-loop planning chain with a gated implementation handoff
---

## scout
output: dev-loop-scout.md
outputMode: file-only

Map the local Bakery context for this requested start-of-slice plan:

{task}

Read compact project notes first, then inspect only the design/docs/code areas needed to make the plan concrete. Return concise evidence, likely files, constraints, risks, and remaining uncertainties. Do not edit files or create handoff files in the repository workspace; saved output belongs only in the chain artifact directory.

## context-builder
output: dev-loop-context.md
outputMode: file-only

Using the scout result below, build validation and implementation-context guidance for the requested slice.

Scout result:
{previous}

Include repository dev-loop rules, focused validation recommendations, relevant telemetry/report commands, likely harness scenarios, and risks. Do not edit files or create handoff files in the repository workspace; saved output belongs only in the chain artifact directory.

## planner

Using the prior context, produce a gated implementation-ready plan for:

{task}

Prior context:
{previous}

The plan must stop before edits. Include smallest slice, non-goals, key files, validation commands, and a copyable follow-up prompt for a worker/parent implementation turn. Make clear that implementation requires explicit operator or parent approval after this chain completes. Do not edit files or create handoff files in the repository workspace; use only the chain artifact directory for any saved output.
