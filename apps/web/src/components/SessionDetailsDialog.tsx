import { useEffect, useState } from "react";
import type React from "react";
import type { PreviewStackStatus, SessionMetadataSuggestion, SessionTreeNode, SessionTreeResponse, WebSession } from "@pi-web-agent/protocol";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GitBranchIcon, InfoIcon, PlayIcon, RefreshCwIcon, SparklesIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { sessionDisplayTitle } from "@/lib/session-utils";
import { currentSessionTreePath, sessionTreeNodeDisplayTitle } from "@/lib/session-tree";
import { cn } from "@/lib/utils";

type Props = {
  session: WebSession;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  onUpdateSessionMetadata: (id: string, input: { title?: string | null; summary?: string | null }) => Promise<WebSession | null>;
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

export function SessionDetailsDialog({ session, fetchJson, onUpdateSessionMetadata }: Props) {
  const [open, setOpen] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<PreviewStackStatus | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  const [sessionTree, setSessionTree] = useState<SessionTreeResponse | null>(null);
  const [copied, setCopied] = useState("");

  async function refreshPreview() {
    if (!open) return;
    setPreviewLoading(true);
    setPreviewError("");
    try {
      setPreviewStatus(await fetchJson<PreviewStackStatus>(`/api/sessions/${encodeURIComponent(session.id)}/preview-stack`));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void refreshPreview();
    void fetchJson<SessionTreeResponse>(`/api/sessions/${encodeURIComponent(session.id)}/tree`).then(setSessionTree).catch(() => setSessionTree(null));
  }, [open, session.id]);

  async function handleGenerateMetadata() {
    setMetadataLoading(true);
    setMetadataError("");
    try {
      const suggestion = await fetchJson<SessionMetadataSuggestion>(`/api/sessions/${encodeURIComponent(session.id)}/metadata/generate`, {
        method: "POST",
        body: JSON.stringify({ mode: "suggest" }),
      });
      if (suggestion.deferred || (!suggestion.title && !suggestion.summary)) {
        setMetadataError(suggestion.reason ?? "No usable suggestion was returned yet.");
        return;
      }
      await onUpdateSessionMetadata(session.id, {
        title: suggestion.title ?? session.title,
        summary: suggestion.summary ?? session.summary,
      });
    } catch (error) {
      setMetadataError(error instanceof Error ? error.message : String(error));
    } finally {
      setMetadataLoading(false);
    }
  }

  async function handlePreviewAction(action: "start" | "stop") {
    setPreviewLoading(true);
    setPreviewError("");
    try {
      setPreviewStatus(await fetchJson<PreviewStackStatus>(`/api/sessions/${encodeURIComponent(session.id)}/preview-stack/${action}`, {
        method: "POST",
      }));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCopy(label: string, value: string | null | undefined) {
    if (!value) return;
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1400);
    } catch {
      setCopied("Copy failed");
    }
  }

  const title = sessionDisplayTitle(session);
  const isIsolated = session.isolationKind === "git_worktree";
  const canStartPreview = isIsolated && previewStatus?.state !== "running" && previewStatus?.state !== "starting";
  const canStopPreview = isIsolated && (previewStatus?.state === "running" || previewStatus?.state === "starting");
  const treePath = currentSessionTreePath(sessionTree);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Session details" title="Session details" />
        }
      >
        <InfoIcon />
      </DialogTrigger>
      <DialogContent className="session-details-dialog max-h-[calc(100dvh-1rem)] overflow-y-auto p-0 sm:max-h-[min(780px,calc(100vh-2rem))] sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader className="border-b border-border/60 px-4 py-3 sm:px-5 sm:py-4">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
            <div className="grid min-w-0 gap-1.5">
              <DialogTitle className="truncate text-xl">{title}</DialogTitle>
              <DialogDescription className={cn("max-w-xl text-sm leading-6", !session.summary && "italic text-muted-foreground/70")}>
                {session.summary || "No summary yet."}
              </DialogDescription>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge tone={isIsolated ? "success" : "neutral"}>{isIsolated ? "isolated worktree" : "standard session"}</StatusBadge>
                {session.worktreeSourceDirty && <StatusBadge tone="warning">source had uncommitted changes</StatusBadge>}
                {session.metadataGenerationCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Generated {session.metadataGenerationCount}×
                  </span>
                )}
              </div>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={handleGenerateMetadata} disabled={metadataLoading} className="shrink-0">
              <SparklesIcon />
              {metadataLoading ? "Generating" : "Generate"}
            </Button>
          </div>
          {metadataError && <p className="mt-3 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{metadataError}</p>}
        </DialogHeader>

        <div className="grid gap-4 px-4 py-4 sm:gap-5 sm:px-5 sm:py-5">
          <section className="grid gap-3">
            <SectionTitle title="Workspace" />
            <div className="grid gap-2">
              <DetailRow label="Path" value={session.cwd ?? "—"} important onCopy={() => void handleCopy("Workspace copied", session.cwd ?? "")} />
              {session.worktreePath && <DetailRow label="Worktree" value={session.worktreePath} important onCopy={() => void handleCopy("Worktree copied", session.worktreePath)} />}
              {session.sourceCwd && <DetailRow label="Source" value={session.sourceCwd} onCopy={() => void handleCopy("Source copied", session.sourceCwd)} />}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <MetaTile label="Created" value={formatDate(session.createdAt)} />
              <MetaTile label="Last activity" value={formatDate(session.lastActivityAt ?? session.lastOpenedAt)} />
            </div>
          </section>

          {(session.worktreeBranch || session.worktreeBaseCommit) && (
            <section className="grid gap-3">
              <SectionTitle title="Version" />
              <div className="grid gap-2 sm:grid-cols-2">
                {session.worktreeBranch && <MetaTile label="Branch" value={session.worktreeBranch} mono />}
                {session.worktreeBaseCommit && <MetaTile label="Base commit" value={session.worktreeBaseCommit} mono />}
              </div>
            </section>
          )}

          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <SectionTitle title="Session Tree" />
              <GitBranchIcon className="size-4 text-muted-foreground" />
            </div>
          {treePath.length > 0 ? (
            <div className="grid gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">Current lineage</span>
              <div className="flex flex-wrap items-center gap-1 text-sm">
                {treePath.slice(treePath.length > 4 ? -4 : 0).map((node, index) => (
                  <span key={node.id} className="inline-flex items-center gap-1">
                    {index > 0 && <span className="text-muted-foreground">/</span>}
                    <span className={cn("rounded-md px-1.5 py-0.5", node.current ? "bg-primary text-primary-foreground" : "bg-background/70")}>
                      {sessionTreeNodeDisplayTitle(node) || node.type}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">No tree entries yet.</p>
          )}
          {sessionTree?.tree.length ? <SessionTreeLines nodes={sessionTree.tree} /> : null}
        </section>

        {isIsolated && (
        <section className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle title="Preview Stack" />
            <Button type="button" size="icon-xs" variant="ghost" onClick={() => void refreshPreview()} disabled={previewLoading} aria-label="Refresh preview stack" title="Refresh preview stack">
              <RefreshCwIcon className={cn(previewLoading && "animate-spin")} />
            </Button>
          </div>
          {previewLoading && !previewStatus ? (
            <div className="grid gap-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={previewStatus?.state === "running" ? "success" : previewStatus?.state === "error" ? "danger" : "neutral"}>
                  {previewStatus?.state ?? "unknown"}
                </StatusBadge>
                <span className="text-xs text-muted-foreground">{previewStatus?.message ?? (isIsolated ? "Preview stack is available for this worktree." : "Preview stacks require an isolated worktree session.")}</span>
              </div>
              {previewStatus?.url && (
                <DetailRow
                  label="URL"
                  value={previewStatus.url}
                  onCopy={() => void handleCopy("Preview URL copied", previewStatus.url)}
                  action={
                    <Button type="button" size="icon-xs" variant="ghost" onClick={() => window.open(previewStatus.url, "_blank", "noopener,noreferrer")} aria-label="Open preview" title="Open preview">
                      <ExternalLinkIcon />
                    </Button>
                  }
                />
              )}
              {previewStatus?.logPath && <DetailRow label="Logs" value={previewStatus.logPath} onCopy={() => void handleCopy("Log path copied", previewStatus.logPath)} />}
              <div className="flex flex-wrap gap-2">
                {canStartPreview && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void handlePreviewAction("start")} disabled={previewLoading}>
                    <PlayIcon />
                    Start
                  </Button>
                )}
                {canStopPreview && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void handlePreviewAction("stop")} disabled={previewLoading}>
                    <SquareIcon />
                    Stop
                  </Button>
                )}
              </div>
            </>
          )}
          {previewError && <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">{previewError}</p>}
        </section>
        )}

          {copied && (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              {copied !== "Copy failed" && <CheckIcon className="size-3" />}
              {copied}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>;
}

function StatusBadge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
      tone === "neutral" && "border-border bg-muted/40 text-muted-foreground",
      tone === "success" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
      tone === "warning" && "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
      tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
    )}>
      {children}
    </span>
  );
}

