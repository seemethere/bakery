import { beforeAll, describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./transcript";

let renderTranscriptSegments: typeof import("./transcript").renderTranscriptSegments;

beforeAll(async () => {
  Object.defineProperty(globalThis, "HTMLElement", {
    value: class HTMLElement {},
    configurable: true,
  });
  Object.defineProperty(globalThis, "customElements", {
    value: { define: () => undefined },
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { location: { href: "http://127.0.0.1:5173/" } },
    configurable: true,
  });
  ({ renderTranscriptSegments } = await import("./transcript"));
});

describe("transcript image rendering", () => {
  test("rewrites workspace-relative markdown images to local raw file URLs without duplicate artifact cards", () => {
    const item: TranscriptItem = {
      id: "assistant-image",
      kind: "assistant",
      title: "Pi",
      body: "![Connected hidden banner](test-results/ui-harness/run/final.png)",
      status: "done",
    };

    const html = renderTranscriptSegments(item, false, {
      localImageUrl: (path) => `http://127.0.0.1:3141/api/sessions/session-1/files/raw?path=${encodeURIComponent(path)}`,
    });

    expect(html).toContain("/api/sessions/session-1/files/raw?path=test-results%2Fui-harness%2Frun%2Ffinal.png");
    expect(html).toContain('alt="Connected hidden banner"');
    expect(html).not.toContain('src="test-results/ui-harness/run/final.png"');
    expect(html).not.toContain("artifact-image-grid");
  });

  test("still renders bare workspace image paths as artifact cards", () => {
    const item: TranscriptItem = {
      id: "assistant-artifact",
      kind: "assistant",
      title: "Pi",
      body: "Screenshot: test-results/ui-harness/run/final.png",
      status: "done",
    };

    const html = renderTranscriptSegments(item, false, {
      localImageUrl: (path) => `raw:${path}`,
    });

    expect(html).toContain("artifact-image-grid");
    expect(html).toContain('src="raw:test-results/ui-harness/run/final.png"');
  });
});
