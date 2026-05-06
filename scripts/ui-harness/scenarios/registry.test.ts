import { describe, expect, test } from "bun:test";
import { scenarioDefinitions } from "./metadata";
import { allScenarios } from "./names";
import { scenarioRunners } from "./registry";

describe("UI harness scenario registry", () => {
  test("registers exactly one runner for every scenario definition", () => {
    const definedNames = scenarioDefinitions.map((definition) => definition.name).sort();
    const runnerNames = Object.keys(scenarioRunners).sort();

    expect(runnerNames).toEqual(definedNames);
    expect(new Set(definedNames).size).toBe(definedNames.length);
  });

  test("derives all-scenario runs from metadata while excluding opt-out scenarios", () => {
    const expectedAllScenarios = scenarioDefinitions
      .filter((definition) => definition.includeInAll !== false)
      .map((definition) => definition.name);

    expect(allScenarios).toEqual(expectedAllScenarios);
    expect(allScenarios).not.toContain("connection-disconnected");
  });
});