function prettifyNodeKind(value: string): string {
  return value.replace(/_/g, " ");
}

function SessionTreeLines({ nodes, depth = 0 }: { nodes: SessionTreeNode[]; depth?: number }) {
  return (
    <div className={cn(depth === 0 && "max-h-48 overflow-y-auto rounded-md border border-border/50 bg-muted/15 p-1")}>
      {nodes.map((node) => (
        <div key={node.id}>
          <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 text-xs", node.current && "bg-primary/10")} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
            <span className="truncate" title={node.title}>
              <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">{prettifyNodeKind(node.role ?? node.type)}</span>
              {sessionTreeNodeDisplayTitle(node) || node.title}
            </span>
            {node.current && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">current</span>}
          </div>
          {node.children.length > 0 && <SessionTreeLines nodes={node.children} depth={depth + 1} />}
        </div>
      ))}
    </div>
  );
}

function DetailRow({
  label,
  value,
  multiline = false,
  important = false,
  onCopy,
  action,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  important?: boolean;
  onCopy?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className={cn(
      "flex items-center gap-3 rounded-md border px-3 py-2",
      important ? "border-border/70 bg-background" : "border-border/50 bg-muted/15",
    )}>
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn(
        "min-w-0 flex-1 break-words",
        important ? "text-sm text-foreground" : "text-xs text-muted-foreground",
        !multiline && "font-mono text-xs truncate",
      )} title={value}>
        {value}
      </span>
      {(onCopy || action) && (
        <span className="flex shrink-0 items-center gap-1">
          {action}
          {onCopy && (
            <Button type="button" size="icon-xs" variant="ghost" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`} title={`Copy ${label.toLowerCase()}`}>
              <CopyIcon />
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

function MetaTile({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 rounded-md border border-border/50 bg-muted/15 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-sm", mono && "font-mono text-xs")} title={value}>
        {value}
      </span>
    </div>
  );
}
