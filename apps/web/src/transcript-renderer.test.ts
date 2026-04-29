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
  test("renders completed tool rows flat instead of nesting them in groups", () => {
    const transcript = [
      item({ id: "u1", kind: "user", title: "You", body: "hello" }),
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
      item({ id: "a1", kind: "assistant", title: "Pi", body: "done" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('data-transcript-id="u1"');
    expect(html).not.toContain("tool-run-group");
    expect(html).not.toContain("tool-activity-strip");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t2"');
    expect(html).toContain('data-transcript-id="a1"');
  });

  test("does not treat completed tools as an active elapsed group", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
    ];

    expect(renderHelpers.latestGroupableToolGroupId(transcript)).toBeUndefined();
    const html = renderHelpers.renderTranscriptHtml(transcript, { nowMs: Date.parse("2026-04-27T00:00:05.000Z") });

    expect(html).not.toContain("Ran 2 tools");
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("renders one flat activity strip for the current running tool run", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read 1" }),
      item({ id: "t2", kind: "tool", title: "Read 2" }),
      item({ id: "t3", kind: "tool", title: "Read 3" }),
      item({ id: "t4", kind: "tool", title: "Read 4" }),
      item({ id: "t5", kind: "tool", title: "Read 5" }),
      item({ id: "t6", kind: "tool", title: "Read 6", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('class="tool-activity-strip"');
    expect(html).toContain('data-tool-activity="activity:t1" data-tool-activity-ids="t1|t2|t3|t4|t5|t6"');
    expect(html).toContain("Running Read 6");
    expect(html).toContain("6 tools");
    expect(html).not.toContain("Tool activity");
    expect(html).not.toContain("earlier");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t6"');
  });

  test("renders a single running tool with a stable activity id", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read", status: "running", startedAt: "2026-04-27T00:00:00.000Z" }),
    ];

    expect(renderHelpers.latestGroupableToolGroupId(transcript)).toBe("activity:t1");
    const html = renderHelpers.renderTranscriptHtml(transcript, { activeToolGroupId: "activity:t1", nowMs: Date.parse("2026-04-27T00:00:03.000Z") });

    expect(html).toContain('data-tool-activity="activity:t1" data-tool-activity-ids="t1"');
    expect(html).toContain("Running Read");
    expect(html).toContain("1 tool · 3s");
    expect(html).toContain('data-transcript-id="t1"');
  });

  test("keeps the activity id stable as tools are appended", () => {
    const first = [item({ id: "t1", kind: "tool", title: "Read", status: "running" })];
    const second = [item({ id: "t1", kind: "tool", title: "Read" }), item({ id: "t2", kind: "tool", title: "Bash", status: "running" })];

    expect(renderHelpers.latestGroupableToolGroupId(first)).toBe("activity:t1");
    expect(renderHelpers.latestGroupableToolGroupId(second)).toBe("activity:t1");
    expect(renderHelpers.renderTranscriptHtml(second)).toContain("Running Bash");
  });

  test("keeps developer bash outside activity summaries", () => {
    const transcript = [
      item({ id: "bash:local", kind: "tool", title: "$ pwd", status: "running" }),
      item({ id: "single", kind: "tool", title: "Read" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-activity-strip");
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("summarizes failed tools in an active flat activity strip", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read", status: "error" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).toContain('class="tool-activity-strip"');
    expect(html).toContain("2 tools");
    expect(html).toContain("1 failed");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t2"');
  });

  test("renders completed image tools as flat rows", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls" }),
      item({ id: "image", kind: "tool", title: "read screenshots/fixture.png", segments: [{ kind: "image", label: "image", src: "data:image/png;base64,abc=" }] }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-run-group");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="image"');
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
