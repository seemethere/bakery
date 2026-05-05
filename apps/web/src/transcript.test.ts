import { beforeAll, describe, expect, test } from "bun:test";
import { LEGACY_FULL_PLAN_ACTIONS_MARKER, LEGACY_PLAN_ACTIONS_MARKER } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "./transcript";

let PLAN_ACTIONS_MARKER: typeof import("./transcript").PLAN_ACTIONS_MARKER;
let renderTranscriptSegments: typeof import("./transcript").renderTranscriptSegments;
let mergeDuplicateDeveloperBash: typeof import("./transcript").mergeDuplicateDeveloperBash;
let hasPlanActionsMarker: typeof import("./transcript").hasPlanActionsMarker;
let isGeneratingPlanItem: typeof import("./transcript").isGeneratingPlanItem;
let renderPlanGeneratingCard: typeof import("./transcript").renderPlanGeneratingCard;
let renderPlanActionControls: typeof import("./transcript").renderPlanActionControls;
let renderAssistantStreamingPlaceholder: typeof import("./transcript").renderAssistantStreamingPlaceholder;
let stripPlanActionsMarker: typeof import("./transcript").stripPlanActionsMarker;
let uiActionContributionForTranscriptItem: typeof import("./transcript").uiActionContributionForTranscriptItem;
let toolHeaderDisplay: typeof import("./transcript").toolHeaderDisplay;
let compactToolSummary: typeof import("./transcript").compactToolSummary;
let shouldShowToolDuration: typeof import("./transcript").shouldShowToolDuration;
let pendingQuestionTranscriptItem: typeof import("./transcript").pendingQuestionTranscriptItem;
let isRenderableTranscriptItem: typeof import("./transcript").isRenderableTranscriptItem;
let hasSubagentCard: typeof import("./transcript").hasSubagentCard;
let renderSubagentCard: typeof import("./transcript").renderSubagentCard;
let messageToTranscriptItem: typeof import("./transcript").messageToTranscriptItem;
let shouldPatchStreamingText: typeof import("./transcript").shouldPatchStreamingText;
let streamingContentRenderKey: typeof import("./transcript").streamingContentRenderKey;
let streamingTextForTranscriptItem: typeof import("./transcript").streamingTextForTranscriptItem;
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
  ({ PLAN_ACTIONS_MARKER, renderTranscriptSegments, mergeDuplicateDeveloperBash, hasPlanActionsMarker, isGeneratingPlanItem, renderPlanGeneratingCard, renderPlanActionControls, renderAssistantStreamingPlaceholder, stripPlanActionsMarker, uiActionContributionForTranscriptItem, toolHeaderDisplay, compactToolSummary, shouldShowToolDuration, pendingQuestionTranscriptItem, isRenderableTranscriptItem, hasSubagentCard, renderSubagentCard, messageToTranscriptItem, shouldPatchStreamingText, streamingContentRenderKey, streamingTextForTranscriptItem } = await import("./transcript"));
  ({ extensionCardPayload } = await import("./extension-cards"));
});

