import { describe, expect, test } from "bun:test";
import { dataUrlToImageContent, parseNameCommand } from "./session-hub.js";

describe("parseNameCommand", () => {
  test("ignores non-name commands", () => {
    expect(parseNameCommand("hello /name test")).toEqual({ matched: false });
    expect(parseNameCommand("/namespace test")).toEqual({ matched: false });
  });

  test("matches title inspection", () => {
    expect(parseNameCommand("/name")).toEqual({ matched: true });
    expect(parseNameCommand("  /name   ")).toEqual({ matched: true });
  });

  test("matches title clearing", () => {
    expect(parseNameCommand("/name --clear")).toEqual({ matched: true, clear: true });
  });

  test("sanitizes manual titles", () => {
    expect(parseNameCommand("/name   A\nBetter\tTitle   ")).toEqual({ matched: true, title: "A Better Title" });
    const longTitle = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    expect(parseNameCommand(`/name ${longTitle}`)).toEqual({ matched: true, title: longTitle.slice(0, 120) });
  });
});

describe("dataUrlToImageContent", () => {
  test("parses supported image data URLs", () => {
    expect(dataUrlToImageContent("data:image/PNG;base64, YW Jj\n")).toEqual({ type: "image", mimeType: "image/png", data: "YWJj" });
  });

  test("rejects unsupported data URLs", () => {
    expect(() => dataUrlToImageContent("data:text/plain;base64,SGVsbG8=")).toThrow("Images must be png, jpeg, gif, or webp data URLs");
  });
});
