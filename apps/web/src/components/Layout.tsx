import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import type { WebSession, Workspace, WorkspaceBrowseResponse } from "@pi-web-agent/protocol";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Header } from "@/components/Header";
import { parseAppRoute } from "@/lib/router";
import type { ConnectionStatus } from "@/lib/session-utils";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const SIDEBAR_COLLAPSED_KEY = "piWebSidebarCollapsed";

type Props = {
  sessions: WebSession[];
  workspaces: Workspace[];
  selectedSession: WebSession | null;
  selectedWorkspacePath: string;
  connectionStatus: ConnectionStatus;
  isBootstrapping?: boolean;
  isSidebarBootstrapping?: boolean;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  children: React.ReactNode;
  onSelectSession: (id: string) => void;
  onNewSession: (cwd?: string) => void;
  onNewIsolatedSession: (cwd?: string) => void;
  onBrowseWorkspaces: (path?: string) => Promise<WorkspaceBrowseResponse | null>;
  onAddWorkspace: (path: string) => Promise<Workspace | null>;
  onRevokeWorkspace: (path: string) => Promise<boolean>;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
  onUpdateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
  onAttachWorkspace: (sessionId: string, cwd: string) => Promise<WebSession | null>;
  onWorkspaceChange: (path: string) => void;
  onOpenSettings: () => void;
};

export function Layout({
  sessions,
  workspaces,
  selectedSession,
  selectedWorkspacePath,
  connectionStatus,
  isBootstrapping = false,
  isSidebarBootstrapping = false,
  fetchJson,
  children,
  onSelectSession,
  onNewSession,
  onNewIsolatedSession,
  onBrowseWorkspaces,
  onAddWorkspace,
  onRevokeWorkspace,
  onDeleteSession,
  onRenameSession,
  onTogglePinSession,
  onUpdateSessionMetadata,
  onAttachWorkspace,
  onWorkspaceChange,
  onOpenSettings,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const route = parseAppRoute(location.pathname);

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");

  return (
    <SidebarProvider
      open={!collapsed}
      onOpenChange={(open) => {
        setCollapsed(!open);
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!open));
      }}
      className={cn(
        "pi-web-agent h-dvh overflow-hidden",
        collapsed && "session-sidebar-collapsed",
      )}
      data-selected-session-id={selectedSession?.id ?? ""}
      data-agent-status={connectionStatus}
    >
      <MobileSidebarSwipeEdge />
      <Sidebar
        selectedSession={selectedSession}
        sessions={sessions}
        workspaces={workspaces}
        selectedWorkspacePath={selectedWorkspacePath}
        route={route}
        connectionStatus={connectionStatus}
        isBootstrapping={isSidebarBootstrapping}
        onSelectSession={onSelectSession}
        onNewSession={onNewSession}
        onNewIsolatedSession={onNewIsolatedSession}
        onBrowseWorkspaces={onBrowseWorkspaces}
        onAddWorkspace={onAddWorkspace}
        onRevokeWorkspace={onRevokeWorkspace}
        onDeleteSession={onDeleteSession}
        onRenameSession={onRenameSession}
        onTogglePinSession={onTogglePinSession}
        onNavigate={navigate}
        onWorkspaceChange={onWorkspaceChange}
        onOpenSettings={onOpenSettings}
      />

      <SidebarInset className="min-h-0 overflow-hidden">
        <Header
          session={selectedSession}
          workspaces={workspaces}
          connectionStatus={connectionStatus}
          isBootstrapping={isBootstrapping}
          fetchJson={fetchJson}
          onUpdateSessionMetadata={onUpdateSessionMetadata}
          onAttachWorkspace={onAttachWorkspace}
        />

        <main className="flex-1 min-h-0 overflow-hidden grid" style={{ gridTemplateRows: "1fr" }}>
          <div className="min-h-0 overflow-hidden flex flex-col">
            {children}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

const MOBILE_SWIPE_EDGE_WIDTH_PX = 36;
const MOBILE_SWIPE_OPEN_DISTANCE_PX = 72;
const MOBILE_SWIPE_MAX_VERTICAL_DRIFT_PX = 80;

type SwipeStart = {
  pointerId: number;
  x: number;
  y: number;
};

function MobileSidebarSwipeEdge() {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const startRef = useRef<SwipeStart | null>(null);

  useEffect(() => {
    if (!isMobile || openMobile) {
      startRef.current = null;
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.pointerType === "mouse" || event.button !== 0 || event.clientX > MOBILE_SWIPE_EDGE_WIDTH_PX) {
        startRef.current = null;
        return;
      }
      startRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }

    function handlePointerMove(event: PointerEvent) {
      const start = startRef.current;
      if (!start || start.pointerId !== event.pointerId) return;

      const dx = event.clientX - start.x;
      const dy = Math.abs(event.clientY - start.y);
      if (dx >= MOBILE_SWIPE_OPEN_DISTANCE_PX && dy <= MOBILE_SWIPE_MAX_VERTICAL_DRIFT_PX) {
        startRef.current = null;
        setOpenMobile(true);
      }
    }

    function clearStart() {
      startRef.current = null;
    }

    document.addEventListener("pointerdown", handlePointerDown, { capture: true, passive: true });
    document.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
    document.addEventListener("pointerup", clearStart, { capture: true, passive: true });
    document.addEventListener("pointercancel", clearStart, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      document.removeEventListener("pointermove", handlePointerMove, { capture: true });
      document.removeEventListener("pointerup", clearStart, { capture: true });
      document.removeEventListener("pointercancel", clearStart, { capture: true });
    };
  }, [isMobile, openMobile, setOpenMobile]);

  return null;
}
