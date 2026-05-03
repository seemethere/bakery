import { beforeAll, describe, expect, test } from "bun:test";
import { LEGACY_FULL_PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "./transcript";

let PLAN_ACTIONS_MARKER: typeof import("./transcript").PLAN_ACTIONS_MARKER;
let renderTranscriptSegments: typeof import("./transcript").renderTranscriptSegments;
let mergeDuplicateDeveloperBash: typeof import("./transcript").mergeDuplicateDeveloperBash;
let hasPlanActionsMarker: typeof import("./transcript").hasPlanActionsMarker;
let isGeneratingPlanItem: typeof import("./transcript").isGeneratingPlanItem;
let renderPlanGeneratingCard: typeof import("./transcript").renderPlanGeneratingCard;
let renderAssistantStreamingPlaceholder: typeof import("./transcript").renderAssistantStreamingPlaceholder;
let stripPlanActionsMarker: typeof import("./transcript").stripPlanActionsMarker;
let uiActionContributionForTranscriptItem: typeof import("./transcript").uiActionContributionForTranscriptItem;
let toolHeaderDisplay: typeof import("./transcript").toolHeaderDisplay;
let shouldShowToolDuration: typeof import("./transcript").shouldShowToolDuration;
let pendingQuestionTranscriptItem: typeof import("./transcript").pendingQuestionTranscriptItem;
let isRenderableTranscriptItem: typeof import("./transcript").isRenderableTranscriptItem;
let extensionCardPayload: typeof import("./extension-cards").extensionCardPayload;

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
  ({ PLAN_ACTIONS_MARKER, renderTranscriptSegments, mergeDuplicateDeveloperBash, hasPlanActionsMarker, isGeneratingPlanItem, renderPlanGeneratingCard, renderAssistantStreamingPlaceholder, stripPlanActionsMarker, uiActionContributionForTranscriptItem, toolHeaderDisplay, shouldShowToolDuration, pendingQuestionTranscriptItem, isRenderableTranscriptItem } = await import("./transcript"));
  ({ extensionCardPayload } = await import("./extension-cards"));
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

describe("transcript tool row display", () => {
  test("derives structured action-first headers for common tool titles", () => {
    expect(toolHeaderDisplay({ id: "bash", kind: "tool", title: "$ bun run check", body: "", status: "done" })).toEqual({ action: "bash", target: "bun run check" });
    expect(toolHeaderDisplay({ id: "read", kind: "tool", title: "read apps/web/src/transcript.ts", body: "", status: "done" })).toEqual({ action: "read", target: "apps/web/src/transcript.ts" });
    expect(toolHeaderDisplay({ id: "edit", kind: "tool", title: "edit PROJECT_LOG.md", body: "", status: "done" })).toEqual({ action: "edit", target: "PROJECT_LOG.md" });
    expect(toolHeaderDisplay({ id: "question", kind: "tool", title: "Question", body: "", status: "running" })).toEqual({ action: "question", target: "operator input" });
  });

  test("prefers raw tool args when available", () => {
    expect(toolHeaderDisplay({ id: "raw", kind: "tool", title: "Tool", body: "", status: "done", raw: { toolName: "read", args: { path: "DESIGN.md" } } })).toEqual({ action: "read", target: "DESIGN.md" });
    expect(toolHeaderDisplay({ id: "ask", kind: "tool", title: "Question", body: "", status: "running", raw: { toolName: "ask_question", args: { question: "Proceed?" } } })).toEqual({ action: "question", target: "Proceed?" });
  });

  test("shows collapsed tool durations only when noteworthy", () => {
    expect(shouldShowToolDuration({ id: "fast", kind: "tool", title: "read file", body: "", status: "done", durationMs: 999 }, true)).toBe(false);
    expect(shouldShowToolDuration({ id: "slow", kind: "tool", title: "read file", body: "", status: "done", durationMs: 1000 }, true)).toBe(true);
    expect(shouldShowToolDuration({ id: "expanded", kind: "tool", title: "read file", body: "", status: "done", durationMs: 20 }, false)).toBe(true);
  });
});

describe("transcript question cards", () => {
  test("renders pending questions as compact answer cards", () => {
    const item = pendingQuestionTranscriptItem({
      id: "q1",
      question: "Proceed?",
      options: [{ label: "Yes" }],
      allowCustomAnswer: true,
      createdAt: "2026-05-02T00:00:00.000Z",
    }, { isController: true, isConnected: true });

    const html = renderTranscriptSegments(item, false);

    expect(html).toContain("question-card pending");
    expect(html).toContain("Answer needed");
    expect(html).toContain("Proceed?");
    expect(html).toContain("Yes");
  });

  test("hides the underlying ask_question tool card", () => {
    expect(isRenderableTranscriptItem({ id: "ask", kind: "tool", title: "Question", body: "", status: "running", raw: { toolName: "ask_question", args: { question: "Proceed?" } } })).toBe(false);
  });
});

describe("transcript plan actions", () => {
  test("detects running final /plan output as a generating plan", () => {
    const item: TranscriptItem = {
      id: "assistant-plan-running",
      kind: "assistant",
      title: "Pi",
      body: "## Plan summary\n\nRecommendation is still streaming",
      status: "running",
    };

    expect(isGeneratingPlanItem(item)).toBe(true);
    expect(isGeneratingPlanItem({ ...item, body: "I need one more detail before planning." })).toBe(false);
    expect(isGeneratingPlanItem({ ...item, status: "done" })).toBe(false);
    expect(isGeneratingPlanItem({ ...item, body: `${item.body}\n\n${PLAN_ACTIONS_MARKER}` })).toBe(false);
    expect(isGeneratingPlanItem({ ...item, body: "", segments: [{ kind: "markdown", text: item.body }] })).toBe(true);
  });

  test("renders running final /plan output as a generating Plan Card", () => {
    const html = renderPlanGeneratingCard();

    expect(html).toContain("plan-card generating");
    expect(html).toContain("aria-label=\"Generating plan\"");
    expect(html).toContain("plan-card-spinner");
    expect(html).toContain("Generating Plan");
    expect(html).not.toContain(">Generating</span>");
  });

  test("renders normal running assistant output as a generic streaming placeholder", () => {
    const item: TranscriptItem = {
      id: "assistant-running",
      kind: "assistant",
      title: "Pi",
      body: "## Raw heading\n\n- raw streamed list item",
      segments: [{ kind: "markdown", text: "## Raw heading\n\n- raw streamed list item" }],
      status: "running",
    };

    const html = renderTranscriptSegments(item, false);

    expect(html).toContain("assistant-streaming-placeholder");
    expect(html).toContain("assistant-streaming-spinner");
    expect(html).toContain("aria-label=\"Assistant response generating\"");
    expect(html).toContain("Pi is responding…");
    expect(html).not.toContain("Raw heading");
    expect(html).not.toContain("raw streamed list item");
    expect(html).not.toContain("plan-card");
    expect(renderAssistantStreamingPlaceholder()).toContain("assistant-streaming-spinner");
  });

  test("renders completed assistant markdown normally", () => {
    const html = renderTranscriptSegments({
      id: "assistant-done",
      kind: "assistant",
      title: "Pi",
      body: "## Rendered heading\n\n- rendered list item",
      status: "done",
    }, false);

    expect(html).toContain("<h2>Rendered heading</h2>");
    expect(html).toContain("rendered list item");
    expect(html).not.toContain("Pi is responding…");
  });

  test("detects and strips the final /plan action marker", () => {
    const item: TranscriptItem = {
      id: "assistant-plan",
      kind: "assistant",
      title: "Pi",
      body: `## Plan summary\n\nRecommendation\n\n${PLAN_ACTIONS_MARKER}`,
      status: "done",
    };

    expect(hasPlanActionsMarker(item)).toBe(true);
    expect(stripPlanActionsMarker(item.body)).toBe("## Plan summary\n\nRecommendation");
    expect(uiActionContributionForTranscriptItem(item)).toMatchObject({
      id: "bakery.workflow.plan.actions",
      placement: "composer_takeover",
      source: { extensionId: "bakery.workflow", commandName: "plan" },
      actions: [
        { id: "accept", label: "Accept plan", variant: "primary" },
      ],
    });
    expect(hasPlanActionsMarker({ ...item, kind: "user" })).toBe(false);
    expect(uiActionContributionForTranscriptItem({ ...item, kind: "user" })).toBeNull();
  });

  test("keeps legacy /plan markers compatible with typed actions", () => {
    const item: TranscriptItem = {
      id: "assistant-plan-legacy",
      kind: "assistant",
      title: "Pi",
      body: `Recommendation\n\n${LEGACY_PLAN_ACTIONS_MARKER}`,
      status: "done",
    };

    expect(stripPlanActionsMarker(item.body)).toBe("Recommendation");
    expect(uiActionContributionForTranscriptItem(item)?.actions.map((action) => action.id)).toEqual(["accept"]);

    const fullLegacyItem: TranscriptItem = { ...item, body: `Recommendation\n\n${LEGACY_FULL_PLAN_ACTIONS_MARKER}` };
    expect(stripPlanActionsMarker(fullLegacyItem.body)).toBe("Recommendation");
    expect(uiActionContributionForTranscriptItem(fullLegacyItem)?.actions.map((action) => action.id)).toEqual(["accept"]);
  });
});

describe("extension card payload", () => {
  test("extracts structured extension card payloads", () => {
    const item: TranscriptItem = {
      id: "command:metadata",
      kind: "system",
      title: "/bakery:generate-details",
      body: "Updated title and summary.",
      raw: {
        type: "web_command_result",
        data: {
          kind: "extension_card",
          card: {
            kind: "bakery.metadataDetails",
            props: {
              applied: ["title", "summary"],
              skipped: [],
              title: "Add generate details command",
              summary: "Implemented metadata generation command.",
            },
          },
        },
      },
    };

    expect(extensionCardPayload(item)).toMatchObject({
      kind: "bakery.metadataDetails",
      props: {
        applied: ["title", "summary"],
        title: "Add generate details command",
        summary: "Implemented metadata generation command.",
      },
    });
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
