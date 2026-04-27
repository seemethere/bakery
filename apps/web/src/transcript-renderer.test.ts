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
      item({ id: "t1", kind: "tool", title: "$ ls" }),
      item({ id: "t2", kind: "tool", title: "Read" }),
      item({ id: "a1", kind: "assistant", title: "Pi", body: "done" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set(["t1|t2"]));

    expect(html).toContain('data-transcript-id="u1"');
    expect(html).toContain('class="tool-run-group"');
    expect(html).toContain('data-tool-run-group="t1|t2" open');
    expect(html).toContain("Ran 2 tools");
    expect(html).toContain("ls · Read");
    expect(html).toContain('data-transcript-id="a1"');
  });

  test("does not group running, developer bash, image, or single tool rows", () => {
    const transcript = [
      item({ id: "running", kind: "tool", title: "Running", status: "running" }),
      item({ id: "bash:local", kind: "tool", title: "$ pwd" }),
      item({ id: "image", kind: "tool", title: "Screenshot", segments: [{ kind: "image", label: "image", src: "data:image/png;base64,abc=" }] }),
      item({ id: "single", kind: "tool", title: "Read" }),
    ];

    const html = renderHelpers.renderTranscriptHtml(transcript, new Set());

    expect(html).not.toContain("tool-run-group");
    expect(html.match(/data-transcript-id=/g)?.length).toBe(4);
  });

  test("calculates tool grouping positions and running adjacency", () => {
    const transcript = [
      item({ id: "running", kind: "tool", title: "Bash", status: "running" }),
      item({ id: "done1", kind: "tool", title: "Read" }),
      item({ id: "done2", kind: "tool", title: "Write" }),
      item({ id: "user", kind: "user", title: "You" }),
    ];

    expect(renderHelpers.isAfterRunningTool(transcript, transcript[1]!)).toBe(true);
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[1]!)).toBe("start");
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[2]!)).toBe("end");
    expect(renderHelpers.toolGroupPositionFor(transcript, transcript[3]!)).toBe("single");
  });

  test("keeps explicit expansion defaults for system, bash, running, and error rows", () => {
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "system", kind: "system", title: "System" }))).toBe(true);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "bash:1", kind: "tool", title: "$ test" }))).toBe(true);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "running", kind: "tool", title: "Read", status: "running" }))).toBe(true);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "question", kind: "tool", title: "Question", status: "running" }))).toBe(false);
    expect(renderHelpers.defaultTranscriptExpanded(item({ id: "error", kind: "assistant", title: "Pi", status: "error" }))).toBe(true);
  });
});
