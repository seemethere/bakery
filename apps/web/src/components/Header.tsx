import type { WebSession } from "@pi-web-agent/protocol";
import { GitBranchIcon } from "lucide-react";
import { sessionDisplayTitle, sessionMetadataLabel, type ConnectionStatus } from "@/lib/session-utils";
import { cn } from "@/lib/utils";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionDetailsDialog } from "@/components/SessionDetailsDialog";

type Props = {
  session: WebSession | null;
  connectionStatus: ConnectionStatus;
  isBootstrapping?: boolean;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  onUpdateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
};

export function Header({ session, connectionStatus, isBootstrapping = false, fetchJson, onUpdateSessionMetadata }: Props) {
  const isMobile = useIsMobile();
  const title = session ? sessionDisplayTitle(session) : null;
  const meta = session ? sessionMetadataLabel(session) : null;

  return (
    <header className="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-border/60 bg-background/80 backdrop-blur-sm min-w-0 overflow-hidden">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <SidebarTrigger
          id={isMobile ? "toggleSessionSidebarMobile" : "toggleSessionSidebar"}
          aria-label="Toggle navigation"
          className="shrink-0"
        />
        <div className="grid gap-0.5 min-w-0">
          {isBootstrapping ? (
            <>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-56 max-w-[45vw]" />
            </>
          ) : title ? (
            <>
              <strong className="text-sm font-semibold text-foreground truncate">{title}</strong>
              {meta && <span className="text-xs text-muted-foreground truncate">{meta}</span>}
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
      <div className="flex items-center gap-2 flex-shrink-0">
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

function StatusPill({ status }: { status: ConnectionStatus }) {
  if (!status || status === "idle") return null;
  return (
    <span
      className={cn(
        "text-[11px] font-bold px-2.5 py-1 rounded-full border uppercase tracking-wide",
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
