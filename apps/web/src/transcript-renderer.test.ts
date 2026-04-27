import { describe, expect, test } from "bun:test";
import { defaultTranscriptExpanded, isAfterRunningTool, renderTranscriptHtml, toolGroupPositionFor } from "./transcript-renderer";
import type { TranscriptItem } from "./transcript";

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

    const html = renderTranscriptHtml(transcript, new Set(["t1|t2"]));

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

    const html = renderTranscriptHtml(transcript, new Set());

    expect(html).not.toContain("tool-run-group");
    expect(html.match(/pi-transcript-row/g)?.length).toBe(4);
  });

  test("calculates tool grouping positions and running adjacency", () => {
    const transcript = [
      item({ id: "running", kind: "tool", title: "Bash", status: "running" }),
      item({ id: "done1", kind: "tool", title: "Read" }),
      item({ id: "done2", kind: "tool", title: "Write" }),
      item({ id: "user", kind: "user", title: "You" }),
    ];

    expect(isAfterRunningTool(transcript, transcript[1]!)).toBe(true);
    expect(toolGroupPositionFor(transcript, transcript[1]!)).toBe("start");
    expect(toolGroupPositionFor(transcript, transcript[2]!)).toBe("end");
    expect(toolGroupPositionFor(transcript, transcript[3]!)).toBe("single");
  });

  test("keeps explicit expansion defaults for system, bash, running, and error rows", () => {
    expect(defaultTranscriptExpanded(item({ id: "system", kind: "system", title: "System" }))).toBe(true);
    expect(defaultTranscriptExpanded(item({ id: "bash:1", kind: "tool", title: "$ test" }))).toBe(true);
    expect(defaultTranscriptExpanded(item({ id: "running", kind: "tool", title: "Read", status: "running" }))).toBe(true);
    expect(defaultTranscriptExpanded(item({ id: "question", kind: "tool", title: "Question", status: "running" }))).toBe(false);
    expect(defaultTranscriptExpanded(item({ id: "error", kind: "assistant", title: "Pi", status: "error" }))).toBe(true);
  });
});
