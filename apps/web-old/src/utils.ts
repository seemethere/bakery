export type BrowserPerfEventKind = "render" | "patch" | "rowUpdate" | "structurePatch" | "receiptPatch" | "scrollCorrection" | "autoScrollTransition" | "queueHeight" | "renderFallback";

export type BrowserPerfEvent = {
  kind: BrowserPerfEventKind;
  reason: string;
  at: number;
  data?: Record<string, number | string | boolean | null> | undefined;
};

export type BrowserPerfMetrics = {
  renderCount: number;
  renderMs: number[];
  patchCount: number;
  patchMs: number[];
  rowUpdateCount: number;
  rowUpdateMs: number[];
  eventCounts?: Partial<Record<BrowserPerfEventKind, number>>;
  reasonCounts?: Record<string, number>;
  recentEvents?: BrowserPerfEvent[];
};

declare global {
  interface Window {
    __piWebPerf?: BrowserPerfMetrics;
  }
}

function ensurePerfMetrics(): BrowserPerfMetrics {
  const perf = window.__piWebPerf ??= { renderCount: 0, renderMs: [], patchCount: 0, patchMs: [], rowUpdateCount: 0, rowUpdateMs: [] };
  perf.rowUpdateCount ??= 0;
  perf.rowUpdateMs ??= [];
  perf.eventCounts ??= {};
  perf.reasonCounts ??= {};
  perf.recentEvents ??= [];
  return perf;
}

export function recordPerfEvent(kind: BrowserPerfEventKind, reason: string, data?: BrowserPerfEvent["data"]): void {
  const perf = ensurePerfMetrics();
  perf.eventCounts![kind] = (perf.eventCounts![kind] ?? 0) + 1;
  const reasonKey = `${kind}:${reason}`;
  perf.reasonCounts![reasonKey] = (perf.reasonCounts![reasonKey] ?? 0) + 1;
  perf.recentEvents!.push({ kind, reason, at: Math.round(performance.now()), data });
  if (perf.recentEvents!.length > 80) perf.recentEvents!.shift();
}

export function recordPerfSample(kind: "render" | "patch" | "rowUpdate", ms: number, reason = "unspecified"): void {
  const perf = ensurePerfMetrics();
  recordPerfEvent(kind, reason, { ms: Math.round(ms) });
  if (kind === "render") {
    perf.renderCount++;
    perf.renderMs.push(ms);
    if (perf.renderMs.length > 500) perf.renderMs.shift();
  } else if (kind === "patch") {
    perf.patchCount++;
    perf.patchMs.push(ms);
    if (perf.patchMs.length > 500) perf.patchMs.shift();
  } else {
    perf.rowUpdateCount++;
    perf.rowUpdateMs.push(ms);
    if (perf.rowUpdateMs.length > 500) perf.rowUpdateMs.shift();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

export function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function pathBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export function pathParent(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : path;
}
