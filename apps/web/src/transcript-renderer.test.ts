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
  test("renders completed tool calls as flat transcript rows", () => {
    const transcript = [
      item({ id: "u1", kind: "user", title: "You", body: "hello" }),
      item({ id: "t1", kind: "tool", title: "$ ls", startedAt: "2026-04-27T00:00:00.000Z", endedAt: "2026-04-27T00:00:00.400Z", durationMs: 400 }),
      item({ id: "t2", kind: "tool", title: "Read", startedAt: "2026-04-27T00:00:00.500Z", endedAt: "2026-04-27T00:00:01.500Z", durationMs: 1000 }),
      item({ id: "a1", kind: "assistant", title: "Pi", body: "done" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-activity");
    expect(html).toContain('data-transcript-id="u1"');
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t2"');
    expect(html).toContain('data-transcript-id="a1"');
    expect(html.match(/data-transcript-id=/g)?.length).toBe(4);
  });

  test("renders running tools as normal transcript rows", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read", status: "running", startedAt: "2026-04-27T00:00:00.000Z" }),
      item({ id: "t2", kind: "tool", title: "Bash", status: "running", startedAt: "2026-04-27T00:00:01.000Z" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-activity");
    expect(html).not.toContain("tool-activity-card");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="t2"');
    expect(html.match(/data-transcript-id=/g)?.length).toBe(2);
  });

  test("does not encode derived tool group ids in transcript shell html", () => {
    const transcript = [
      item({ id: "t1", kind: "tool", title: "Read" }),
      item({ id: "image", kind: "tool", title: "read screenshots/fixture.png", segments: [{ kind: "image", label: "image", src: "data:image/png;base64,abc=" }] }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("activity:");
    expect(html).not.toContain("data-tool-activity-member");
    expect(html).toContain('data-transcript-id="t1"');
    expect(html).toContain('data-transcript-id="image"');
  });

  test("keeps developer bash as a plain row without grouping metadata", () => {
    const transcript = [
      item({ id: "bash:local", kind: "tool", title: "$ pwd", status: "running" }),
      item({ id: "single", kind: "tool", title: "Read" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript);

    expect(html).not.toContain("tool-activity");
    expect(html).toContain('data-transcript-id="bash:local"');
    expect(html).toContain('data-transcript-id="single"');
  });

  test("keeps failed tools collapsed by default", () => {
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "failed-tool", kind: "tool", title: "Bash", status: "error" }))).toBe(false);
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
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "error", kind: "assistant", title: "Pi", status: "error" }))).toBe(true);
  });
});
