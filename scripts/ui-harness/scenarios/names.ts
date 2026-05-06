import { scenarioDefinitions, type RegisteredHarnessScenarioName } from "./metadata";

export const allScenarios = scenarioDefinitions
  .filter((definition) => definition.includeInAll !== false)
  .map((definition) => definition.name);

export type HarnessScenarioName = RegisteredHarnessScenarioName | "manual";
