import { describe, expect, test } from "bun:test";
import { renderSessionSidebar, sessionSidebarOverlayOpen } from "./session-sidebar-controller";

describe("session sidebar controller", () => {
  test("treats unpinned expanded navigation as an overlay", () => {
    expect(sessionSidebarOverlayOpen({ collapsed: false, pinned: false })).toBe(true);
    expect(sessionSidebarOverlayOpen({ collapsed: false, pinned: true })).toBe(false);
    expect(sessionSidebarOverlayOpen({ collapsed: true, pinned: false })).toBe(false);
  });

  test("renders route-aware navigation and escaped workspace labels", () => {
    const html = renderSessionSidebar({
      collapsed: false,
      pinned: true,
      mobileLayout: false,
      selectedSession: null,
      route: { kind: "settings" },
      workspaces: [{ path: "/tmp/<repo>", label: "Repo & test" }],
    });

    expect(html).toContain("Settings");
    expect(html).toContain("active");
    expect(html).toContain("Repo &amp; test");
    expect(html).toContain("/tmp/&lt;repo&gt;");
    expect(html).toContain("Add workspace");
    expect(html).toContain("cloneWorkspaceUrl");
    expect(html).toContain("githubRepoName");
  });
});
