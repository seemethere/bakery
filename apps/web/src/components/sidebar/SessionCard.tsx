import { useEffect, useRef, useState } from "react";
import type { WebSession } from "@pi-web-agent/protocol";
import { MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  relativeTime,
  sessionActivityValue,
  sessionConnectionStatus,
  sessionDisplayTitle,
  sessionWorkspaceLabel,
  type ConnectionStatus,
} from "@/lib/session-utils";

type Props = {
  session: WebSession;
  selectedSessionId: string | undefined;
  connectionStatus: ConnectionStatus;
  showWorkspaceBadge?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
};

export function SessionCard({
  session,
  selectedSessionId,
  connectionStatus,
  showWorkspaceBadge = false,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
}: Props) {
  const isSelected = session.id === selectedSessionId;
  const title = sessionDisplayTitle(session);
  const activity = sessionActivityValue(session);
  const workspaceLabel = sessionWorkspaceLabel(session);
  const rawStatus = sessionConnectionStatus(session, selectedSessionId, connectionStatus);
  const status = rawStatus && rawStatus !== "idle" ? rawStatus : undefined;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameValue(title);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [renaming, title]);

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== title) onRename(session.id, trimmed);
    setRenaming(false);
  }

  function handleRenameKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); commitRename(); }
    if (event.key === "Escape") { event.preventDefault(); setRenaming(false); }
  }

  return (
    <div
      data-session-id={session.id}
      className={cn(
        "session-card group/session-card relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-1 rounded-md text-sm transition-colors",
        "text-sidebar-foreground/70",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isSelected && "active bg-sidebar-accent text-sidebar-accent-foreground font-medium",
      )}
    >
      <button
        type="button"
        onClick={() => !renaming && onSelect(session.id)}
        className="grid min-w-0 gap-1 rounded-md px-2 py-2 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex items-center justify-between gap-2 min-w-0">
          {renaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded bg-background px-1 py-0 text-sm font-medium text-foreground outline-none ring-1 ring-ring/50"
            />
          ) : (
            <strong className="font-medium text-sidebar-foreground truncate min-w-0">{title}</strong>
          )}
          <span className="flex items-center gap-1 flex-shrink-0">
            {status && <StatusBadge variant={status as StatusVariant}>{status}</StatusBadge>}
          </span>
        </span>
        <small className="session-snippet block text-[11px] text-sidebar-foreground/40 truncate">
          {relativeTime(activity)}
        </small>
      </button>
      {showWorkspaceBadge && (
        <span
          className="pointer-events-none absolute bottom-1.5 right-2 max-w-24 truncate text-[10px] font-normal text-sidebar-foreground/40"
          title={workspaceLabel}
        >
          {workspaceLabel}
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "mr-1 mt-1 inline-flex size-7 items-center justify-center rounded-md transition-colors",
            "text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "opacity-0 group-hover/session-card:opacity-100 data-open:opacity-100",
            isSelected && "opacity-100",
          )}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Options for ${title}`}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={8}>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onTogglePin(session.id, !session.pinned); }}
          >
            {session.pinned ? <PinOffIcon /> : <PinIcon />}
            {session.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); setRenaming(true); }}
          >
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type StatusVariant = "running" | "error" | "aborting" | string;

function StatusBadge({ variant, children }: { variant: StatusVariant; children: React.ReactNode }) {
  return (
    <em
      className={cn(
        "not-italic text-[10px] uppercase px-1.5 py-px rounded-full border font-medium",
        variant === "running" && "border-blue-400/40 bg-blue-400/10 text-blue-400",
        (variant === "error" || variant === "aborting") && "border-red-400/40 bg-red-400/10 text-red-400",
        variant !== "running" && variant !== "error" && variant !== "aborting" &&
          "border-border/60 bg-muted/50 text-muted-foreground",
      )}
    >
      {children}
    </em>
  );
}
