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

function transcriptItemTimestamp(item: TranscriptItem): string {
  const rawTimestamp = isRecord(item.raw) ? String(item.raw.timestamp ?? "") : "";
  if (rawTimestamp) return rawTimestamp;
  const separator = item.id.indexOf(":");
  return separator >= 0 ? item.id.slice(separator + 1) : "";
}

function treeNodeMatchesTranscriptKind(node: SessionTreeNode, item: TranscriptItem): boolean {
  if (item.kind === "tool") return node.role === "toolResult" || node.role === "bashExecution" || node.type.includes("tool") || node.title.startsWith("Tool result") || node.title.startsWith("$ ");
  if (item.kind === "assistant" || item.kind === "user") return node.type === "message" && node.role === item.kind;
  return node.type === item.kind || node.role === item.kind;
}

function normalizedTreeTitle(node: SessionTreeNode): string {
  return node.title.replace(/^\w+:\s*/, "").replace(/\s+/g, " ").trim();
}

export function forkEntryIdForTranscriptItem(item: TranscriptItem, nodes: SessionTreeNode[]): string | null {
  const timestamp = transcriptItemTimestamp(item);
  const text = item.body.replace(/\s+/g, " ").trim();
  const title = item.title?.replace(/\s+/g, " ").trim() ?? "";
  const node = nodes.find((candidate) => {
    if (!treeNodeMatchesTranscriptKind(candidate, item)) return false;
    if (timestamp && candidate.timestamp === timestamp) return true;
    const candidateTitle = normalizedTreeTitle(candidate);
    if ((item.kind === "user" || item.kind === "assistant") && text && candidateTitle) {
      const textPrefix = text.slice(0, 80).trim();
      return candidateTitle.startsWith(textPrefix) || text.startsWith(candidateTitle);
    }
    if (item.kind === "tool" && title) return candidate.title.includes(title) || title.includes(candidateTitle);
    return false;
  });
  return node?.id ?? null;
}