describe("transcript terminal rendering", () => {
  test("uses live tool row ids for SDK toolResult messages with toolCallId", () => {
    const item = messageToTranscriptItem({
      role: "toolResult",
      toolCallId: "call_subagent_1",
      toolName: "subagent",
      content: [{ type: "text", text: "Done" }],
      details: { mode: "single", results: [{ agent: "worker", exitCode: 0 }] },
    }, "fallback");

    expect(item.id).toBe("tool:call_subagent_1");
    expect(hasSubagentCard(item)).toBe(true);
  });

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

  test("patches running stream text even when the previous text was empty", () => {
    expect(shouldPatchStreamingText("", true)).toBe(true);
    expect(shouldPatchStreamingText("hello", true)).toBe(true);
    expect(shouldPatchStreamingText("hello", false)).toBe(false);
    expect(shouldPatchStreamingText(null, true)).toBe(false);
  });

  test("keeps the stable streaming render key only for patchable text-only streams", () => {
    const textOnlyTool: TranscriptItem = {
      id: "tool-running",
      kind: "tool",
      title: "$ test",
      body: "",
      segments: [{ kind: "pre", text: "" }],
      status: "running",
    };
    const markdownTool: TranscriptItem = {
      id: "tool-markdown",
      kind: "tool",
      title: "read image",
      body: "![preview](artifact.png)",
      segments: [{ kind: "markdown", text: "![preview](artifact.png)" }],
      status: "running",
    };
    const mixedTool: TranscriptItem = {
      id: "tool-mixed",
      kind: "tool",
      title: "$ test",
      body: "stdout",
      segments: [{ kind: "pre", text: "stdout" }, { kind: "markdown", text: "![preview](artifact.png)" }],
      status: "running",
    };

    expect(streamingTextForTranscriptItem(textOnlyTool)).toBe("");
    expect(streamingContentRenderKey(textOnlyTool, "pre:")).toBe("streaming");
    expect(streamingTextForTranscriptItem(markdownTool)).toBe("");
    expect(streamingContentRenderKey(markdownTool, "markdown:![preview](artifact.png)")).toBe("![preview](artifact.png):markdown:![preview](artifact.png)");
    expect(streamingContentRenderKey(mixedTool, "pre:stdout|markdown:![preview](artifact.png)")).toBe("stdout:pre:stdout|markdown:![preview](artifact.png)");
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

  test("summarizes collapsed completed tool output", () => {
    expect(compactToolSummary({ id: "read", kind: "tool", title: "read PROJECT_LOG.md", body: "Latest: fixed live rows\nPrevious latest: removed scrollbar", status: "done" })).toBe("Latest: fixed live rows");
    expect(compactToolSummary({ id: "running", kind: "tool", title: "read PROJECT_LOG.md", body: "partial", status: "running" })).toBe("");
  });
});

describe("transcript subagent cards", () => {
  test("hides low-information management receipts instead of rendering Subagent Cards", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-management",
      kind: "tool",
      title: "subagent",
      body: "",
      status: "done",
      raw: {
        toolName: "subagent",
        result: {
          content: [{ type: "text", text: "Executable agents:\n- scout (builtin): Fast codebase recon\n- worker (builtin): Implementation agent" }],
          details: { mode: "Management" },
        },
      },
    };

    expect(hasSubagentCard(item)).toBe(false);
    expect(isRenderableTranscriptItem(item)).toBe(false);
    expect(renderTranscriptSegments(item, false)).not.toContain("subagent-card");
  });

  test("keeps meaningful management output renderable as a compact tool row", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-management-useful",
      kind: "tool",
      title: "subagent",
      body: "Installed 3 executable agents: planner, worker, reviewer",
      status: "done",
      raw: {
        toolName: "subagent",
        result: {
          content: [{ type: "text", text: "Installed 3 executable agents: planner, worker, reviewer" }],
          details: { mode: "Management" },
        },
      },
    };

    expect(hasSubagentCard(item)).toBe(false);
    expect(isRenderableTranscriptItem(item)).toBe(true);
    expect(renderTranscriptSegments(item, false)).not.toContain("subagent-card");
  });

  test("renders early non-management running calls as Subagent Cards", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-early",
      kind: "tool",
      title: "subagent",
      body: "Starting reviewer",
      status: "running",
      raw: {
        toolName: "subagent",
        args: { agent: "reviewer", task: "Review the diff" },
        partialResult: {
          details: { mode: "single" },
        },
      },
    };

    expect(hasSubagentCard(item)).toBe(true);
    expect(isRenderableTranscriptItem(item)).toBe(true);
    const html = renderTranscriptSegments(item, false);
    expect(html).toContain("subagent-card running");
    expect(html).toContain("reviewer");
    expect(html).toContain("Review the diff");
  });

  test("keeps management list calls out of full Subagent Cards while running", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-list-running",
      kind: "tool",
      title: "subagent",
      body: "Starting…",
      status: "running",
      raw: {
        toolName: "subagent",
        args: { action: "list" },
      },
    };

    expect(hasSubagentCard(item)).toBe(false);
    expect(renderTranscriptSegments(item, false)).not.toContain("subagent-card");
  });

  test("renders directive tasks as compact artifact activity", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-directive",
      kind: "tool",
      title: "subagent",
      body: "Scout is running",
      status: "running",
      raw: {
        toolName: "subagent",
        partialResult: {
          details: {
            mode: "chain",
            progress: [{ agent: "scout", status: "completed", task: "[Write to: /tmp/pi-subagents-uid-1000/chain-runs/57c06651/context.md]\n\nInvestigate the issue" }],
            results: [],
          },
        },
      },
    };

    const html = renderSubagentCard(item);

    expect(html).toContain("Writing context.md");
    expect(html).not.toContain("[Write to:");
    expect(html).not.toContain("/tmp/pi-subagents");
  });

  test("renders agent-specific running fallbacks instead of thinking", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-planner",
      kind: "tool",
      title: "subagent",
      body: "Planner is running",
      status: "running",
      raw: {
        toolName: "subagent",
        partialResult: {
          details: {
            mode: "chain",
            progress: [{ agent: "planner", status: "running", task: "Create the plan" }],
            results: [],
          },
        },
      },
    };

    const html = renderSubagentCard(item);

    expect(html).toContain("Drafting implementation plan");
    expect(html).not.toContain("thinking");
  });

  test("renders completed output paths as compact labels", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-compact-path",
      kind: "tool",
      title: "subagent",
      body: "done",
      status: "done",
      raw: {
        toolName: "subagent",
        result: {
          details: {
            mode: "chain",
            results: [{ agent: "planner", exitCode: 0, finalOutput: "Plan complete.", savedOutputPath: "/tmp/pi-subagents-uid-1000/chain-runs/57c06651/plan.md", sessionFile: "/home/bun/.pi/agent/sessions/2026-05-05T04-35-14-148Z_019df66b.jsonl" }],
          },
        },
      },
    };

    const html = renderSubagentCard(item);

    expect(html).toContain("output: plan.md");
    expect(html).toContain("session: 2026-05-05T04-35-14-148Z_019df66b.jsonl");
    expect(html).not.toContain("/tmp/pi-subagents");
    expect(html).not.toContain("/home/bun/.pi");
  });

  test("renders live foreground progress as a Subagent Card", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-1",
      kind: "tool",
      title: "subagent",
      body: "Reviewer is running",
      status: "running",
      raw: {
        toolName: "subagent",
        partialResult: {
          details: {
            mode: "single",
            progressSummary: { toolCount: 2, tokens: 1200, durationMs: 1500 },
            progress: [{ agent: "reviewer", status: "running", task: "Review the diff", currentTool: "read", currentPath: "apps/web/src/transcript.ts", toolCount: 2, tokens: 1200, durationMs: 1500 }],
            results: [],
          },
        },
      },
    };

    expect(hasSubagentCard(item)).toBe(true);
    const html = renderTranscriptSegments(item, false);

    expect(html).toContain("subagent-card running");
    expect(html).toContain("Subagent");
    expect(html).toContain("reviewer");
    expect(html).toContain("read");
    expect(html).toContain("2 tools");
  });

  test("renders final subagent results without raw JSON", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-2",
      kind: "tool",
      title: "subagent",
      body: "done",
      status: "done",
      raw: {
        toolName: "subagent",
        result: {
          content: [{ type: "text", text: "Full reviewer output" }],
          details: {
            mode: "single",
            progressSummary: { toolCount: 3, tokens: 2400, durationMs: 2500 },
            results: [{ agent: "reviewer", exitCode: 0, model: "fake/model", usage: { input: 1800, output: 600, turns: 2 }, finalOutput: "Approved the slice.", savedOutputPath: "/tmp/output.md" }],
          },
        },
      },
    };

    expect(hasSubagentCard(item)).toBe(true);
    const html = renderSubagentCard(item);

    expect(html).toContain("subagent-card completed");
    expect(html).toContain("Approved the slice.");
    expect(html).toContain("fake/model");
    expect(html).toContain("output: output.md");
    expect(html).not.toContain("/tmp/output.md");
    expect(html).not.toContain("&quot;results&quot;");
  });

  test("renders failed execution subagent tool results without detail rows as failed Subagent Cards", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-failed",
      kind: "tool",
      title: "subagent",
      body: "Failed",
      status: "done",
      raw: {
        toolName: "subagent",
        args: { agent: "scout", task: "Inspect the codebase" },
        result: { content: [{ type: "text", text: "Failed" }] },
      },
    };

    expect(hasSubagentCard(item)).toBe(true);
    const html = renderSubagentCard(item);

    expect(html).toContain("subagent-card failed");
    expect(html).toContain("scout");
    expect(html).toContain("Failed");
    expect(html).not.toContain("message-body");
  });

  test("keeps failed management list calls out of full Subagent Cards", () => {
    const item: TranscriptItem = {
      id: "tool:subagent-list-failed",
      kind: "tool",
      title: "subagent",
      body: "Failed",
      status: "done",
      raw: {
        toolName: "subagent",
        args: { action: "list" },
        result: { content: [{ type: "text", text: "Failed" }] },
      },
    };

    expect(hasSubagentCard(item)).toBe(false);
    expect(renderTranscriptSegments(item, false)).not.toContain("subagent-card");
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
        { id: "reject", label: "Reject plan", variant: "secondary" },
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
    expect(uiActionContributionForTranscriptItem(item)?.actions.map((action) => action.id)).toEqual(["accept", "reject"]);

    const fullLegacyItem: TranscriptItem = { ...item, body: `Recommendation\n\n${LEGACY_FULL_PLAN_ACTIONS_MARKER}` };
    expect(stripPlanActionsMarker(fullLegacyItem.body)).toBe("Recommendation");
    expect(uiActionContributionForTranscriptItem(fullLegacyItem)?.actions.map((action) => action.id)).toEqual(["accept", "reject"]);
  });

  test("renders /plan action controls for pending and completed local states", () => {
    const pending = renderPlanActionControls("assistant-plan");
    expect(pending).toContain("Accept plan");
    expect(pending).toContain('data-plan-action="accept"');
    expect(pending).toContain('data-plan-action="reject"');
    expect(pending).toContain('aria-label="Reject plan"');

    const accepted = renderPlanActionControls("assistant-plan", "accepted");
    expect(accepted).toContain("Accepted");
    expect(accepted).toContain('data-plan-outcome="accepted"');
    expect(accepted).toContain("disabled");
    expect(accepted).not.toContain('data-ui-action="accept"');

    const rejected = renderPlanActionControls("assistant-plan", "rejected");
    expect(rejected).toContain("Rejected");
    expect(rejected).toContain('data-plan-outcome="rejected"');
    expect(rejected).not.toContain('data-ui-action="reject"');

    const discussing = renderPlanActionControls("assistant-plan", "discussing");
    expect(discussing).toContain("Discussing");
    expect(discussing).toContain('data-plan-outcome="discussing"');
    expect(discussing).not.toContain('data-ui-action=');
  });
});

describe("extension card payload", () => {
  test("restores structured extension card payloads from snapshot web command messages", () => {
    const item = messageToTranscriptItem({
      role: "webCommandResult",
      id: "command:metadata",
      title: "/bakery:generate-details",
      body: "Updated title and summary.",
      isError: false,
      data: {
        kind: "extension_card",
        card: { kind: "bakery.metadataDetails", props: { applied: ["title"], title: "Details" } },
      },
      timestamp: "2026-05-03T00:00:00.000Z",
    }, "snapshot:command");

    expect(item.id).toBe("command:metadata");
    expect(item.title).toBe("/bakery:generate-details");
    expect(extensionCardPayload(item)).toMatchObject({ kind: "bakery.metadataDetails", props: { title: "Details" } });
  });

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
