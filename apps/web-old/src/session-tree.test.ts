import { describe, expect, test } from "bun:test";
import type { SessionTreeNode, SessionTreeResponse } from "@pi-web-agent/protocol";
import { currentSessionTreeEntryId, currentSessionTreePath, flattenSessionTree, forkEntryIdForTranscriptItem, nextSessionTreeActiveEntryId, renderCurrentSessionTreePath, renderSessionTreeNodes, sessionTreeNodeDisplayTitle } from "./session-tree";

function node(overrides: Partial<SessionTreeNode> & Pick<SessionTreeNode, "id" | "title">): SessionTreeNode {
  return {
    parentId: null,
    type: "message",
    timestamp: overrides.id,
    role: "assistant",
    current: false,
    children: [],
    ...overrides,
  };
}

const root = node({ id: "root", title: "system: Root", type: "system", role: undefined });
const user = node({ id: "u1", parentId: "root", role: "user", title: "user: Build the tree", timestamp: "2026-01-01T00:00:00.000Z" });
const assistant = node({ id: "a1", parentId: "u1", role: "assistant", title: "assistant: Done", current: true });
root.children = [user];
user.children = [assistant];

const tree: SessionTreeResponse = {
  sessionId: "session-1",
  leafId: "a1",
  tree: [root],
};

describe("session tree helpers", () => {
  test("flattens trees and resolves the current path", () => {
    expect(flattenSessionTree(tree.tree).map((item) => item.id)).toEqual(["root", "u1", "a1"]);
    expect(currentSessionTreePath(tree).map((item) => item.id)).toEqual(["root", "u1", "a1"]);
    expect(currentSessionTreeEntryId(tree)).toBe("a1");
  });

  test("keeps valid active entries and falls back to the current leaf", () => {
    expect(nextSessionTreeActiveEntryId(tree, "u1")).toBe("u1");
    expect(nextSessionTreeActiveEntryId(tree, "missing")).toBe("a1");
    expect(nextSessionTreeActiveEntryId({ ...tree, tree: [] }, "u1")).toBe("");
  });

  test("normalizes display titles and renders a shortened current path", () => {
    expect(sessionTreeNodeDisplayTitle(user)).toBe("Build the tree");

    const html = renderCurrentSessionTreePath(tree, currentSessionTreePath(tree));
    expect(html).toContain("Current path");
    expect(html).toContain("Build the tree");
    expect(html).toContain("3 entries");
    expect(html).toContain('title="user: Build the tree"');
  });

  test("matches transcript user items to forkable tree entries", () => {
    expect(forkEntryIdForTranscriptItem({ id: "user:other", kind: "user", body: "Build the tree" }, flattenSessionTree(tree.tree))).toBe("u1");
    expect(forkEntryIdForTranscriptItem({ id: "x", kind: "assistant", body: "Build the tree" }, flattenSessionTree(tree.tree))).toBeNull();
  });

  test("renders newest-first tree rows with path, active, and fork affordances", () => {
    const html = renderSessionTreeNodes(tree.tree, new Set(["root", "u1", "a1"]), "u1");
    const assistantIndex = html.indexOf('data-tree-entry-id="a1"');
    const userIndex = html.indexOf('data-tree-entry-id="u1"');
    expect(assistantIndex).toBeLessThan(userIndex);
    expect(html).toContain("keyboard-active");
    expect(html).toContain('data-tree-forkable="true"');
    expect(html).toContain('data-fork-entry-id="u1"');
    expect(html).toContain("current leaf");
  });
});
