import type { SessionTreeNode, SessionTreeResponse } from "@pi-web-agent/protocol";
import { escapeHtml, isRecord } from "./utils";

export type TreeTranscriptItem = {
  id: string;
  kind: string;
  body: string;
  raw?: unknown;
};

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

export function currentSessionTreeEntryId(sessionTree: SessionTreeResponse | null): string {
  const nodes = flattenSessionTree(sessionTree?.tree ?? []);
  return nodes.find((node) => node.current)?.id ?? sessionTree?.leafId ?? "";
}

export function nextSessionTreeActiveEntryId(sessionTree: SessionTreeResponse | null, activeEntryId: string): string {
  const nodes = flattenSessionTree(sessionTree?.tree ?? []);
  if (!nodes.length) return "";
  if (activeEntryId && nodes.some((node) => node.id === activeEntryId)) return activeEntryId;
  return currentSessionTreeEntryId(sessionTree) || nodes[nodes.length - 1]?.id || nodes[0]?.id || "";
}

export function renderCurrentSessionTreePath(sessionTree: SessionTreeResponse | null, path: SessionTreeNode[]): string {
  if (!sessionTree?.tree.length) return "";
  if (!path.length) return `<div class="tree-current-path empty"><strong>Current path</strong><span>No current leaf yet.</span></div>`;
  const visiblePath: SessionTreeNode[] = path.length > 4 ? [path[0]!, ...path.slice(-3)] : path;
  const skippedCount = path.length - visiblePath.length;
  const segments = visiblePath.map((node, index) => {
    const isLeaf = index === visiblePath.length - 1;
    const title = sessionTreeNodeDisplayTitle(node);
    return `<span class="tree-path-segment ${isLeaf ? "leaf" : ""}" title="${escapeHtml(node.title)}">${escapeHtml(title || node.type)}</span>`;
  }).join(`<span class="tree-path-separator">›</span>`);
  const skipped = skippedCount > 0 ? `<span class="tree-path-skipped">… ${skippedCount} earlier</span><span class="tree-path-separator">›</span>` : "";
  return `
      <div class="tree-current-path" aria-label="Current session tree path">
        <strong>Current path</strong>
        <div class="tree-path-line">${skipped}${segments}</div>
        <span class="tree-path-meta">${path.length} ${path.length === 1 ? "entry" : "entries"}</span>
      </div>`;
}

export function forkEntryIdForTranscriptItem(item: TreeTranscriptItem, nodes: SessionTreeNode[]): string | null {
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

export function renderSessionTreeNodeLines(nodes: SessionTreeNode[], currentPathIds = new Set<string>(), activeEntryId = "", prefix = ""): string[] {
  return nodes.flatMap((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = prefix ? (isLast ? "└─" : "├─") : "•";
    const childPrefix = `${prefix}${prefix ? (isLast ? "  " : "│ ") : ""}`;
    const canFork = node.type === "message" && node.role === "user";
    const kind = node.role ?? node.type;
    const isPath = currentPathIds.has(node.id);
    const isKeyboardActive = node.id === activeEntryId;
    const classes = ["tree-line", node.current ? "current" : "", isPath ? "current-path" : "", canFork ? "forkable" : "", isKeyboardActive ? "keyboard-active" : ""].filter(Boolean).join(" ");
    const line = `
        <div class="${classes}" data-tree-entry-id="${escapeHtml(node.id)}" data-tree-forkable="${canFork ? "true" : "false"}" role="treeitem" tabindex="${isKeyboardActive ? "0" : "-1"}" aria-current="${node.current ? "true" : "false"}" title="${node.current ? "Current leaf" : isPath ? "On the current path" : "Navigate to this point"}">
          <span class="tree-prefix">${escapeHtml(prefix)}${connector}</span>
          <span class="tree-kind ${escapeHtml(kind)}">${escapeHtml(kind)}:</span>
          <span class="tree-title">${escapeHtml(sessionTreeNodeDisplayTitle(node))}</span>
          ${node.current ? `<span class="tree-current">current leaf</span>` : isPath ? `<span class="tree-current path">path</span>` : `<span class="tree-current go">go</span>`}
          ${canFork ? `<button data-fork-entry-id="${escapeHtml(node.id)}" title="Fork from this user message" tabindex="-1">fork</button>` : ""}
        </div>`;
    return [line, ...renderSessionTreeNodeLines(node.children, currentPathIds, activeEntryId, childPrefix)];
  });
}

export function renderSessionTreeNodes(nodes: SessionTreeNode[], currentPathIds = new Set<string>(), activeEntryId = ""): string {
  return renderSessionTreeNodeLines(nodes, currentPathIds, activeEntryId).reverse().join("");
}
