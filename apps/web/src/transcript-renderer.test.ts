import { beforeAll, describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./transcript";

let renderHelpers: typeof import("./transcript-renderer");

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
  renderHelpers = await import("./transcript-renderer");
});

function item(partial: Partial<TranscriptItem> & Pick<TranscriptItem, "id" | "kind" | "title">): TranscriptItem {
  return { body: "", status: "done", ...partial };
}

describe("transcript renderer", () => {
  test("renders completed tool runs through the same activity component as running tools", () => {
    const transcript = [
      item({ id: "u1", kind: "user", title: "You", body: "hello" }),
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
      item({ id: "a1", kind: "assistant", title: "Pi", body: "done" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('data-transcript-id="u1"');
    expect(html).not.toContain("tool-run-group");
    expect(html).toContain('class="tool-activity-run"');
    expect(html).toContain('class="tool-activity-card"');
    expect(html).toContain('data-tool-activity-status="done"');
    expect(html).toContain("2s · 2 calls");
    expect(html).toContain('data-transcript-id="t1" data-tool-activity-member="activity:t1"');
    expect(html).toContain('data-transcript-id="t2" data-tool-activity-member="activity:t1"');
    expect(html).toContain('data-transcript-id="a1"');
  });

  test("completed tool duration is frozen instead of treated as active elapsed time", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
    ];

    expect(renderHelpers.latestGroupableToolGroupId(transcript)).toBeUndefined();
    const html = renderHelpers.renderTranscriptHtml(transcript, { nowMs: Date.parse("2026-04-27T00:00:05.000Z") });

    expect(html).toContain("2s · 2 calls");
    expect(html).not.toContain("5s · 2 calls");
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("renders one activity summary for the current running tool run", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read 1" }),
      item({ id: "t2", kind: "tool", title: "Read 2" }),
      item({ id: "t3", kind: "tool", title: "Read 3" }),
      item({ id: "t4", kind: "tool", title: "Read 4" }),
      item({ id: "t5", kind: "tool", title: "Read 5" }),
      item({ id: "t6", kind: "tool", title: "Read 6", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('class="tool-activity-run"');
    expect(html).toContain('class="tool-activity-card"');
    expect(html).toContain('data-tool-activity="activity:t1" data-tool-activity-ids="t1|t2|t3|t4|t5|t6"');
    expect(html).toContain('data-default-mode="summary-only"');
    expect(html).toContain('data-tool-activity-status="running"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Read 6");
    expect(html).toContain("6 calls");
    expect(html).not.toContain("Tool activity");
    expect(html).not.toContain("earlier");
    expect(html).toContain('data-transcript-id="t1" data-tool-activity-member="activity:t1"');
    expect(html).toContain('data-transcript-id="t6" data-tool-activity-member="activity:t1"');
  });

  test("builds one adaptive activity model for desktop and mobile", () => {
    const items = [
      item({ id: "t1", kind: "tool", title: "Read" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "running", startedAt: "2026-04-27T00:00:00.000Z" }),
    ];

    expect(renderHelpers.toolActivityRenderModel(items, { activeToolGroupId: "activity:t1", nowMs: Date.parse("2026-04-27T00:00:04.000Z") })).toEqual({
      id: "activity:t1",
      itemIds: ["t1", "t2"],
      title: "Bash",
      meta: "4s · 2 calls",
      label: "Bash",
      countLabel: "2 calls",
      durationLabel: "4s",
      currentLabel: "Bash",
      receiptLabel: "4s · 2 calls",
      failedLabel: "",
      status: "running",
      defaultMode: "summary-only",
    });
  });

  test("live activity duration follows the whole grouped activity run", () => {
    const items = [
      item({
        id: "old-read",
        kind: "tool",
        title: "Read old file",
        status: "done",
        startedAt: "2026-04-27T00:00:00.000Z",
        endedAt: "2026-04-27T00:00:00.500Z",
        durationMs: 500,
      }),
      item({
        id: "current-bash",
        kind: "tool",
        title: "Bash current command",
        status: "running",
        startedAt: "2026-04-27T00:01:00.000Z",
      }),
    ];

    const model = renderHelpers.toolActivityRenderModel(items, {
      activeToolGroupId: "activity:old-read",
      nowMs: Date.parse("2026-04-27T00:01:01.000Z"),
    });

    expect(model.durationLabel).toBe("1m 1s");
    expect(model.receiptLabel).toBe("1m 1s · 2 calls");
  });

  test("full render and timer patch summary use the same live activity receipt", () => {
    const items = [
      item({ id: "failed", kind: "tool", title: "Read failed", status: "error", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:01.000Z", durationMs: 1000 }),
      item({ id: "running", kind: "tool", title: "Bash running", status: "running", startedAt: "2026-04-27T00:00:10.000Z" }),
    ];
    const options = { activeToolGroupId: "activity:failed", nowMs: Date.parse("2026-04-27T00:00:12.000Z") };

    const model = renderHelpers.toolActivityRenderModel(items, options);
    const summary = renderHelpers.toolRunSummaryText(items, options);
    const html = renderHelpers.renderToolActivity(items, options);

    expect(summary.receiptLabel).toBe(model.receiptLabel);
    expect(summary.receiptLabel).toBe("12s · 2 calls · 1 failed");
    expect(html).toContain(">12s · 2 calls · 1 failed</span>");
    expect(html).not.toContain(">12s · 2 calls · 1 failed · Bash running</span>");
  });

  test("renders a single running tool with a stable activity id", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read", status: "running", startedAt: "2026-04-27T00:00:00.000Z" }),
    ];

    expect(renderHelpers.latestGroupableToolGroupId(transcript)).toBe("activity:t1");
    const html = renderHelpers.renderTranscriptHtml(transcript, { activeToolGroupId: "activity:t1", nowMs: Date.parse("2026-04-27T00:00:03.000Z") });

    expect(html).toContain('data-tool-activity="activity:t1" data-tool-activity-ids="t1"');
    expect(html).not.toContain("Read");
    expect(html).toContain("3s · 1 call");
    expect(html).toContain('data-transcript-id="t1" data-tool-activity-member="activity:t1"');
  });

  test("keeps the activity id stable as tools are appended", () => {
    const first = [item({ id: "t1", kind: "tool", title: "Read", status: "running" })];
    const second = [item({ id: "t1", kind: "tool", title: "Read" }), item({ id: "t2", kind: "tool", title: "Bash", status: "running" })];

    expect(renderHelpers.latestGroupableToolGroupId(first)).toBe("activity:t1");
    expect(renderHelpers.latestGroupableToolGroupId(second)).toBe("activity:t1");
    const html = renderHelpers.renderTranscriptHtml(second);
    expect(html).toContain('data-tool-activity="activity:t1" data-tool-activity-ids="t1|t2"');
    expect(html).not.toContain("Bash");
  });

  test("preserves expanded tool activity state across transcript rerenders", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read" }),
      item({ id: "t2", kind: "tool", title: "Bash" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, { expandedToolActivityIds: new Set(["activity:t1"]) });

    expect(html).toContain('class="tool-activity-run expanded"');
    expect(html).toContain('data-tool-activity-expanded="true"');
    expect(html).toContain('aria-expanded="true"');
  });

  test("keeps developer bash outside activity summaries", () => {
    const transcript = [
      item({ id: "bash:local", kind: "tool", title: "$ pwd", status: "running" }),
      item({ id: "single", kind: "tool", title: "Read" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('data-transcript-id="bash:local"');
    expect(html).toContain('data-tool-activity="activity:single"');
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("summarizes failed tools in the same activity strip", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read", status: "error" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('class="tool-activity-card"');
    expect(html).toContain('data-tool-activity-status="running"');
    expect(html).toContain("2 calls");
    expect(html).toContain("1 failed");
    expect(html).toContain('data-transcript-id="t1" data-tool-activity-member="activity:t1"');
    expect(html).toContain('data-transcript-id="t2" data-tool-activity-member="activity:t1"');
  });

  test("keeps completed image tools behind the same expandable activity summary", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls" }),
      item({ id: "image", kind: "tool", title: "read screenshots/fixture.png", segments: [{ kind: "image", label: "image", src: "data:image/png;base64,abc=" }] }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-run-group");
    expect(html).toContain('data-tool-activity="activity:t1"');
    expect(html).toContain('data-transcript-id="t1" data-tool-activity-member="activity:t1"');
    expect(html).toContain('data-transcript-id="image" data-tool-activity-member="activity:t1"');
  });

  test("keeps tool rows visually flat without adjacent grouping positions", () => {
    const transcript = [
      item({ id: "running", kind: "tool", title: "Bash", status: "running" }),
      item({ id: "done1", kind: "tool", title: "Read" }),
      item({ id: "done2", kind: "tool", title: "Write" }),
      item({ id: "user", kind: "user", title: "You" }),
    ];

    expect(renderHelpers.isAfterRunningTool(transcript, transcript[1]!)).toBe(false);
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[1]!)).toBe("single");
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[2]!)).toBe("single");
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[3]!)).toBe("single");
  });

  test("keeps explicit expansion defaults for system, bash, running, and error rows", () => {
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "system", kind: "system", title: "System" }))).toBe(true);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "bash:1", kind: "tool", title: "$ test" }))).toBe(true);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "running", kind: "tool", title: "Read", status: "running" }))).toBe(false);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "question", kind: "tool", title: "Question", status: "running" }))).toBe(false);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "failed-tool", kind: "tool", title: "Bash", status: "error" }))).toBe(false);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "error", kind: "assistant", title: "Pi", status: "error" }))).toBe(true);
  });
});
