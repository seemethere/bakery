import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { Layout } from "@/components/Layout";
import { SessionsPage } from "@/pages/SessionsPage";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SessionPage } from "@/pages/SessionPage";
import { sessionRoutePath, sessionsRoutePath, parseAppRoute } from "@/lib/router";
import { useServerConnection } from "@/hooks/useServerConnection";
import { TooltipProvider } from "@/components/ui/tooltip";

function AppInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const route = parseAppRoute(location.pathname);
  const routeSessionId = route.kind === "session" ? route.sessionId : null;
  const conn = useServerConnection(routeSessionId);
  const [showThinking, setShowThinkingState] = useState(() => localStorage.getItem("piWebShowThinking") === "true");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptFocusNonce, setPromptFocusNonce] = useState(0);

  function setShowThinking(value: boolean) {
    setShowThinkingState(value);
    localStorage.setItem("piWebShowThinking", String(value));
  }

  // Sync URL → selected session on load / navigation
  useEffect(() => {
    if (route.kind === "session" && conn.selectedSession?.id !== route.sessionId) {
      conn.selectSession(route.sessionId);
    }
  }, [conn.sessions, conn.selectedSession?.id, conn.selectSession, route]);

  function handleSelectSession(id: string) {
    conn.selectSession(id);
    navigate(sessionRoutePath(id));
  }

  async function handleNewSession(cwd?: string) {
    const session = await conn.newSession(cwd);
    if (session) navigate(sessionRoutePath(session.id));
  }

  async function handleNewIsolatedSession(cwd?: string) {
    const session = await conn.newIsolatedSession(cwd);
    if (session) navigate(sessionRoutePath(session.id));
  }

  async function handleNewSessionCommand(cwd?: string | null) {
    const session = await conn.newSession(cwd ?? undefined);
    if (!session) return false;
    navigate(sessionRoutePath(session.id));
    setPromptFocusNonce((value) => value + 1);
    return true;
  }

  async function handleDeleteSession(id: string) {
    const route = parseAppRoute(location.pathname);
    const result = await conn.deleteSession(id);
    if (!result.deleted) {
      window.alert(`Could not delete session${result.error ? `: ${result.error}` : "."}`);
      return;
    }
    if (route.kind !== "session" || route.sessionId !== id) return;
    navigate(result.nextSession ? sessionRoutePath(result.nextSession.id) : sessionsRoutePath(), { replace: true });
  }

  const selectedWorkspacePath = conn.selectedSession?.cwd ?? "";
  const isSessionRouteBootstrapping = route.kind === "session" && conn.isBootstrapping;
  const sessionRouteMissing = route.kind === "session"
    && !conn.isBootstrapping
    && !conn.bootstrapError
    && !conn.sessions.some((session) => session.id === route.sessionId);

  return (
    <Layout
      sessions={conn.sessions}
      workspaces={conn.workspaces}
      selectedSession={conn.selectedSession}
      selectedWorkspacePath={selectedWorkspacePath}
      connectionStatus={conn.connectionStatus}
      isBootstrapping={isSessionRouteBootstrapping}
      isSidebarBootstrapping={conn.isBootstrapping}
      fetchJson={conn.fetchJson}
      onSelectSession={handleSelectSession}
      onNewSession={(cwd) => void handleNewSession(cwd)}
      onNewIsolatedSession={(cwd) => void handleNewIsolatedSession(cwd)}
      onBrowseWorkspaces={conn.browseWorkspaces}
      onAddWorkspace={conn.addWorkspace}
      onRevokeWorkspace={conn.revokeWorkspace}
      onDeleteSession={(id) => void handleDeleteSession(id)}
      onRenameSession={(id, title) => void conn.renameSession(id, title)}
      onTogglePinSession={(id, pinned) => void conn.togglePinSession(id, pinned)}
      onUpdateSessionMetadata={conn.updateSessionMetadata}
      onUpdateSessionReview={conn.updateSessionReview}
      onAttachWorkspace={conn.attachWorkspace}
      onWorkspaceChange={() => {}}
      onOpenSettings={() => setSettingsOpen(true)}
    >
      <Routes>
        <Route path="/" element={
          conn.sessions.length > 0
            ? <Navigate to={sessionRoutePath(conn.sessions[0]!.id)} replace />
            : <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No sessions yet.</div>
        } />
        <Route path="/sessions" element={
          <SessionsPage
            sessions={conn.sessions}
            selectedSessionId={conn.selectedSession?.id ?? ""}
            connectionStatus={conn.connectionStatus}
            onDeleteSession={(id) => void handleDeleteSession(id)}
            onRenameSession={(id, title) => void conn.renameSession(id, title)}
            onTogglePinSession={(id, pinned) => void conn.togglePinSession(id, pinned)}
          />
        } />
        <Route path="/sessions/:sessionId" element={
          <SessionPage
            snapshot={conn.snapshot}
            pendingQuestion={conn.pendingQuestion}
            controller={conn.controller}
            runtimeSettings={conn.runtimeSettings}
            defaultThinkingLevel={conn.config?.modelPolicy.defaultThinkingLevel}
            showThinking={showThinking}
            subscribeAgentEvents={conn.subscribeAgentEvents}
            fetchJson={conn.fetchJson}
            apiBase={conn.apiBase}
            token={conn.token}
            extensionCatalog={conn.extensionCatalog}
            runningQueue={conn.runningQueue}
            status={conn.connectionStatus === "connecting" || conn.connectionStatus === "disconnected"
              ? conn.connectionStatus
              : (conn.connectionStatus as "idle" | "running" | "aborting" | "error")}
            onForkSession={conn.forkSession}
            onNewSessionCommand={handleNewSessionCommand}
            onCancelQueuedMessage={conn.cancelQueuedMessage}
            onSend={conn.send}
            onAbort={conn.abort}
            onSetModel={conn.setModel}
            onSetThinking={conn.setThinking}
            onShowThinkingChange={setShowThinking}
            onAnswerQuestion={conn.answerQuestion}
            onTakeControl={conn.takeControl}
            promptFocusNonce={promptFocusNonce}
            isBootstrapping={isSessionRouteBootstrapping}
            sessionNotFound={sessionRouteMissing}
          />
        } />
      </Routes>
      <SettingsDialog
        open={settingsOpen}
        runtimeSettings={conn.runtimeSettings}
        appSettings={conn.appSettings}
        apiBase={conn.apiBase}
        token={conn.token}
        onOpenChange={setSettingsOpen}
        onSaveConnection={conn.saveConnection}
        onSaveAppSettings={(settings) => void conn.saveAppSettings(settings)}
      />
    </Layout>
  );
}

function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <AppInner />
      </TooltipProvider>
    </BrowserRouter>
  );
}

export default App;
