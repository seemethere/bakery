import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { MetadataStore } from "./metadata-store.js";

describe("MetadataStore workspaces", () => {
  test("persists managed workspaces with upserted labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      store.addWorkspace({ path: "/repo/z", label: "Zed" });
      store.addWorkspace({ path: "/repo/a", label: "Alpha" });
      store.addWorkspace({ path: "/repo/z", label: "Zed renamed" });

      expect(store.listWorkspaces()).toEqual([
        { path: "/repo/a", label: "Alpha" },
        { path: "/repo/z", label: "Zed renamed" },
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("deletes approved workspaces without deleting sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: "/repo/a", piSessionFile: join(dir, "session.jsonl") });
      store.addWorkspace({ path: "/repo/a", label: "Alpha" });

      expect(store.deleteWorkspace("/repo/a")).toBe(true);
      expect(store.listWorkspaces()).toEqual([]);
      expect(store.getSession(session.id)).toMatchObject({ id: session.id, cwd: "/repo/a" });
      expect(store.deleteWorkspace("/repo/a")).toBe(false);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("attaching a workspace promotes draft sessions to workspace sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({
        id: "draft-1",
        cwd: null,
        piSessionFile: join(dir, "session.jsonl"),
        kind: "draft",
      });

      const updated = store.attachWorkspace(session.id, dir);

      expect(updated).toMatchObject({ id: session.id, kind: "workspace", cwd: dir });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe("MetadataStore app settings", () => {
  test("persists default model selections", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));

      expect(store.getSettings()).toMatchObject({
        autoGenerateSessionMetadata: true,
        sessionMetadataModel: null,
        defaultSessionModel: null,
      });

      expect(store.updateSettings({ defaultSessionModel: { model: "anthropic/claude-sonnet-4-5" } })).toMatchObject({
        defaultSessionModel: { model: "anthropic/claude-sonnet-4-5" },
      });
      expect(store.updateSettings({ defaultSessionModel: null })).toMatchObject({ defaultSessionModel: null });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MetadataStore submitted prompt receipts", () => {
  test("stores pending receipts and reconciles the oldest matching prompt by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakery-metadata-store-"));
    try {
      const store = new MetadataStore(join(dir, "metadata.sqlite"));
      const session = store.createSession({ id: "session-1", cwd: null, kind: "chat_only", piSessionFile: join(dir, "session.jsonl") });
      const first = store.addSubmittedPrompt(session.id, { id: "prompt:1", kind: "prompt", text: "hello", timestamp: "2026-05-03T00:00:00.000Z" });
      store.addSubmittedPrompt(session.id, { id: "prompt:2", kind: "ask", text: "why?", timestamp: "2026-05-03T00:00:01.000Z" });

      expect(store.listUnreconciledSubmittedPrompts(session.id).map((record) => record.id)).toEqual(["prompt:1", "prompt:2"]);
      expect(store.markSubmittedPromptReconciled(session.id, first.id, "2026-05-03T00:00:02.000Z")).toMatchObject({ id: "prompt:1", reconciledAt: "2026-05-03T00:00:02.000Z" });
      expect(store.listUnreconciledSubmittedPrompts(session.id).map((record) => record.id)).toEqual(["prompt:2"]);
      expect(store.markSubmittedPromptError(session.id, "prompt:2", "model unavailable")).toMatchObject({ id: "prompt:2", error: "model unavailable" });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
