import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { NormalizedAgentEvent, ServerEnvelope, WebSession } from "@pi-web-agent/protocol";
import { activeToolCallId, activeToolSnapshotFromEvent, attachmentPathsFromText, dataUrlToImageContent, mergeSnapshotMessagesWithWebCommands, parseNameCommand, SessionHub } from "./session-hub.js";

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

describe("attachmentPathsFromText", () => {
  test("finds unique Bakery attachment references in prompt context", () => {
    const path = ".bakery/attachments/2026-05-10T00-00-00-000Z-shot.png";
    expect(attachmentPathsFromText(`Please inspect this.\n\nAttached files:\n- shot.png: ${path}\n- duplicate: ${path}`)).toEqual([path]);
  });
});

function webSession(overrides: Partial<WebSession> = {}): WebSession {
  return {
    id: "s1",
    kind: "workspace",
    cwd: "/repo",
    piSessionFile: "/repo/.pi/sessions/s1.jsonl",
    isolationKind: "none",
    sourceCwd: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseCommit: null,
    worktreeSourceDirty: false,
    reviewStatus: null,
    reviewUpdatedAt: null,
    title: null,
    titleSource: "unset",
    summary: null,
    summarySource: "unset",
    summaryUpdatedAt: null,
    metadataGenerationCount: 0,
    metadataLastGeneratedAt: null,
    autoGenerateMetadataOverride: "default",
    pinned: false,
    createdAt: "2026-05-05T00:00:00.000Z",
    lastOpenedAt: "2026-05-05T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("mergeSnapshotMessagesWithWebCommands", () => {
  test("adds unreconciled submitted prompts without duplicating official user messages", () => {
    const merged = mergeSnapshotMessagesWithWebCommands([
      { role: "user", id: "official", content: [{ type: "text", text: "already official" }], timestamp: "2026-05-03T00:00:01.000Z" },
    ], [], [
      { id: "prompt:1", kind: "prompt", text: "pending prompt", timestamp: "2026-05-03T00:00:00.000Z", reconciledAt: null, error: null },
      { id: "prompt:2", kind: "prompt", text: "already official", timestamp: "2026-05-03T00:00:02.000Z", reconciledAt: null, error: null },
    ]);

    expect(merged.map((message) => (message as { id: string }).id)).toEqual(["prompt:1", "official"]);
    expect(merged[0]).toMatchObject({ role: "user", webSubmittedPrompt: true, content: [{ type: "text", text: "pending prompt" }] });
  });

  test("deduplicates submitted ask prompts against the expanded pi prompt", () => {
    const merged = mergeSnapshotMessagesWithWebCommands([
      { role: "user", id: "official", content: [{ type: "text", text: "Answer the following operator question directly.\nTreat this as an ask/explain turn: do not edit files, run shell commands, or call tools unless the operator explicitly asks you to.\n\nwhat is this?" }], timestamp: "2026-05-03T00:00:01.000Z" },
    ], [], [
      { id: "prompt:ask", kind: "ask", text: "what is this?", timestamp: "2026-05-03T00:00:00.000Z", reconciledAt: null, error: null },
    ]);

    expect(merged.map((message) => (message as { id: string }).id)).toEqual(["official"]);
  });

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

describe("active tool execution snapshots", () => {
  test("merges sparse updates while preserving start metadata", () => {
    const start = activeToolSnapshotFromEvent({
      type: "tool_execution_start",
      time: "2026-05-05T00:00:00.000Z",
      data: { type: "tool_execution_start", toolCallId: "sub-1", toolName: "subagent", args: { agent: "reviewer" }, startedAt: "2026-05-05T00:00:00.000Z" },
    });
    const update = activeToolSnapshotFromEvent({
      type: "tool_execution_update",
      time: "2026-05-05T00:00:01.000Z",
      data: { type: "tool_execution_update", toolCallId: "sub-1", partialResult: { details: { progress: [{ agent: "reviewer", status: "running" }] } } },
    }, start ?? undefined);

    expect(update).toMatchObject({
      type: "tool_execution_update",
      toolCallId: "sub-1",
      toolName: "subagent",
      args: { agent: "reviewer" },
      startedAt: "2026-05-05T00:00:00.000Z",
      eventTime: "2026-05-05T00:00:01.000Z",
      partialResult: { details: { progress: [{ agent: "reviewer", status: "running" }] } },
    });
  });

  test("skips events without a stable toolCallId", () => {
    expect(activeToolCallId({ toolCallId: "" })).toBeNull();
    expect(activeToolCallId({ toolCallId: 3 })).toBeNull();
    expect(activeToolSnapshotFromEvent({ type: "tool_execution_start", time: "now", data: { toolName: "subagent" } })).toBeNull();
  });

  test("replaces duplicate browser client ids without counting them as another tab", async () => {
    const session = webSession();
    const handle = {
      id: session.id,
      cwd: session.cwd,
      subscribe: () => () => undefined,
      subscribeQuestion: () => () => undefined,
      snapshot: async () => ({ session, status: "idle", messages: [] }),
      getSettings: async () => ({ model: null, availableModels: [], thinkingLevel: "low", availableThinkingLevels: ["low"], contextUsage: { tokens: null, contextWindow: null, percent: null } }),
      getCommands: () => [],
    };
    const store = {
      getSession: () => session,
      listWebCommandResults: () => [],
      listUnreconciledSubmittedPrompts: () => [],
    };
    const hub = new SessionHub(session.id, handle as never, { store, config: { sessionLifecycle: { disconnectedIdleTimeoutMs: 1_000, disconnectedRunningPolicy: "let-finish" } }, runner: { disposeSession: async () => undefined }, removeHub: () => undefined } as never);

    const createSocket = () => {
      const sent: unknown[] = [];
      let onClose: (() => void) | null = null;
      return {
        sent,
        socket: {
          send: (data: string) => sent.push(JSON.parse(data)),
          close: () => undefined,
          on: (event: string, callback: () => void) => {
            if (event === "close") onClose = callback;
          },
        },
        emitClose: () => onClose?.(),
      };
    };

    const first = createSocket();
    hub.add(first.socket, "client-1");
    await Promise.resolve();
    await Promise.resolve();

    const replacement = createSocket();
    hub.add(replacement.socket, "client-1");
    await Promise.resolve();
    await Promise.resolve();

    first.emitClose();

    const secondTab = createSocket();
    hub.add(secondTab.socket, "client-2");
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = secondTab.sent.find((entry): entry is ServerEnvelope => (entry as ServerEnvelope).payload?.type === "session_snapshot");
    expect(snapshot?.payload.type).toBe("session_snapshot");
    if (snapshot?.payload.type === "session_snapshot") {
      expect(snapshot.payload.snapshot.controller?.connectedClients).toBe(2);
    }
  });

  test("buffers broadcasts until snapshot is sent, then drains in order", async () => {
    let listener: (event: NormalizedAgentEvent, raw: unknown) => void = () => undefined;
    const snapshot = deferred<{ session: WebSession; status: "idle" | "running"; messages: unknown[] }>();
    const session = webSession();
    const handle = {
      id: session.id,
      cwd: session.cwd,
      subscribe: (next: (event: NormalizedAgentEvent, raw: unknown) => void) => { listener = next; return () => undefined; },
      subscribeQuestion: () => () => undefined,
      snapshot: () => snapshot.promise,
      getSettings: async () => ({ model: null, availableModels: [], thinkingLevel: "low", availableThinkingLevels: ["low"], contextUsage: { tokens: null, contextWindow: null, percent: null } }),
      getCommands: () => [],
    };
    const store = {
      getSession: () => session,
      listWebCommandResults: () => [],
      listUnreconciledSubmittedPrompts: () => [],
    };
    const sent: unknown[] = [];
    const socket = { send: (data: string) => sent.push(JSON.parse(data)), close: () => undefined, on: () => undefined };
    const hub = new SessionHub(session.id, handle as never, { store, config: { sessionLifecycle: { disconnectedIdleTimeoutMs: 1_000, disconnectedRunningPolicy: "let-finish" } }, runner: { disposeSession: async () => undefined }, removeHub: () => undefined } as never);

    hub.add(socket, "client-1");
    listener?.({ type: "tool_execution_update", time: "2026-05-05T00:00:01.000Z", data: { type: "tool_execution_update", toolCallId: "sub-1", toolName: "subagent", partialResult: { content: "running" } } }, {});
    listener?.({ type: "tool_execution_end", time: "2026-05-05T00:00:02.000Z", data: { type: "tool_execution_end", toolCallId: "sub-1", toolName: "subagent", result: { content: "done" } } }, {});
    expect(hub.getBroadcastMetrics()).toMatchObject({ broadcasts: 2, sentMessages: 0, bufferedMessages: 2, maxBufferedPayloads: 2, maxClients: 1, lastPayloadType: "agent_event" });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { type?: string }).type).toBe("hello");

    snapshot.resolve({ session, status: "running", messages: [] });
    await Promise.resolve();
    await Promise.resolve();

    const envelopes = sent.slice(1) as ServerEnvelope[];
    expect(envelopes.map((entry) => entry.payload.type)).toEqual(["session_snapshot", "agent_event", "agent_event", "controller_update"]);
    expect(hub.getBroadcastMetrics()).toMatchObject({ broadcasts: 3, sentMessages: 1, bufferedMessages: 2, maxBufferedPayloads: 2, lastPayloadType: "controller_update" });

    const sent2: unknown[] = [];
    hub.add({ send: (data: string) => sent2.push(JSON.parse(data)), close: () => undefined, on: () => undefined }, "client-2");
    await Promise.resolve();
    await Promise.resolve();
    const beforeMetadata = hub.getBroadcastMetrics();
    hub.broadcastMetadataUpdate(webSession({ id: session.id, summary: "x".repeat(1_000) }));
    const afterMetadata = hub.getBroadcastMetrics();
    expect(afterMetadata.sentMessages - beforeMetadata.sentMessages).toBe(2);
    expect(afterMetadata.sentBytes - beforeMetadata.sentBytes).toBeGreaterThan(afterMetadata.maxPayloadBytes);
    expect(afterMetadata.lastPayloadType).toBe("session_metadata_update");

    expect(envelopes[0]?.payload.type).toBe("session_snapshot");
    if (envelopes[0]?.payload.type === "session_snapshot") expect(envelopes[0].payload.snapshot.activeToolExecutions).toBeUndefined();
  });
});

