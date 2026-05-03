import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MetadataStore } from "./metadata-store.js";

describe("MetadataStore web command results", () => {
  test("persists extension card command results for session refresh snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: dir, piSessionFile: join(dir, "session.jsonl") });
      store.addWebCommandResult(session.id, {
        id: "command:metadata",
        title: "/bakery:generate-details",
        body: "Updated title and summary.",
        data: { kind: "extension_card", card: { kind: "bakery.metadataDetails", props: { title: "Details" } } },
        timestamp: "2026-05-03T00:00:00.000Z",
      });

      expect(store.listWebCommandResults(session.id)).toEqual([
        {
          id: "command:metadata",
          title: "/bakery:generate-details",
          body: "Updated title and summary.",
          isError: false,
          data: { kind: "extension_card", card: { kind: "bakery.metadataDetails", props: { title: "Details" } } },
          timestamp: "2026-05-03T00:00:00.000Z",
        },
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
