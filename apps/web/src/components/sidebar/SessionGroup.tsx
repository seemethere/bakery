import { ChevronDown, ChevronRight } from "lucide-react";
import { SessionCard } from "./SessionCard";
import type { ConnectionStatus, SessionRecencyGroup } from "@/lib/session-utils";

type Props = {
  group: SessionRecencyGroup;
  selectedSessionId: string | undefined;
  connectionStatus: ConnectionStatus;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
};

export function SessionGroup({
  group,
  selectedSessionId,
  connectionStatus,
  expanded,
  onToggle,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onTogglePinSession,
}: Props) {
  return (
    <section className="grid gap-1 group-data-[collapsible=icon]:hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <span className="truncate">{group.label}</span>
        </span>
        <small className="text-sidebar-foreground/30">{group.sessions.length}</small>
      </button>
      {expanded && (
        <div className="grid gap-1">
          {group.sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              selectedSessionId={selectedSessionId}
              connectionStatus={connectionStatus}
              onSelect={onSelectSession}
              onDelete={onDeleteSession}
              onRename={onRenameSession}
              onTogglePin={onTogglePinSession}
            />
          ))}
        </div>
      )}
    </section>
  );
}
