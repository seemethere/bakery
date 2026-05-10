import { useEffect, useState } from "react";
import type { Workspace, WorkspaceBrowseEntry, WorkspaceBrowseResponse } from "@pi-web-agent/protocol";
import { ArrowLeftIcon, FolderIcon, FileIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBrowse: (path?: string) => Promise<WorkspaceBrowseResponse | null>;
  onAddWorkspace: (path: string) => Promise<Workspace | null>;
  onRevokeWorkspace: (path: string) => Promise<boolean>;
  onOpenWorkspace: (path: string) => void;
};

export function WorkspaceBrowserDialog({ open, onOpenChange, onBrowse, onAddWorkspace, onRevokeWorkspace, onOpenWorkspace }: Props) {
  const [listing, setListing] = useState<WorkspaceBrowseResponse | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(path?: string, push = true) {
    setBusy(true);
    setError(null);
    const next = await onBrowse(path);
    setBusy(false);
    if (!next) {
      setError("Could not browse that directory.");
      return;
    }
    setListing(next);
    setSelectedPath(next.path);
    if (push && path && listing?.path) setHistory((prev) => [...prev, listing.path!]);
  }

  useEffect(() => {
    if (!open) return;
    setHistory([]);
    setManualPath("");
    setSelectedPath(null);
    void load(undefined, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function addAndOpen(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const workspace = await onAddWorkspace(trimmed);
    setBusy(false);
    if (!workspace) {
      setError("Could not add workspace. Make sure the path is an existing directory.");
      return;
    }
    onOpenWorkspace(workspace.path);
    onOpenChange(false);
  }

  async function revoke(path: string) {
    if (!window.confirm("Revoke workspace approval? Existing sessions stay visible, but agent/file operations are blocked unless another Browse Root or Approved Workspace still covers this path.")) return;
    setBusy(true);
    setError(null);
    const ok = await onRevokeWorkspace(path);
    setBusy(false);
    if (!ok) {
      setError("Could not revoke that workspace. Configured Browse Roots cannot be removed here.");
      return;
    }
    await load(listing?.path ?? undefined, false);
  }

  const entries = listing?.entries ?? [];
  const currentPath = listing?.path ?? null;
  const canGoBack = currentPath !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-hidden p-0 sm:max-w-2xl" showCloseButton>
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>Add workspace</DialogTitle>
          <DialogDescription>
            Browse configured roots or approve an exact local directory, then Bakery will open a new session there.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 p-5">
          <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/25 p-3">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="manualWorkspacePath">Manual approval</label>
            <div className="flex gap-2">
              <Input
                id="manualWorkspacePath"
                value={manualPath}
                onChange={(event) => setManualPath(event.currentTarget.value)}
                placeholder="/Users/you/projects/app"
                disabled={busy}
              />
              <Button type="button" size="sm" disabled={busy || !manualPath.trim()} onClick={() => void addAndOpen(manualPath)}>
                Add & open
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Adding a path approves that directory and its descendants for agent sessions.
            </p>
          </div>

          <div className="grid min-h-0 gap-2">
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="icon" disabled={busy || !canGoBack} onClick={() => {
                const previous = history.at(-1);
                setHistory((prev) => prev.slice(0, -1));
                void load(previous, false);
              }} aria-label="Back">
                <ArrowLeftIcon className="size-4" />
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{currentPath ?? "Workspace roots"}</p>
                <p className="text-xs text-muted-foreground">{currentPath ? "Select this folder or browse deeper." : "Browse Roots and Approved Workspaces"}</p>
              </div>
              <Button type="button" size="sm" disabled={busy || !selectedPath} onClick={() => selectedPath && void addAndOpen(selectedPath)}>
                <PlusIcon className="size-3.5" />
                Add & open
              </Button>
            </div>

            {error && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border/70">
              {entries.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">{busy ? "Loading…" : "No entries."}</p>
              ) : entries.map((entry) => (
                <WorkspaceEntryRow
                  key={`${entry.source}:${entry.path}`}
                  entry={entry}
                  selected={selectedPath === entry.path}
                  busy={busy}
                  onSelect={() => setSelectedPath(entry.path)}
                  onBrowse={() => entry.kind === "directory" && void load(entry.path)}
                  onRevoke={entry.source === "approved_workspace" ? () => void revoke(entry.path) : undefined}
                />
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceEntryRow({ entry, selected, busy, onSelect, onBrowse, onRevoke }: {
  entry: WorkspaceBrowseEntry;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onBrowse: () => void;
  onRevoke?: () => void;
}) {
  const isDirectory = entry.kind === "directory";
  return (
    <div className={cn("flex items-center gap-2 border-b border-border/50 px-2 py-1.5 last:border-b-0", selected && "bg-accent")}>
      <button
        type="button"
        disabled={busy}
        onClick={onSelect}
        onDoubleClick={isDirectory ? onBrowse : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
      >
        {isDirectory ? <FolderIcon className="size-4 shrink-0 text-amber-500" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{entry.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{entry.path}</span>
        </span>
      </button>
      {isDirectory && (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onBrowse}>Browse</Button>
      )}
      {onRevoke && (
        <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={onRevoke} aria-label={`Revoke ${entry.name}`}>
          <Trash2Icon className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
