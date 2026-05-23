import { useEffect, useMemo, useState } from "react";
import type { Workspace, WorkspaceBrowseEntry, WorkspaceBrowseResponse } from "@pi-web-agent/protocol";
import { ArrowLeftIcon, ChevronRightIcon, FileIcon, FolderIcon, Trash2Icon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

type BrowseRoot = Pick<WorkspaceBrowseEntry, "path" | "name" | "source">;

type Breadcrumb = {
  label: string;
  path: string;
};

export function WorkspaceBrowserDialog({ open, onOpenChange, onBrowse, onAddWorkspace, onRevokeWorkspace, onOpenWorkspace }: Props) {
  const [listing, setListing] = useState<WorkspaceBrowseResponse | null>(null);
  const [roots, setRoots] = useState<BrowseRoot[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [manualPath, setManualPath] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceBrowseEntry | null>(null);

  async function load(path?: string, push = true) {
    setBusy(true);
    setError(null);
    const previousPath = listing?.path;
    const next = await onBrowse(path);
    setBusy(false);
    if (!next) {
      setError("Could not browse that directory. Check that it still exists and is under a Browse Root or Approved Workspace.");
      return;
    }
    setListing(next);
    if (next.path === null) {
      setRoots(next.entries.filter((entry) => entry.kind === "directory" && entry.source !== "child"));
      setSelectedPath(null);
    } else {
      setSelectedPath(next.path);
    }
    if (push && path && previousPath) setHistory((prev) => [...prev, previousPath]);
  }

  useEffect(() => {
    if (!open) return;
    setHistory([]);
    setManualPath("");
    setManualOpen(false);
    setSelectedPath(null);
    setRevokeTarget(null);
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
      setError("Could not add workspace. Enter the path to an existing local directory and try again.");
      return;
    }
    onOpenWorkspace(workspace.path);
    onOpenChange(false);
  }

  async function confirmRevoke() {
    if (!revokeTarget) return;
    setBusy(true);
    setError(null);
    const ok = await onRevokeWorkspace(revokeTarget.path);
    setBusy(false);
    if (!ok) {
      setError("Could not revoke that workspace. Configured Browse Roots cannot be removed here.");
      return;
    }
    setRevokeTarget(null);
    await load(listing?.path ?? undefined, false);
  }

  const entries = listing?.entries ?? [];
  const currentPath = listing?.path ?? null;
  const selectedEntry = entries.find((entry) => entry.path === selectedPath);
  const selectedDirectoryPath = selectedEntry?.kind === "directory" ? selectedEntry.path : currentPath;
  const selectedDirectorySource = selectedEntry?.kind === "directory"
    ? displaySourceForEntry(selectedEntry, roots)
    : sourceForPath(currentPath, roots);
  const selectedDirectoryAlreadyAdded = selectedDirectorySource !== "child";
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath, roots), [currentPath, roots]);
  const canGoBack = currentPath !== null;
  const primaryActionLabel = selectedDirectoryAlreadyAdded
    ? "Already added"
    : selectedDirectoryPath === currentPath ? "Open here" : "Open selected";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] overflow-hidden overscroll-contain p-0 sm:max-w-2xl" showCloseButton>
          <DialogHeader className="border-b border-border/60 px-5 py-4">
            <DialogTitle>Add workspace</DialogTitle>
          </DialogHeader>

          <div className="grid min-h-0 gap-4 p-5">
            <div className="grid min-h-0 gap-3">
              <div className="flex items-start gap-2">
                {canGoBack && (
                  <Button type="button" variant="ghost" size="icon" disabled={busy} onClick={() => {
                    const previous = history.at(-1);
                    setHistory((prev) => prev.slice(0, -1));
                    void load(previous, false);
                  }} aria-label="Back">
                    <ArrowLeftIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
                <div className="min-w-0 flex-1">
                  <Breadcrumbs
                    breadcrumbs={breadcrumbs}
                    atRoots={currentPath === null}
                    busy={busy}
                    onSelect={(path) => {
                      setHistory([]);
                      void load(path, false);
                    }}
                  />
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {selectedDirectoryPath ?? (currentPath ? "Select this folder or browse deeper." : "Choose a starting folder.")}
                  </p>
                </div>
                <Button type="button" size="sm" aria-busy={busy} disabled={busy || !selectedDirectoryPath || selectedDirectoryAlreadyAdded} onClick={() => selectedDirectoryPath && !selectedDirectoryAlreadyAdded && void addAndOpen(selectedDirectoryPath)}>
                  {primaryActionLabel}
                </Button>
              </div>

              {error && (
                <Alert variant="destructive" role="alert" aria-live="assertive">
                  <AlertTitle>Workspace action failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="max-h-[380px] overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-background/60" aria-label="Workspace folders" aria-busy={busy}>
                {entries.length === 0 ? (
                  <p className="px-3 py-10 text-center text-sm text-muted-foreground" role="status" aria-live="polite">{busy ? "Loading…" : "No entries."}</p>
                ) : (
                  <ul>
                    {entries.map((entry) => {
                      const displaySource = displaySourceForEntry(entry, roots);
                      return (
                        <WorkspaceEntryRow
                          key={`${entry.source}:${entry.path}`}
                          entry={entry}
                          displaySource={displaySource}
                          selected={selectedPath === entry.path}
                          busy={busy}
                          onSelect={() => entry.kind === "directory" && setSelectedPath(entry.path)}
                          onBrowse={() => entry.kind === "directory" && void load(entry.path)}
                          onRevoke={displaySource === "approved_workspace" ? () => setRevokeTarget(entry) : undefined}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
              <div>
                <CollapsibleTrigger
                  render={
                    <button type="button" className="flex items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                      <ChevronRightIcon className={cn("size-3 text-muted-foreground transition-transform", manualOpen && "rotate-90")} aria-hidden="true" />
                      <span>Paste a path instead</span>
                    </button>
                  }
                />
                <CollapsibleContent>
                  <div className="mt-2 grid gap-2 rounded-lg border border-border/60 bg-muted/15 p-3">
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="manualWorkspacePath">Manual path approval</label>
                    <div className="flex gap-2">
                      <Input
                        id="manualWorkspacePath"
                        name="workspacePath"
                        autoComplete="off"
                        spellCheck={false}
                        value={manualPath}
                        onChange={(event) => setManualPath(event.currentTarget.value)}
                        placeholder="/Users/you/projects/app…"
                        disabled={busy}
                      />
                      <Button type="button" size="sm" aria-busy={busy} disabled={busy || !manualPath.trim()} onClick={() => void addAndOpen(manualPath)}>
                        Add & open
                      </Button>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Use this when the folder is outside the visible roots.
                    </p>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(nextOpen) => !nextOpen && setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Revoke workspace approval?</DialogTitle>
            <DialogDescription>
              Existing sessions will stay visible, but Bakery will block agent and file operations unless another Browse Root or Approved Workspace still covers this path.
            </DialogDescription>
          </DialogHeader>
          {revokeTarget && <p className="break-words rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{revokeTarget.path}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRevokeTarget(null)}>Cancel</Button>
            <Button type="button" variant="destructive" aria-busy={busy} disabled={busy} onClick={() => void confirmRevoke()}>
              Revoke approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Breadcrumbs({ breadcrumbs, atRoots, busy, onSelect }: {
  breadcrumbs: Breadcrumb[];
  atRoots: boolean;
  busy: boolean;
  onSelect: (path: string) => void;
}) {
  if (atRoots || breadcrumbs.length === 0) {
    return <p className="truncate text-sm font-medium">Browse Roots</p>;
  }
  return (
    <nav aria-label="Folder breadcrumbs" className="flex min-w-0 flex-wrap items-center gap-1 text-sm font-medium">
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {isLast ? (
              <span className="max-w-44 truncate rounded px-1.5 py-1 text-foreground" aria-current="page">{crumb.label}</span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onSelect(crumb.path)}
                className="max-w-36 truncate rounded px-1.5 py-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function WorkspaceEntryRow({ entry, displaySource, selected, busy, onSelect, onBrowse, onRevoke }: {
  entry: WorkspaceBrowseEntry;
  displaySource: WorkspaceBrowseEntry["source"];
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onBrowse: () => void;
  onRevoke?: () => void;
}) {
  const isDirectory = entry.kind === "directory";
  return (
    <li className={cn("group/row flex items-center gap-1 border-b border-border/40 px-2 py-1 last:border-b-0", selected && "bg-accent/70")}>
      <button
        type="button"
        disabled={busy || !isDirectory}
        onClick={onSelect}
        onDoubleClick={isDirectory ? onBrowse : undefined}
        title={entry.path}
        className={cn(
          "flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          isDirectory ? "hover:bg-accent" : "cursor-default opacity-50",
        )}
      >
        {isDirectory ? <FolderIcon className={cn("size-4 shrink-0", folderIconColor(displaySource))} aria-hidden="true" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.name}</span>
        </span>
      </button>
      {isDirectory && (
        <div className="flex w-14 shrink-0 items-center justify-end gap-1">
          {onRevoke ? (
            <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={onRevoke} aria-label={`Revoke ${entry.name}`} className="text-muted-foreground opacity-0 hover:text-destructive hover:opacity-100 group-hover/row:opacity-60 group-focus-within/row:opacity-60">
              <Trash2Icon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : (
            <span className="size-7" aria-hidden="true" />
          )}
          <Button type="button" variant="ghost" size="icon-sm" disabled={busy} onClick={onBrowse} aria-label={`Browse ${entry.name}`} className="text-muted-foreground opacity-45 hover:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            <ChevronRightIcon className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </li>
  );
}

function displaySourceForEntry(entry: WorkspaceBrowseEntry, roots: BrowseRoot[]): WorkspaceBrowseEntry["source"] {
  if (entry.source !== "child") return entry.source;
  return sourceForPath(entry.path, roots);
}

function sourceForPath(path: string | null, roots: BrowseRoot[]): WorkspaceBrowseEntry["source"] {
  if (!path) return "child";
  return roots.find((root) => samePath(root.path, path))?.source ?? "child";
}

function folderIconColor(source: WorkspaceBrowseEntry["source"]) {
  if (source === "browse_root") return "text-sky-400";
  if (source === "approved_workspace") return "text-emerald-400";
  return "text-amber-500";
}

function buildBreadcrumbs(currentPath: string | null, roots: BrowseRoot[]): Breadcrumb[] {
  if (!currentPath) return [];
  const root = roots
    .filter((candidate) => isWithinOrEqual(candidate.path, currentPath))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return [{ label: currentPath, path: currentPath }];

  const breadcrumbs: Breadcrumb[] = [{ label: root.name, path: root.path }];
  const relativePath = trimSlashes(currentPath.slice(root.path.length));
  if (!relativePath) return breadcrumbs;

  let accumulated = root.path.replace(/\/+$/, "");
  for (const segment of relativePath.split("/").filter(Boolean)) {
    accumulated = `${accumulated}/${segment}`;
    breadcrumbs.push({ label: segment, path: accumulated });
  }
  return breadcrumbs;
}

function isWithinOrEqual(root: string, path: string) {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function samePath(a: string, b: string) {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(path: string) {
  return path.replace(/\/+$/, "");
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}