describe("session attachment prompt images", () => {
  test("loads uploaded attachment references as agent image content", async () => {
    const session = webSession();
    const artifactDir = await mkdtemp(join(tmpdir(), "bakery-attachments-"));
    const attachmentPath = ".bakery/attachments/2026-05-10T00-00-00-000Z-shot.png";
    const artifactId = createHash("sha256").update(session.id).update("\0").update(attachmentPath).digest("hex").slice(0, 32);
    await mkdir(join(artifactDir, session.id), { recursive: true });
    await writeFile(join(artifactDir, session.id, `${artifactId}.png`), Buffer.from("image-bytes"));

    const prompts: Array<{ text: string; images: unknown[] | undefined }> = [];
    const handle = {
      id: session.id,
      cwd: session.cwd,
      subscribe: () => () => undefined,
      subscribeQuestion: () => () => undefined,
      snapshot: async () => ({ session, status: "idle", messages: [] }),
      getSettings: async () => ({ model: null, availableModels: [], thinkingLevel: "low", availableThinkingLevels: ["low"], contextUsage: { tokens: null, contextWindow: null, percent: null } }),
      getCommands: () => [],
      runBuiltinCommand: async () => ({ handled: false }),
      prompt: async (text: string, images: unknown[] | undefined) => { prompts.push({ text, images }); },
    };
    const store = {
      getSession: () => session,
      listWebCommandResults: () => [],
      listUnreconciledSubmittedPrompts: () => [],
      addSubmittedPrompt: (_sessionId: string, input: { kind: "prompt"; text: string }) => ({ id: "prompt:1", kind: input.kind, text: input.text, timestamp: "2026-05-10T00:00:00.000Z", reconciledAt: null, error: null }),
      markSubmittedPromptError: () => undefined,
      updateSession: () => session,
    };
    let onMessage: ((data: string) => void) | undefined;
    const sent: unknown[] = [];
    const socket = {
      send: (data: string) => { sent.push(JSON.parse(data)); },
      close: () => undefined,
      on: (event: string, callback: (...args: never[]) => void) => {
        if (event === "message") onMessage = (data) => callback(data as never);
      },
    };
    const hub = new SessionHub(session.id, handle as never, { store, config: { artifactDir, sessionLifecycle: { disconnectedIdleTimeoutMs: 1_000, disconnectedRunningPolicy: "let-finish" } }, runner: { disposeSession: async () => undefined }, removeHub: () => undefined } as never);

    hub.add(socket, "client-1");
    await Promise.resolve();
    await Promise.resolve();
    onMessage?.(JSON.stringify({ type: "prompt", text: `Please inspect it.\n\nAttached files:\n- shot.png: ${attachmentPath}` }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.images).toEqual([{ type: "image", mimeType: "image/png", data: Buffer.from("image-bytes").toString("base64") }]);
  });
});
