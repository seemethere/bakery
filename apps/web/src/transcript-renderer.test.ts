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
  test("groups adjacent completed non-image tool rows", () => {
    const transcript = [
      item({ id: "u1", kind: "user", title: "You", body: "hello" }),
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
      item({ id: "a1", kind: "assistant", title: "Pi", body: "done" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set(["t1|t2"]));

    expect(html).toContain('data-transcript-id="u1"');
    expect(html).toContain('class="tool-run-group"');
    expect(html).toContain('data-tool-run-group="t1|t2" open');
    expect(html).toContain("Ran 2 tools");
    expect(html).toContain("1.5s");
    expect(html).toContain(">Read</span>");
    expect(html).toContain('data-transcript-id="a1"');
  });

  test("uses wall-clock elapsed time for the active tool group", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
    ];

    expect(renderHelpers.latestGroupableToolGroupId(transcript)).toBe("t1|t2");
    const html = renderHelpers.renderTranscriptHtml(transcript, new Set(), { activeToolGroupId: "t1|t2", nowMs: Date.parse("2026-04-27T00:00:05.000Z") });

    expect(html).toContain("Ran 2 tools");
    expect(html).toContain("5s");
  });

  test("groups live tools around the current tool with only the five most recent receipts", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read 1" }),
      item({ id: "t2", kind: "tool", title: "Read 2" }),
      item({ id: "t3", kind: "tool", title: "Read 3" }),
      item({ id: "t4", kind: "tool", title: "Read 4" }),
      item({ id: "t5", kind: "tool", title: "Read 5" }),
      item({ id: "t6", kind: "tool", title: "Read 6", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set());

    expect(html).toContain('class="tool-run-group live-tool-stack"');
    expect(html).toContain('data-tool-run-group="t1|t2|t3|t4|t5|t6" data-live-tool-stack="true" open');
    expect(html).toContain("Running Read 6");
    expect(html).toContain("6 tools");
    expect(html).not.toContain("Tool activity");
    expect(html).toContain("1 earlier");
    expect(html).not.toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t2"');
    expect(html).toContain('data-transcript-id="t6"');
  });

  test("renders live tool groups compact when requested", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "running" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set(), { compactLiveToolGroups: true });

    expect(html).toContain('data-live-tool-stack="true" ');
    expect(html).not.toContain('data-live-tool-stack="true" open');
    expect(html).toContain("Running Bash");
  });

  test("keeps developer bash and single tools outside live grouping", () => {
    const transcript = [
      item({ id: "bash:local", kind: "tool", title: "$ pwd" }),
      item({ id: "single", kind: "tool", title: "Read" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set());

    expect(html).not.toContain("tool-run-group");
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("keeps failed tools quiet in completed groups", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "error" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set());

    expect(html).toContain('class="tool-run-group"');
    expect(html).not.toContain("live-tool-stack");
    expect(html).not.toContain("failed</em>");
    expect(html).toContain('tool-run-stack-slot tool-run-stack-slot-2 failed');
  });

  test("groups completed image tools with adjacent background tools", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "$ ls" }),
      item({ id: "image", kind: "tool", title: "read screenshots/fixture.png", segments: [{ kind: "image", label: "image", src: "data:image/png;base64,abc=" }] }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set());

    expect(html).toContain('class="tool-run-group"');
    expect(html).toContain('data-tool-run-group="t1|image"');
  });

  test("calculates tool grouping positions and running adjacency", () => {
    const transcript = [
      item({ id: "running", kind: "tool", title: "Bash", status: "running" }),
      item({ id: "done1", kind: "tool", title: "Read" }),
      item({ id: "done2", kind: "tool", title: "Write" }),
      item({ id: "user", kind: "user", title: "You" }),
    ];

    expect(renderHelpers.isAfterRunningTool(transcript, transcript[1]!)).toBe(true);
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[1]!)).toBe("middle");
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[2]!)).toBe("end");
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
