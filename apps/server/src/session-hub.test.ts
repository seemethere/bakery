import { describe, expect, test } from "bun:test";
import { dataUrlToImageContent, mergeSnapshotMessagesWithWebCommands, parseNameCommand } from "./session-hub.js";

describe("parseNameCommand", () => {
  test("ignores non-name commands", () => {
    expect(parseNameCommand("hello /name test")).toEqual({ matched: false });
    expect(parseNameCommand("/namespace test")).toEqual({ matched: false });
  });

  test("matches title inspection", () => {
    expect(parseNameCommand("/name")).toEqual({ matched: true });
    expect(parseNameCommand("  /name   ")).toEqual({ matched: true });
  });

  test("matches title clearing", () => {
    expect(parseNameCommand("/name --clear")).toEqual({ matched: true, clear: true });
  });

  test("sanitizes manual titles", () => {
    expect(parseNameCommand("/name   A\nBetter\tTitle   ")).toEqual({ matched: true, title: "A Better Title" });
    const longTitle = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    expect(parseNameCommand(`/name ${longTitle}`)).toEqual({ matched: true, title: longTitle.slice(0, 120) });
  });
});

describe("dataUrlToImageContent", () => {
  test("parses supported image data URLs", () => {
    expect(dataUrlToImageContent("data:image/PNG;base64, YW Jj\n")).toEqual({ type: "image", mimeType: "image/png", data: "YWJj" });
  });

  test("rejects unsupported data URLs", () => {
    expect(() => dataUrlToImageContent("data:text/plain;base64,SGVsbG8=")).toThrow("Images must be png, jpeg, gif, or webp data URLs");
  });
});

describe("mergeSnapshotMessagesWithWebCommands", () => {
  test("interleaves persisted web command results between timestamped snapshot messages", () => {
    const messages = [
      { role: "user", id: "user-1", timestamp: "2026-05-03T00:00:00.000Z" },
      { role: "assistant", id: "assistant-1", timestamp: "2026-05-03T00:00:10.000Z" },
    ];

    const merged = mergeSnapshotMessagesWithWebCommands(messages, [{
      id: "command:metadata",
      title: "/bakery:generate-details",
      body: "Updated title and summary.",
      isError: false,
      data: { kind: "extension_card", card: { kind: "bakery.metadataDetails", props: { title: "Details" } } },
      timestamp: "2026-05-03T00:00:05.000Z",
    }]);

    expect(merged.map((message) => (message as { id: string }).id)).toEqual(["user-1", "command:metadata", "assistant-1"]);
    expect(merged[1]).toMatchObject({
      role: "webCommandResult",
      id: "command:metadata",
      title: "/bakery:generate-details",
      data: { kind: "extension_card" },
    });
  });

  test("keeps deterministic order for equal timestamps", () => {
    const merged = mergeSnapshotMessagesWithWebCommands([
      { role: "user", id: "user-1", timestamp: "2026-05-03T00:00:00.000Z" },
      { role: "assistant", id: "assistant-1", timestamp: "2026-05-03T00:00:00.000Z" },
    ], [
      { id: "command:a", title: "A", body: "A", isError: false, timestamp: "2026-05-03T00:00:00.000Z" },
      { id: "command:b", title: "B", body: "B", isError: false, timestamp: "2026-05-03T00:00:00.000Z" },
    ]);

    expect(merged.map((message) => (message as { id: string }).id)).toEqual(["user-1", "assistant-1", "command:a", "command:b"]);
  });

  test("falls back to append behavior when snapshot timestamps are unavailable", () => {
    const messages = [
      { role: "user", id: "user-1" },
      { role: "assistant", id: "assistant-1", timestamp: "2026-05-03T00:00:10.000Z" },
    ];

    const merged = mergeSnapshotMessagesWithWebCommands(messages, [{
      id: "command:metadata",
      title: "/bakery:generate-details",
      body: "Updated title and summary.",
      isError: false,
      timestamp: "2026-05-03T00:00:05.000Z",
    }]);

    expect(merged.map((message) => (message as { id: string }).id)).toEqual(["user-1", "assistant-1", "command:metadata"]);
  });
});
