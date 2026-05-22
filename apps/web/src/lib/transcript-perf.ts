export type TranscriptPerfMetricName =
  | "snapshotConvertMs"
  | "snapshotActiveToolMs"
  | "snapshotCompactMs"
  | "snapshotSetItemsMs"
  | "eventApplyMs"
  | "transcriptCommitMs";

type PiWebPerfState = {
  renderCount: number;
  renderMs: number[];
  patchCount: number;
  patchMs: number[];
  rowUpdateCount?: number;
  rowUpdateMs?: number[];
  eventCounts?: Record<string, number>;
  reasonCounts?: Record<string, number>;
  recentEvents?: unknown[];
  transcript?: {
    snapshotMessageCount?: number;
    snapshotItemCount?: number;
    activeToolCount?: number;
    visibleRowCount?: number;
    totalItemCount?: number;
    lastSnapshotToUsableMs?: number;
    samples?: Partial<Record<TranscriptPerfMetricName, number[]>>;
  };
};

declare global {
  interface Window {
    __piWebPerf?: PiWebPerfState;
  }
}

const MAX_SAMPLES = 120;
const MAX_RECENT_EVENTS = 40;

function getPerfState(): PiWebPerfState | null {
  if (typeof window === "undefined") return null;
  const existing = window.__piWebPerf;
  if (existing) {
    existing.renderMs ??= [];
    existing.patchMs ??= [];
    existing.eventCounts ??= {};
    existing.reasonCounts ??= {};
    existing.recentEvents ??= [];
    existing.transcript ??= { samples: {} };
    existing.transcript.samples ??= {};
    return existing;
  }
  const created: PiWebPerfState = {
    renderCount: 0,
    renderMs: [],
    patchCount: 0,
    patchMs: [],
    rowUpdateCount: 0,
    rowUpdateMs: [],
    eventCounts: {},
    reasonCounts: {},
    recentEvents: [],
    transcript: { samples: {} },
  };
  window.__piWebPerf = created;
  return created;
}

function pushBounded(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function measureTranscriptPerf<T>(name: TranscriptPerfMetricName, fn: () => T): T {
  const start = typeof performance !== "undefined" ? performance.now() : 0;
  try {
    return fn();
  } finally {
    if (start) recordTranscriptPerfSample(name, performance.now() - start);
  }
}

export function recordTranscriptPerfSample(name: TranscriptPerfMetricName, ms: number): void {
  const state = getPerfState();
  if (!state) return;
  const transcript = state.transcript ??= { samples: {} };
  const samples = transcript.samples ??= {};
  const metricSamples = samples[name] ??= [];
  pushBounded(metricSamples, ms);
  if (name === "eventApplyMs") {
    state.patchCount += 1;
    pushBounded(state.patchMs, ms);
  }
}

export function recordSnapshotPerf(meta: { messageCount: number; itemCount: number; activeToolCount: number; snapshotToUsableMs?: number }): void {
  const state = getPerfState();
  if (!state) return;
  const transcript = state.transcript ??= { samples: {} };
  transcript.snapshotMessageCount = meta.messageCount;
  transcript.snapshotItemCount = meta.itemCount;
  transcript.activeToolCount = meta.activeToolCount;
  if (meta.snapshotToUsableMs !== undefined) transcript.lastSnapshotToUsableMs = meta.snapshotToUsableMs;
}

export function recordTranscriptCommit(meta: { totalItemCount: number; visibleRowCount: number; commitMs?: number }): void {
  const state = getPerfState();
  if (!state) return;
  const transcript = state.transcript ??= { samples: {} };
  transcript.totalItemCount = meta.totalItemCount;
  transcript.visibleRowCount = meta.visibleRowCount;
  if (meta.commitMs !== undefined) recordTranscriptPerfSample("transcriptCommitMs", meta.commitMs);
}

export function recordTranscriptEvent(type: string, ms: number, meta?: Record<string, unknown>): void {
  const state = getPerfState();
  if (!state) return;
  state.eventCounts ??= {};
  state.eventCounts[type] = (state.eventCounts[type] ?? 0) + 1;
  state.reasonCounts ??= {};
  state.reasonCounts[`event:${type}`] = (state.reasonCounts[`event:${type}`] ?? 0) + 1;
  recordTranscriptPerfSample("eventApplyMs", ms);
  const events = state.recentEvents ??= [];
  events.push({ type, ms: Math.round(ms), ...meta });
  if (events.length > MAX_RECENT_EVENTS) events.splice(0, events.length - MAX_RECENT_EVENTS);
}
