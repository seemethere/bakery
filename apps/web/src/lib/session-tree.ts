import type { SessionTreeNode, SessionTreeResponse } from "@pi-web-agent/protocol";
import type { TranscriptItem } from "@/lib/transcript";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function flattenSessionTree(nodes: SessionTreeNode[] = []): SessionTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenSessionTree(node.children)]);
}

export function sessionTreeNodeDisplayTitle(node: SessionTreeNode): string {
  return node.title.replace(/^\w+:\s*/, "");
}

export function currentSessionTreePath(sessionTree: SessionTreeResponse | null): SessionTreeNode[] {
  const nodes = flattenSessionTree(sessionTree?.tree ?? []);
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let node = byId.get(sessionTree?.leafId ?? "") ?? nodes.find((candidate) => candidate.current) ?? null;
  const path: SessionTreeNode[] = [];
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    path.push(node);
    seen.add(node.id);
    node = node.parentId ? byId.get(node.parentId) ?? null : null;
  }
  return path.reverse();
}

export function forkEntryIdForTranscriptItem(item: TranscriptItem, nodes: SessionTreeNode[]): string | null {
  if (item.kind !== "user") return null;
  const rawTimestamp = isRecord(item.raw) ? String(item.raw.timestamp ?? "") : "";
  const idTimestamp = item.id.startsWith("user:") ? item.id.slice("user:".length) : "";
  const timestamp = rawTimestamp || idTimestamp;
  const text = item.body.replace(/\s+/g, " ").trim();
  const node = nodes.find((candidate) => {
    if (candidate.type !== "message" || candidate.role !== "user") return false;
    if (timestamp && candidate.timestamp === timestamp) return true;
    return Boolean(text && candidate.title.replace(/^user:\s*/, "").startsWith(text.slice(0, 80)));
  });
  return node?.id ?? null;
}
