import { useEffect, useRef, useState } from "react";
import type { WebSession } from "@pi-web-agent/protocol";
import { CircleAlertIcon, LoaderCircleIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  compactRelativeTime,
  relativeTime,
  sessionConnectionStatus,
  sessionWorkRecencyValue,
  sessionDisplayTitle,
  sessionMetadataLabel,
  sessionWorkspaceLabel,
  type ConnectionStatus,
} from "@/lib/session-utils";

type Props = {
  session: WebSession;
  selectedSessionId: string | undefined;
  connectionStatus: ConnectionStatus;
  showWorkspaceBadge?: boolean;
  showWorkspacePinShortcut?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
};

export function SessionCard({
  session,
  selectedSessionId,
  connectionStatus,
  showWorkspacePinShortcut = false,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
}: Props) {
  const isSelected = session.id === selectedSessionId;
  const title = sessionDisplayTitle(session);
  const activity = sessionWorkRecencyValue(session);
  const workspaceLabel = sessionWorkspaceLabel(session);
  const rawStatus = sessionConnectionStatus(session, selectedSessionId, connectionStatus);
  const status = rawStatus && rawStatus !== "idle" ? rawStatus : undefined;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameValue(title);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [renaming, title]);

  useEffect(() => {
    if (!menuDismissed) return;
    function clearDismissed(event: PointerEvent) {
      if (!(event.target instanceof Node) || !menuTriggerRef.current?.contains(event.target)) setMenuDismissed(false);
    }
    document.addEventListener("pointermove", clearDismissed, { once: true });
    return () => document.removeEventListener("pointermove", clearDismissed);
  }, [menuDismissed]);

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
        "session-card group/session-card relative rounded-md text-sm transition-colors",
        "text-sidebar-foreground/55",
        "hover:bg-sidebar-accent/55 hover:text-sidebar-foreground/80",
        isSelected && "active bg-sidebar-accent/70 text-sidebar-foreground/85 font-medium",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => !renaming && onSelect(session.id)}
              className={cn(
                "grid w-full min-w-0 rounded-md py-1.5 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                showWorkspacePinShortcut ? "pl-8" : "pl-2",
              )}
            >
              <span className="flex h-5 items-center justify-between gap-2 min-w-0">
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
                  <strong
                    className={cn(
                      "truncate min-w-0 transition-colors",
                      isSelected
                        ? "font-medium text-sidebar-foreground/85"
                        : "font-medium text-sidebar-foreground/55 group-hover/session-card:text-sidebar-foreground/80",
                    )}
                  >
                    {title}
                  </strong>
                )}
                <span className="flex items-center gap-1 flex-shrink-0">
                  {status && <StatusIndicator variant={status as StatusVariant} />}
                </span>
              </span>
            </button>
          }
        />
        <TooltipContent side="right" align="start" className="w-64 p-2.5">
          <SessionMetadataTooltip session={session} activity={activity} workspaceLabel={workspaceLabel} />
        </TooltipContent>
      </Tooltip>
      <span
        className={cn(
          "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-normal tabular-nums text-sidebar-foreground/35 transition-opacity",
          "group-hover/session-card:opacity-0 group-focus-within/session-card:opacity-0",
          menuOpen && "opacity-0",
        )}
        title={relativeTime(activity)}
        aria-hidden="true"
      >
        {compactRelativeTime(activity)}
      </span>

      {showWorkspacePinShortcut && (
        <button
          type="button"
          className={cn(
            "absolute left-2 top-1/2 inline-flex size-3.5 -translate-y-1/2 items-center justify-center text-sidebar-foreground/40 opacity-0 transition-colors hover:text-sidebar-foreground/80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/session-card:opacity-100 group-focus-within/session-card:opacity-100",
            menuDismissed && "opacity-0! group-hover/session-card:opacity-0! group-focus-within/session-card:opacity-0!",
          )}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(session.id, true);
          }}
          aria-label={`Pin ${title}`}
          title="Pin"
        >
          <PinIcon className="size-3.5" />
        </button>
      )}

      <DropdownMenu
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) {
            setMenuDismissed(true);
            requestAnimationFrame(() => menuTriggerRef.current?.blur());
          }
        }}
      >
        <DropdownMenuTrigger
          ref={menuTriggerRef}
          className={cn(
            "absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md transition-colors",
            "text-sidebar-foreground/45 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/75",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "opacity-0 group-hover/session-card:opacity-100 group-focus-within/session-card:opacity-100 data-open:opacity-100",
            menuOpen && "opacity-100",
            menuDismissed && "opacity-0! group-hover/session-card:opacity-0! group-focus-within/session-card:opacity-0! data-open:opacity-0!",
          )}
          onMouseDown={(e) => {
            e.stopPropagation();
            setMenuDismissed(false);
          }}
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

function SessionMetadataTooltip({
  session,
  activity,
  workspaceLabel,
}: {
  session: WebSession;
  activity: string | undefined;
  workspaceLabel: string;
}) {
  const fullActivity = activity ? new Date(activity) : null;
  const activityLabel = fullActivity && Number.isFinite(fullActivity.getTime())
    ? fullActivity.toLocaleString()
    : activity ?? "Never";
  const isolationLabel = session.isolationKind === "git_worktree" ? "Worktree" : "Standard";

  return (
    <div className="grid gap-2 text-xs leading-relaxed">
      <div className="min-w-0">
        <div className="truncate font-medium text-popover-foreground">{sessionDisplayTitle(session)}</div>
        <div className="truncate text-popover-foreground/55">{sessionMetadataLabel(session)}</div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-popover-foreground/65">
        <dt className="text-popover-foreground/40">Workspace</dt>
        <dd className="truncate">{workspaceLabel}</dd>
        <dt className="text-popover-foreground/40">Activity</dt>
        <dd className="truncate">{relativeTime(activity)} · {activityLabel}</dd>
        <dt className="text-popover-foreground/40">Mode</dt>
        <dd className="truncate">{session.kind === "chat_only" ? "Chat" : isolationLabel}</dd>
        {session.pinned && (
          <>
            <dt className="text-popover-foreground/40">Pinned</dt>
            <dd>Yes</dd>
          </>
        )}
      </dl>
    </div>
  );
}

type StatusVariant = "running" | "error" | "aborting" | string;

function StatusIndicator({ variant }: { variant: StatusVariant }) {
  if (variant === "running") {
    return (
      <span title="Running" aria-label="Running" className="inline-grid size-4 place-items-center text-blue-400/80">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      </span>
    );
  }
  if (variant === "aborting") {
    return (
      <span title="Stopping" aria-label="Stopping" className="inline-grid size-4 place-items-center text-red-400/75">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
      </span>
    );
  }
  if (variant === "error") {
    return (
      <span title="Error" aria-label="Error" className="inline-grid size-4 place-items-center text-red-400/80">
        <CircleAlertIcon className="size-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <em className="not-italic text-[10px] uppercase px-1.5 py-px rounded-full border border-border/60 bg-muted/50 font-medium text-muted-foreground">
      {variant}
    </em>
  );
}
