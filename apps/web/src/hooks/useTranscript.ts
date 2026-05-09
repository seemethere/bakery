import { useState, useEffect } from "react";
import type { SessionSnapshot } from "@pi-web-agent/protocol";
import { messageToTranscriptItem, compactSnapshotTranscript, applyAgentEvent, type TranscriptItem } from "@/lib/transcript";

export function useTranscript(
  snapshot: SessionSnapshot | null,
  subscribeAgentEvents: (cb: (event: unknown) => void) => () => void,
): TranscriptItem[] {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const snapshotSessionId = snapshot?.session.id ?? null;
  const snapshotMessages = snapshot?.messages ?? null;

  // Reset and load items when the backing transcript snapshot changes. Session
  // metadata updates can replace the snapshot wrapper while reusing the same
  // message array; those should not wipe live WebSocket transcript rows.
  useEffect(() => {
    if (!snapshotSessionId || !snapshotMessages) {
      setItems([]);
      return;
    }
    const loaded = compactSnapshotTranscript(
      snapshotMessages.map((msg, idx) => messageToTranscriptItem(msg, `snapshot:${idx}`)),
    );
    setItems(loaded);
  }, [snapshotSessionId, snapshotMessages]);

  // Subscribe to streaming agent events
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      setItems((prev) => applyAgentEvent(prev, event));
    });
  }, [subscribeAgentEvents]);

  return items;
}
