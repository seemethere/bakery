import { beforeAll, describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./transcript";

let PLAN_ACTIONS_MARKER: typeof import("./transcript").PLAN_ACTIONS_MARKER;
let renderTranscriptSegments: typeof import("./transcript").renderTranscriptSegments;
let mergeDuplicateDeveloperBash: typeof import("./transcript").mergeDuplicateDeveloperBash;
let hasPlanActionsMarker: typeof import("./transcript").hasPlanActionsMarker;
let stripPlanActionsMarker: typeof import("./transcript").stripPlanActionsMarker;

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
  ({ PLAN_ACTIONS_MARKER, renderTranscriptSegments, mergeDuplicateDeveloperBash, hasPlanActionsMarker, stripPlanActionsMarker } = await import("./transcript"));
});

describe("transcript terminal rendering", () => {
  test("merges SDK bashExecution messages into the optimistic local bash row", () => {
    const previous: TranscriptItem = {
      id: "bash:local",
      kind: "tool",
      title: "$ lsd",
      body: "Starting…",
      segments: [{ kind: "pre", text: "Starting…" }],
      status: "running",
      raw: { type: "bash_execution_start", command: "lsd" },
    };
    const current: TranscriptItem = {
      id: "bashExecution:t1",
      kind: "tool",
      title: "$ lsd",
      body: "/bin/bash: lsd: command not found",
      segments: [{ kind: "pre", text: "/bin/bash: lsd: command not found" }],
      status: "error",
      raw: { role: "bashExecution", command: "lsd", exitCode: 127 },
    };

    expect(mergeDuplicateDeveloperBash(previous, current)).toBe(true);
    expect(previous).toMatchObject({
      id: "bash:local",
      title: "$ lsd",
      body: "/bin/bash: lsd: command not found",
      status: "error",
    });
  });

  test("renders ANSI color output as safe terminal HTML", () => {
    const item: TranscriptItem = {
      id: "tool-ansi",
      kind: "tool",
      title: "$ test",
      body: "\u001b[31mfailed <script>\u001b[0m ok",
      segments: [{ kind: "pre", text: "\u001b[31mfailed <script>\u001b[0m ok" }],
      status: "done",
    };

    const html = renderTranscriptSegments(item, false);

    expect(html).toContain("terminal-window");
    expect(html).toContain("color:#c91b00");
    expect(html).toContain("failed &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("\u001b[31m");
  });

  test("marks running tool output for text-only live patching", () => {
    const item: TranscriptItem = {
      id: "tool-running",
      kind: "tool",
      title: "$ test",
      body: "\u001b[31mstreaming <script>\u001b[0m",
      segments: [{ kind: "pre", text: "\u001b[31mstreaming <script>\u001b[0m" }],
      status: "running",
    };

    const html = renderTranscriptSegments(item, false);

    expect(html).toContain("tool-streaming-output");
    expect(html).toContain("streaming &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("\u001b[31m");
  });
});

describe("transcript plan actions", () => {
  test("detects and strips the final /plan action marker", () => {
    const item: TranscriptItem = {
      id: "assistant-plan",
      kind: "assistant",
      title: "Pi",
      body: `Recommendation\n\n${PLAN_ACTIONS_MARKER}`,
      status: "done",
    };

    expect(hasPlanActionsMarker(item)).toBe(true);
    expect(stripPlanActionsMarker(item.body)).toBe("Recommendation");
    expect(hasPlanActionsMarker({ ...item, kind: "user" })).toBe(false);
  });
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

  test("does not duplicate prompt attachment previews with generated artifact cards", () => {
    const item: TranscriptItem = {
      id: "user-image",
      kind: "user",
      title: "You",
      body: "Screenshot artifact: .bakery/artifacts/2026-04-27T21-27-49-984Z-image.png",
      segments: [
        { kind: "markdown", text: "Screenshot artifact: .bakery/artifacts/2026-04-27T21-27-49-984Z-image.png" },
        { kind: "image", label: "[image: image/png]", src: "data:image/png;base64,abc=" },
      ],
      status: "done",
    };

    const html = renderTranscriptSegments(item, false, {
      localImageUrl: (path) => `raw:${path}`,
    });

    expect(html).toContain('class="inline-image rendered-image"');
    expect(html).toContain('src="data:image/png;base64,abc="');
    expect(html).not.toContain("artifact-image-grid");
    expect(html).not.toContain('src="raw:.bakery/artifacts/2026-04-27T21-27-49-984Z-image.png"');
  });

  test("rewrites file URL markdown images through the local image resolver", () => {
    const item: TranscriptItem = {
      id: "assistant-file-image",
      kind: "assistant",
      title: "Pi",
      body: "![Remote browser screenshot](file:///remote/workspace/screenshots/fixture.png)",
      status: "done",
    };

    const html = renderTranscriptSegments(item, false, {
      localImageUrl: (path) => path === "file:///remote/workspace/screenshots/fixture.png" ? "raw:screenshots/fixture.png" : null,
    });

    expect(html).toContain('src="raw:screenshots/fixture.png"');
    expect(html).not.toContain('src="file:///remote/workspace/screenshots/fixture.png"');
    expect(html).not.toContain("artifact-image-grid");
  });

  test("renders absolute workspace image paths as artifact cards when the resolver accepts them", () => {
    const item: TranscriptItem = {
      id: "assistant-absolute-artifact",
      kind: "assistant",
      title: "Pi",
      body: "Screenshot: /remote/workspace/screenshots/fixture.png",
      status: "done",
    };

    const html = renderTranscriptSegments(item, false, {
      localImageUrl: (path) => path === "/remote/workspace/screenshots/fixture.png" ? "raw:screenshots/fixture.png" : null,
    });

    expect(html).toContain("artifact-image-grid");
    expect(html).toContain('src="raw:screenshots/fixture.png"');
    expect(html).toContain("/remote/workspace/screenshots/fixture.png");
  });
});
