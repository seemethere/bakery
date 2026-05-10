import { useEffect, useMemo, useState } from "react";
import type { WebSession, Workspace } from "@pi-web-agent/protocol";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";

import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
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
  Sidebar as SidebarPrimitive,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  groupedByWorkspace,
  persistCollapsedWorkspaceGroups,
  pinnedSessions,
  sessionDisplayTitle,
  storedCollapsedWorkspaceGroups,
  workspaceGroupExpanded,
  type ConnectionStatus,
  type SessionWorkspaceGroup,
} from "@/lib/session-utils";
import { type AppRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { SessionCard } from "./SessionCard";

type Props = {
  selectedSession: WebSession | null;
  sessions: WebSession[];
  workspaces: Workspace[];
  selectedWorkspacePath: string;
  route: AppRoute;
  connectionStatus: ConnectionStatus;
  isBootstrapping?: boolean;
  onSelectSession: (id: string) => void;
  onNewSession: (cwd?: string) => void;
  onNewIsolatedSession: (cwd?: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
  onNavigate: (path: string) => void;
  onWorkspaceChange: (path: string) => void;
  onOpenSettings: () => void;
};

export function Sidebar({
  selectedSession,
  sessions,
  workspaces,
  selectedWorkspacePath,
  connectionStatus,
  isBootstrapping = false,
  onSelectSession,
  onNewSession,
  onNewIsolatedSession,
  onDeleteSession,
  onRenameSession,
  onTogglePinSession,
  onOpenSettings,
}: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => storedCollapsedWorkspaceGroups(),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    persistCollapsedWorkspaceGroups(collapsedGroups);
  }, [collapsedGroups]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "i") {
        e.preventDefault();
        onNewSession();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onNewSession]);

  function toggleGroup(id: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const pinned = useMemo(() => pinnedSessions(sessions), [sessions]);
  const workspaceGroups = useMemo(
    () => groupedByWorkspace(sessions, workspaces),
    [sessions, workspaces],
  );
  const chatSessions = useMemo(
    () => sessions
      .filter((s) => !s.pinned && !s.cwd && !s.sourceCwd && (s.kind === "chat_only" || s.kind === "draft"))
      .sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()),
    [sessions],
  );

  return (
    <SidebarPrimitive id="sessionSidebar" className="session-sidebar" collapsible="icon">
      <SidebarHeader className="gap-1.5 pb-2">
        {!isMobile && <SidebarBrand />}

        <div className="flex w-full gap-0 group-data-[collapsible=icon]:block">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  id="newSession"
                  onClick={() => onNewSession()}
                  className="group/new-session h-8 flex-1 justify-start gap-1.5 rounded-r-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-md group-data-[collapsible=icon]:px-0"
                >
                  <PlusIcon className="size-4" />
                  <span className="flex-1 text-left group-data-[collapsible=icon]:hidden">New session</span>
                  <kbd className="rounded border border-primary-foreground/30 px-1 py-0.5 text-[9px] tracking-wide text-primary-foreground/70 opacity-0 transition-opacity group-hover/new-session:opacity-100 group-data-[collapsible=icon]:hidden">
                    ⌘I
                  </kbd>
                </Button>
              }
            />
            <TooltipContent side="right">New session ⌘I</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="h-8 w-8 rounded-l-none border-l border-primary-foreground/20 px-0 group-data-[collapsible=icon]:hidden"
                  aria-label="More session types"
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-48">
              <DropdownMenuItem onClick={() => onNewIsolatedSession()}>
                <FolderGit2Icon />
                Isolated session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {!isMobile && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={() => setSearchOpen(true)}
                  className="group/search flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0"
                >
                  <SearchIcon className="size-3.5 text-sidebar-foreground/40" />
                  <span className="flex-1 truncate text-xs text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden">
                    Search sessions…
                  </span>
                  <kbd className="rounded border border-sidebar-border/60 px-1 py-0.5 text-[9px] tracking-wide text-sidebar-foreground/30 opacity-0 transition-opacity group-hover/search:opacity-100 group-data-[collapsible=icon]:hidden">
                    ⌘K
                  </kbd>
                </button>
              }
            />
            <TooltipContent side="right">Search sessions ⌘K</TooltipContent>
          </Tooltip>
        )}
      </SidebarHeader>

      <SidebarContent>
        {pinned.length > 0 && !isBootstrapping && (
          <SidebarGroup className="py-0 group-data-[collapsible=icon]:hidden">
            <div className="flex h-6 items-center px-2">
              <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/30">
                Pinned
              </span>
            </div>
            <SidebarGroupContent>
              <div className="grid gap-1">
                {pinned.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    selectedSessionId={selectedSession?.id}
                    connectionStatus={connectionStatus}
                    showWorkspaceBadge
                    onSelect={onSelectSession}
                    onDelete={onDeleteSession}
                    onRename={onRenameSession}
                    onTogglePin={onTogglePinSession}
                  />
                ))}
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {pinned.length > 0 && (
          <div className="mx-3 mb-1 border-t border-sidebar-border/50 group-data-[collapsible=icon]:hidden" />
        )}

        <SidebarGroup className="py-0 group-data-[collapsible=icon]:hidden">
          <div className="flex h-7 items-center px-2">
            <span className="flex-1 text-[10px] uppercase tracking-wider text-sidebar-foreground/30">
              Workspaces
            </span>
          </div>

          {isBootstrapping ? (
            <RecentSessionsSkeleton />
          ) : workspaceGroups.length === 0 ? (
            <p className="mx-2 my-1 rounded-md border border-sidebar-border bg-sidebar-accent/35 px-2 py-2 text-xs leading-relaxed text-sidebar-foreground/60">
              No workspaces or sessions yet.
            </p>
          ) : (
            workspaceGroups.map((group) => (
              <WorkspaceGroup
                key={group.id}
                group={group}
                selectedSessionId={selectedSession?.id}
                connectionStatus={connectionStatus}
                isActiveWorkspace={group.path === selectedWorkspacePath}
                expanded={workspaceGroupExpanded(group, selectedSession?.id, collapsedGroups, selectedWorkspacePath)}
                onToggle={() => toggleGroup(group.id)}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
                onRenameSession={onRenameSession}
                onTogglePinSession={onTogglePinSession}
                onNewSessionInWorkspace={(cwd) => onNewSession(cwd)}
              />
            ))
          )}
        </SidebarGroup>

        {!isBootstrapping && chatSessions.length > 0 && (
          <SidebarGroup className="py-0 group-data-[collapsible=icon]:hidden">
            <div className="group/chatshead flex h-7 items-center px-2">
              <span className="flex-1 text-[10px] uppercase tracking-wider text-sidebar-foreground/30">
                Chats
              </span>
              <button
                type="button"
                aria-label="New chat"
                title="New chat (no workspace)"
                onClick={() => onNewSession()}
                className="flex size-4 items-center justify-center rounded text-sidebar-foreground/40 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/chatshead:opacity-100 focus:opacity-100"
              >
                <PlusIcon className="size-3" />
              </button>
            </div>
            <SidebarGroupContent>
              <div className="grid gap-1">
                {chatSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    selectedSessionId={selectedSession?.id}
                    connectionStatus={connectionStatus}
                    onSelect={onSelectSession}
                    onDelete={onDeleteSession}
                    onRename={onRenameSession}
                    onTogglePin={onTogglePinSession}
                  />
                ))}
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip>
              <TooltipTrigger
                render={
                    <SidebarMenuButton
                      data-route-path="/settings"
                      onClick={onOpenSettings}
                      tooltip="Settings"
                      className="text-sidebar-foreground/60 hover:text-sidebar-foreground"
                  >
                    <SettingsIcon />
                    <span>Settings</span>
                  </SidebarMenuButton>
                }
              />
              <TooltipContent side="right">Settings</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />

      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput placeholder="Search sessions, workspaces, actions…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => {
                onNewSession();
                setSearchOpen(false);
              }}
            >
              <PlusIcon />
              <span>New session</span>
              <CommandShortcut>⌘I</CommandShortcut>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                onNewIsolatedSession();
                setSearchOpen(false);
              }}
            >
              <FolderGit2Icon />
              <span>New isolated session</span>
            </CommandItem>
            <CommandItem
              onSelect={() => {
                onOpenSettings();
                setSearchOpen(false);
              }}
            >
              <SettingsIcon />
              <span>Open settings</span>
            </CommandItem>
          </CommandGroup>
          {pinned.length > 0 && (
            <CommandGroup heading="Pinned">
              {pinned.map((session) => (
                <CommandItem
                  key={session.id}
                  value={`${sessionDisplayTitle(session)} ${session.id}`}
                  keywords={["pinned"]}
                  onSelect={() => {
                    onSelectSession(session.id);
                    setSearchOpen(false);
                  }}
                >
                  <PinIcon className="text-sidebar-foreground/60" />
                  <span>{sessionDisplayTitle(session)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {workspaceGroups.map((group) =>
            group.sessions.length > 0 ? (
              <CommandGroup key={group.id} heading={group.label}>
                {group.sessions.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={`${sessionDisplayTitle(session)} ${session.id}`}
                    keywords={[group.label]}
                    onSelect={() => {
                      onSelectSession(session.id);
                      setSearchOpen(false);
                    }}
                  >
                    <span className="size-1.5 rounded-full bg-foreground/30 shrink-0" />
                    <span>{sessionDisplayTitle(session)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null,
          )}
        </CommandList>
      </CommandDialog>
    </SidebarPrimitive>
  );
}

function WorkspaceGroup({
  group,
  selectedSessionId,
  connectionStatus,
  isActiveWorkspace,
  expanded,
  onToggle,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onTogglePinSession,
  onNewSessionInWorkspace,
}: {
  group: SessionWorkspaceGroup;
  selectedSessionId: string | undefined;
  connectionStatus: ConnectionStatus;
  isActiveWorkspace: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePinSession: (id: string, pinned: boolean) => void;
  onNewSessionInWorkspace: (cwd: string) => void;
}) {
  return (
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger
        render={
          <button className="group/wg flex h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-sidebar-accent">
            <ChevronRightIcon
              className={cn(
                "size-3 text-sidebar-foreground/40 transition-transform duration-150",
                expanded && "rotate-90",
              )}
            />
            <span
              className={cn(
                "flex-1 truncate text-xs",
                isActiveWorkspace
                  ? "font-medium text-sidebar-foreground"
                  : "text-sidebar-foreground/60",
              )}
            >
              {group.label}
            </span>
            {isActiveWorkspace && (
              <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" aria-hidden="true" />
            )}
            <span
              role="button"
              tabIndex={0}
              aria-label={`New session in ${group.label}`}
              title={`New session in ${group.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onNewSessionInWorkspace(group.path);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onNewSessionInWorkspace(group.path);
                }
              }}
              className="hidden size-4 items-center justify-center rounded text-sidebar-foreground/40 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover/wg:opacity-100 group-hover/wg:flex focus:opacity-100 focus:flex"
            >
              <PlusIcon className="size-3" />
            </span>
            <span className="text-[10px] text-sidebar-foreground/30 group-hover/wg:hidden">
              {group.sessions.length}
            </span>
          </button>
        }
      />
      <CollapsibleContent>
        {group.sessions.length === 0 ? (
          <p className="px-4 py-1.5 text-xs text-sidebar-foreground/30 italic">
            No sessions
          </p>
        ) : (
          <div className="grid gap-1 pt-1">
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
      </CollapsibleContent>
    </Collapsible>
  );
}

function RecentSessionsSkeleton() {
  return (
    <div className="grid gap-2 px-2 py-1 group-data-[collapsible=icon]:hidden" aria-hidden="true">
      <div className="flex h-7 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Skeleton className="size-3 rounded-sm" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-3 w-4" />
      </div>
      <div className="grid gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="grid gap-1 rounded-md px-0 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3.5 w-[58%]" />
              <Skeleton className="h-4 w-10 rounded-full" />
            </div>
            <Skeleton className="h-3 w-[78%]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SidebarBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!">
          <BrandLogo className="size-8" />
          <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">bakery</span>
          </div>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
