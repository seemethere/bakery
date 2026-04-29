import { resolve } from "node:path";
import { allScenarios } from "./scenarios/names";

export const root = resolve(import.meta.dir, "../..");
export const scenario = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "streaming-responsiveness";
export const scenarios = scenario === "all" ? [...allScenarios] : [scenario];
export const keep = process.argv.includes("--keep");
export const headed = process.argv.includes("--headed") || scenario === "manual";
export const interactive = scenario === "manual" || process.argv.includes("--interactive");
export const serverPort = Number(process.env.PI_WEB_HARNESS_SERVER_PORT ?? "43141");
export const webPort = Number(process.env.PI_WEB_HARNESS_WEB_PORT ?? "45173");
export const apiBase = `http://127.0.0.1:${serverPort}`;
export const webBase = `http://127.0.0.1:${webPort}`;
export const runId = new Date().toISOString().replace(/[:.]/g, "-");
export const artifactDir = resolve(root, "test-results", "ui-harness", `${scenario}-${runId}`);
export const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l2Y9WQAAAABJRU5ErkJggg==";
export const verboseChildLogs = process.env.PI_WEB_HARNESS_CHILD_LOGS === "1" || process.argv.includes("--verbose");
