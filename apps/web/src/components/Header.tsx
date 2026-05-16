import { useEffect, useRef, useState } from "react";
import type { WebSession, Workspace } from "@pi-web-agent/protocol";
import { ChevronDownIcon, FolderOpenIcon, GitBranchIcon } from "lucide-react";
import { sessionDisplayTitle, sessionMetadataLabel, type ConnectionStatus } from "@/lib/session-utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionDetailsDialog } from "@/components/SessionDetailsDialog";

type Props = {
  session: WebSession | null;
  workspaces: Workspace[];
  connectionStatus: ConnectionStatus;
  isBootstrapping?: boolean;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  onUpdateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
  onAttachWorkspace: (sessionId: string, cwd: string) => Promise<WebSession | null>;
};

export function Header({ session, workspaces, connectionStatus, isBootstrapping = false, fetchJson, onUpdateSessionMetadata, onAttachWorkspace }: Props) {
  const isMobile = useIsMobile();
  const title = session ? sessionDisplayTitle(session) : null;
  const meta = session ? sessionMetadataLabel(session) : null;

  return (
    <header className="flex min-w-0 items-start justify-between gap-2 overflow-visible border-b border-border/60 bg-background/80 px-3 py-2.5 backdrop-blur-sm sm:gap-3 sm:px-4 sm:py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger
          id={isMobile ? "toggleSessionSidebarMobile" : "toggleSessionSidebar"}
          aria-label="Toggle navigation"
          className="shrink-0"
        />
        <div className="grid min-w-0 gap-0.5">
          {isBootstrapping ? (
            <>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-56 max-w-[45vw]" />
            </>
          ) : session && title ? (
            <>
              <strong className="session-title truncate text-sm font-semibold text-foreground">{title}</strong>
              <HeaderSessionMeta
                session={session}
                meta={meta}
                workspaces={workspaces}
                onAttachWorkspace={onAttachWorkspace}
              />
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No session selected</span>
          )}
        </div>
        {session?.isolationKind === "git_worktree" && (
          <span
            className="hidden flex-shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:inline-flex"
            title={session.worktreeBranch ? `Isolated worktree: ${session.worktreeBranch}` : "Isolated worktree session"}
          >
            <GitBranchIcon className="size-3" />
            <span>Worktree</span>
          </span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
        {!isBootstrapping && session && (
          <SessionDetailsDialog
            session={session}
            fetchJson={fetchJson}
            onUpdateSessionMetadata={onUpdateSessionMetadata}
          />
        )}
        {!isBootstrapping && <StatusPill status={connectionStatus} />}
      </div>
    </header>
  );
}

function useDismissablePopover(open: boolean, onOpenChange: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onOpenChange(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  return ref;
}

function HeaderSessionMeta({
  session,
  meta,
  workspaces,
  onAttachWorkspace,
}: {
  session: WebSession;
  meta: string | null;
  workspaces: Workspace[];
  onAttachWorkspace: (sessionId: string, cwd: string) => Promise<WebSession | null>;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useDismissablePopover(open, setOpen);
  const hasWorkspace = Boolean(session.cwd || session.sourceCwd);
  const canPickWorkspace = session.kind === "draft" && !hasWorkspace;

  if (!canPickWorkspace) {
    return meta ? <span className="session-workspace hidden truncate text-xs text-muted-foreground sm:block">{meta}</span> : null;
  }

  return (
    <div ref={popoverRef} className="session-workspace relative min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-6 max-w-full justify-start gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <FolderOpenIcon className="size-3.5 shrink-0" />
        <span className="truncate">No workspace</span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Pick workspace"
          className="absolute left-0 top-[calc(100%+8px)] z-30 grid w-[calc(100vw-4rem)] min-w-0 max-w-[520px] gap-0.5 rounded-lg border border-border bg-popover p-2 shadow-xl sm:w-max sm:min-w-[280px] sm:max-w-[min(520px,calc(100vw-2rem))]"
        >
          {workspaces.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">No workspaces configured.</p>
          )}
          {workspaces.map((workspace) => (
            <button
              key={workspace.path}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onAttachWorkspace(session.id, workspace.path);
              }}
              className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <FolderOpenIcon className="size-4 text-muted-foreground" />
              <span className="grid min-w-0">
                <span className="truncate font-medium text-foreground">{workspace.label}</span>
                <span className="truncate text-[11px] text-muted-foreground">{workspace.path}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  if (!status || status === "idle") return null;
  return (
    <span
      className={cn(
        "header-status hidden rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide sm:inline-flex",
        status === "running" && "border-blue-400/40 bg-blue-400/10 text-blue-400",
        status === "connecting" && "border-yellow-400/40 bg-yellow-400/10 text-yellow-500",
        status === "disconnected" && "border-border/60 bg-muted/50 text-muted-foreground",
        status === "error" && "border-red-400/40 bg-red-400/10 text-red-400",
      )}
    >
      {status}
    </span>
  );
}
