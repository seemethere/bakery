import { useState, useEffect } from "react";
import type { SessionSnapshot } from "@pi-web-agent/protocol";
import { snapshotMessagesToTranscriptItems, compactSnapshotTranscript, applyAgentEvent, activeToolExecutionSnapshotToTranscriptItem, type TranscriptItem } from "@/lib/transcript";
import { measureTranscriptPerf, recordSnapshotPerf, recordTranscriptEvent } from "@/lib/transcript-perf";

export function useTranscript(
  snapshot: SessionSnapshot | null,
  subscribeAgentEvents: (cb: (event: unknown) => void) => () => void,
): TranscriptItem[] {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const snapshotSessionId = snapshot?.session.id ?? null;
  const snapshotMessages = snapshot?.messages ?? null;
  const activeToolExecutions = snapshot?.activeToolExecutions ?? null;

  // Reset and load items when the backing transcript snapshot changes. Session
  // metadata updates can replace the snapshot wrapper while reusing the same
  // message array; those should not wipe live WebSocket transcript rows.
  useEffect(() => {
    if (!snapshotSessionId || !snapshotMessages) {
      setItems([]);
      return;
    }
    const snapshotStart = performance.now();
    const snapshotItems = measureTranscriptPerf("snapshotConvertMs", () => snapshotMessagesToTranscriptItems(snapshotMessages));
    measureTranscriptPerf("snapshotActiveToolMs", () => {
      for (const activeTool of activeToolExecutions ?? []) {
        const existing = snapshotItems.find((item) => item.id === `tool:${activeTool.toolCallId}`);
        const item = activeToolExecutionSnapshotToTranscriptItem(activeTool, existing);
        if (!item) continue;
        const index = snapshotItems.findIndex((candidate) => candidate.id === item.id);
        if (index === -1) snapshotItems.push(item);
        else snapshotItems[index] = item;
      }
    });
    const loaded = measureTranscriptPerf("snapshotCompactMs", () => compactSnapshotTranscript(snapshotItems));
    measureTranscriptPerf("snapshotSetItemsMs", () => setItems(loaded));
    recordSnapshotPerf({
      messageCount: snapshotMessages.length,
      itemCount: loaded.length,
      activeToolCount: activeToolExecutions?.length ?? 0,
      snapshotToUsableMs: performance.now() - snapshotStart,
    });
  }, [snapshotSessionId, snapshotMessages, activeToolExecutions]);

  // Subscribe to streaming agent events
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      const type = typeof event === "object" && event !== null && "type" in event ? String((event as { type?: unknown }).type ?? "event") : "event";
      setItems((prev) => {
        const start = performance.now();
        const next = applyAgentEvent(prev, event);
        recordTranscriptEvent(type, performance.now() - start, { before: prev.length, after: next.length });
        return next;
      });
    });
  }, [subscribeAgentEvents]);

  return items;
}
