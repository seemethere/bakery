import { useState, useEffect } from "react";
import type { SessionSnapshot } from "@pi-web-agent/protocol";
import { messageToTranscriptItem, compactSnapshotTranscript, applyAgentEvent, type TranscriptItem } from "@/lib/transcript";

export function useTranscript(
  snapshot: SessionSnapshot | null,
  subscribeAgentEvents: (cb: (event: unknown) => void) => () => void,
): TranscriptItem[] {
  const [items, setItems] = useState<TranscriptItem[]>([]);

  // Reset and load items when snapshot changes
  useEffect(() => {
    if (!snapshot) {
      setItems([]);
      return;
    }
    const loaded = compactSnapshotTranscript(
      snapshot.messages.map((msg, idx) => messageToTranscriptItem(msg, `snapshot:${idx}`)),
    );
    setItems(loaded);
  }, [snapshot]);

  // Subscribe to streaming agent events
  useEffect(() => {
    return subscribeAgentEvents((event) => {
      setItems((prev) => applyAgentEvent(prev, event));
    });
  }, [subscribeAgentEvents]);

  return items;
}
