import { useState, useEffect } from "react";
import type { SessionSnapshot } from "@pi-web-agent/protocol";
import { messageToTranscriptItem, compactSnapshotTranscript, applyAgentEvent, activeToolExecutionSnapshotToTranscriptItem, type TranscriptItem } from "@/lib/transcript";

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
    const snapshotItems = snapshotMessages.map((msg, idx) => messageToTranscriptItem(msg, `snapshot:${idx}`));
    for (const activeTool of activeToolExecutions ?? []) {
      const existing = snapshotItems.find((item) => item.id === `tool:${activeTool.toolCallId}`);
      const item = activeToolExecutionSnapshotToTranscriptItem(activeTool, existing);
      if (!item) continue;
      const index = snapshotItems.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) snapshotItems.push(item);
      else snapshotItems[index] = item;
    }
    const loaded = compactSnapshotTranscript(snapshotItems);
    setItems(loaded);
  }, [snapshotSessionId, snapshotMessages, activeToolExecutions]);

  // Subscribe to streaming agent events
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      setItems((prev) => applyAgentEvent(prev, event));
    });
  }, [subscribeAgentEvents]);

  return items;
}
