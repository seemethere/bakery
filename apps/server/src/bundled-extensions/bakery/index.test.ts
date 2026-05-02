import { describe, expect, test } from "bun:test";
import { parseGenerateDetailsArgs } from "./index.js";

describe("parseGenerateDetailsArgs", () => {
  test("parses guidance text", () => {
    expect(parseGenerateDetailsArgs("emphasize extension architecture")).toEqual({ replaceManual: false, guidance: "emphasize extension architecture" });
  });

  test("parses replace flag separately from guidance", () => {
    expect(parseGenerateDetailsArgs("--replace emphasize metadata command")).toEqual({ replaceManual: true, guidance: "emphasize metadata command" });
  });

  test("omits empty guidance", () => {
    expect(parseGenerateDetailsArgs(" --replace  ")).toEqual({ replaceManual: true });
  });
});
