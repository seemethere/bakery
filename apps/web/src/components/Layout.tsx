import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import type { WebSession, Workspace } from "@pi-web-agent/protocol";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Header } from "@/components/Header";
import { parseAppRoute } from "@/lib/router";
import type { ConnectionStatus } from "@/lib/session-utils";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
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
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
  onUpdateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
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
  onDeleteSession,
  onRenameSession,
  onTogglePinSession,
  onUpdateSessionMetadata,
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
        "pi-web-agent h-screen overflow-hidden",
        collapsed && "session-sidebar-collapsed",
      )}
    >
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
          connectionStatus={connectionStatus}
          isBootstrapping={isBootstrapping}
          fetchJson={fetchJson}
          onUpdateSessionMetadata={onUpdateSessionMetadata}
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
