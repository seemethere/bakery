import React, { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ComponentProps } from "react";
import type { ExtensionCatalog, SessionTreeNode } from "@pi-web-agent/protocol";
import { CheckIcon, ClipboardListIcon, CopyIcon, GitForkIcon, LoaderCircleIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { type PlanCardData, type TranscriptItem, type TranscriptSegment, toolHeaderDisplay, formatToolDuration, compactToolSummary, detectPlanCard, isGeneratingPlan, isRecord, isDeveloperBashItem } from "@/lib/transcript";
import { hasSubagentCard, SubagentCard } from "./SubagentCard";
import { extensionCardPayload } from "@/lib/extension-cards";
import { forkEntryIdForTranscriptItem } from "@/lib/session-tree";

type TranscriptRenderContext = {
  sessionId: string;
  sessionCwd: string | null;
  apiBase: string;
  token: string;
  extensionCatalog: ExtensionCatalog | null;
  sessionTreeNodes: SessionTreeNode[];
  onFork: (entryId: string) => void | Promise<void>;
  onAcceptPlan?: () => void;
};

type MarkdownImageProps = ComponentProps<"img">;

// ---- Markdown ---------------------------------------------------------------

function isLocalImagePath(value: string): boolean {
  return /(?:^file:\/\/|^\/|^\.{0,2}\/|^[\w@.+-]+\/).+\.(?:png|jpe?g|gif|webp|svg)$/i.test(value);
}

function normalizeImageArtifactPath(path: string, sessionCwd: string | null): { originalPath: string; workspacePath?: string } | null {
  const raw = path.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:\/\//i.test(raw)) return null;
  let decoded: string;
  try {
    decoded = /^file:\/\//i.test(raw) ? decodeURIComponent(raw.replace(/^file:\/\/+/i, "/")) : raw;
  } catch {
    return null;
  }
  const normalizedCwd = sessionCwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  let normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalized) || normalized.includes("\0")) return null;
  if (normalized.startsWith(".bakery/artifacts/")) return { originalPath: normalized };
  if (normalized.startsWith("/") && normalizedCwd) {
    if (normalized === normalizedCwd) return null;
    if (!normalized.startsWith(`${normalizedCwd}/`)) return { originalPath: normalized };
    normalized = normalized.slice(normalizedCwd.length + 1);
  }
  normalized = normalized.replace(/^\.\//, "");
  if (normalized.startsWith(".bakery/artifacts/")) return { originalPath: normalized };
  if (!normalized.startsWith("/") && /^(?:[^/]+\/)+[^/]+\.(?:png|jpe?g|gif|webp|svg)$/i.test(normalized)) return { originalPath: decoded, workspacePath: normalized };
  return { originalPath: normalized };
}

function localImageUrl(path: string, context: Pick<TranscriptRenderContext, "apiBase" | "sessionId" | "sessionCwd" | "token">): string | null {
  const imagePath = normalizeImageArtifactPath(path, context.sessionCwd);
  if (!imagePath) return null;
  const url = new URL(`${context.apiBase}/api/sessions/${encodeURIComponent(context.sessionId)}/${imagePath.workspacePath ? "files" : "artifacts"}/raw`);
  url.searchParams.set("path", imagePath.workspacePath ?? imagePath.originalPath);
  if (context.token) url.searchParams.set("token", context.token);
  return url.toString();
}

const localImagePathPattern = /(?:^|[\s([{"'`])((?:(?:file:\/\/)?\/|\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.(?:png|jpe?g|gif|webp|svg))(?![\w.-])/gi;

function localImageArtifacts(text: string, context: TranscriptRenderContext, suppressedPaths = new Set<string>()): Array<{ path: string; url: string }> {
  const seen = new Set<string>();
  const artifacts: Array<{ path: string; url: string }> = [];
  for (const match of text.matchAll(localImagePathPattern)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path || path.includes("...") || path.includes("…") || seen.has(path) || suppressedPaths.has(path)) continue;
    const url = localImageUrl(path, context);
    if (!url) continue;
    seen.add(path);
    artifacts.push({ path, url });
    if (artifacts.length >= 12) break;
  }
  return artifacts;
}

const markdownImageHrefPattern = /!\[[^\]]*\]\(\s*<?([^\s>)]+)>?(?:\s+["'][^"']*["'])?\s*\)/gi;

function markdownLocalImagePaths(text: string, context: TranscriptRenderContext): Set<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(markdownImageHrefPattern)) {
    const href = match[1]?.replace(/^\.\//, "");
    if (!href || !isLocalImagePath(href) || !localImageUrl(href, context)) continue;
    paths.add(href);
  }
  return paths;
}

function promptAttachmentArtifactPaths(text: string, context: TranscriptRenderContext): Set<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(/^\s*Screenshot artifact:\s*(\S+\.(?:png|jpe?g|gif|webp|svg))\s*$/gim)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path || !localImageUrl(path, context)) continue;
    paths.add(path);
  }
  return paths;
}

function mergeSuppressedPaths(...sets: Array<Set<string> | undefined>): Set<string> {
  const merged = new Set<string>();
  for (const set of sets) for (const value of set ?? []) merged.add(value);
  return merged;
}

function MarkdownContent({ text, context, className }: { text: string; context: TranscriptRenderContext; className?: string }) {
  return (
    <div className={cn("markdown-body prose prose-sm dark:prose-invert max-w-none", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt, ...props }: MarkdownImageProps) => {
            const resolved = src ? localImageUrl(src, context) ?? src : undefined;
            return <img {...props} src={resolved} alt={alt ?? ""} loading="lazy" className="max-w-full rounded border border-border/50" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
      <LocalImageGrid artifacts={localImageArtifacts(text, context, mergeSuppressedPaths(markdownLocalImagePaths(text, context), promptAttachmentArtifactPaths(text, context)))} />
    </div>
  );
}

// ---- Segment ----------------------------------------------------------------

function Segment({ segment, showThinking, context }: { segment: TranscriptSegment; showThinking: boolean; context: TranscriptRenderContext }) {
  if (segment.kind === "markdown") {
    return <MarkdownContent text={segment.text} context={context} />;
  }
  if (segment.kind === "thinking") {
    if (!showThinking) {
      return <p className="m-0 text-xs italic text-muted-foreground/60">Thinking...</p>;
    }
    return (
      <details className="opacity-50 text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground">Thinking…</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{segment.text}</pre>
      </details>
    );
  }
  if (segment.kind === "toolCall") {
    return <span className="block text-xs text-muted-foreground font-mono">{segment.label}</span>;
  }
  if (segment.kind === "image") {
    if (segment.src) {
      return (
        <figure className="my-2">
          <img src={segment.src} alt={segment.label} className="max-w-full rounded border border-border/50" loading="lazy" />
        </figure>
      );
    }
    return <span className="text-xs text-muted-foreground italic">{segment.label}</span>;
  }
  // pre
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{segment.text}</pre>
  );
}

function Segments({ segments, showThinking, context }: { segments: TranscriptSegment[]; showThinking: boolean; context: TranscriptRenderContext }) {
  return (
    <div className="flex flex-col gap-1">
      {segments.map((seg, i) => <Segment key={i} segment={seg} showThinking={showThinking} context={context} />)}
    </div>
  );
}

function LocalImageGrid({ artifacts }: { artifacts: Array<{ path: string; url: string }> }) {
  if (artifacts.length === 0) return null;
  return (
    <div className="not-prose mt-2 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
      {artifacts.map((artifact) => (
        <figure key={artifact.path} data-testid="artifact-image" className="m-0 overflow-hidden rounded-lg border border-border/50 bg-muted/20">
          <img src={artifact.url} alt={artifact.path} loading="lazy" className="max-h-56 w-full object-contain" />
          <figcaption className="truncate px-2 py-1 text-[11px] text-muted-foreground" title={artifact.path}>{artifact.path.split("/").pop()}</figcaption>
        </figure>
      ))}
    </div>
  );
}

// ---- Row actions ------------------------------------------------------------

function copyableText(item: TranscriptItem): string {
  const segmentText = item.segments
    ?.map((segment) => "text" in segment ? segment.text : segment.label)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return segmentText || item.body || item.title;
}

function RowActions({ item, context, align = "end" }: { item: TranscriptItem; context?: TranscriptRenderContext; align?: "start" | "end" }) {
  const [copied, setCopied] = useState(false);
  const text = copyableText(item);
  const forkEntryId = context ? forkEntryIdForTranscriptItem(item, context.sessionTreeNodes) : null;
  if (!text.trim() && !forkEntryId) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="opacity-0 transition-opacity group-hover/row:opacity-100 focus:opacity-100 data-[popup-open]:opacity-100"
            aria-label="Message actions"
            title="Message actions"
            data-row-action="menu"
          />
        }
      >
        {copied ? <CheckIcon /> : <MoreHorizontalIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="message-action-menu w-44">
        {text.trim() && (
          <DropdownMenuItem data-row-action="copy" onClick={() => void handleCopy()}>
            <CopyIcon />
            Copy
          </DropdownMenuItem>
        )}
        {forkEntryId && context && (
          <DropdownMenuItem data-row-action="fork" onClick={() => void context.onFork(forkEntryId)}>
            <GitForkIcon />
            Fork from here
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CopyMessageButton({ item }: { item: TranscriptItem }) {
  const [copied, setCopied] = useState(false);
  const text = copyableText(item);
  if (!text.trim()) return null;

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => void handleCopy()}
      aria-label={copied ? "Copied message" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      data-row-action="copy"
      className="size-6 rounded-md p-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

// ---- User row ---------------------------------------------------------------

function ForkButton({ item, context }: { item: TranscriptItem; context: TranscriptRenderContext }) {
  const entryId = forkEntryIdForTranscriptItem(item, context.sessionTreeNodes);
  if (!entryId) return null;
  return (
    <Button type="button" variant="ghost" size="icon-xs" onClick={() => void context.onFork(entryId)} aria-label="Fork from here" title="Fork from here" data-row-action="fork" className="size-6 rounded-md p-0 text-muted-foreground hover:text-foreground">
      <GitForkIcon />
    </Button>
  );
}

function MessageActions({ item, context, align = "start" }: { item: TranscriptItem; context: TranscriptRenderContext; align?: "start" | "end" }) {
  return (
    <div className={cn("flex gap-1", align === "end" && "justify-end")}>
      <CopyMessageButton item={item} />
      <ForkButton item={item} context={context} />
    </div>
  );
}

function UserRow({ item, showThinking, context }: { item: TranscriptItem; showThinking: boolean; context: TranscriptRenderContext }) {
  const segments = item.segments?.filter((s) => s.kind !== "toolCall" && s.kind !== "thinking");
  return (
    <div className="message user flex justify-end px-4 py-2" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"}>
      <div className="grid max-w-[80%] justify-items-end gap-1">
        <div className="rounded-2xl rounded-br-sm bg-sidebar-primary/15 border border-sidebar-primary/20 px-4 py-2.5 text-sm">
          {segments && segments.length > 0
            ? <Segments segments={segments} showThinking={showThinking} context={context} />
            : <p className="text-sm">{item.body}</p>
          }
        </div>
        <MessageActions item={item} context={context} align="end" />
      </div>
    </div>
  );
}

// ---- Assistant row ----------------------------------------------------------

function AssistantRow({ item, showThinking, context }: { item: TranscriptItem; showThinking: boolean; context: TranscriptRenderContext }) {
  const isStreaming = item.status === "running";
  const segments = item.segments?.filter((s) => s.kind !== "toolCall");
  const hasContent = segments && segments.length > 0;
  const plan = detectPlanCard(item);
  const extensionCard = extensionCardPayload(item);

  if (!hasContent && !item.body.trim() && !isStreaming) return null;
  if (extensionCard) return <ExtensionCardRow item={item} payload={extensionCard} context={context} />;
  if (plan) return <PlanCardRow item={item} plan={plan} context={context} />;
  if (isGeneratingPlan(item)) return <PlanGeneratingRow item={item} context={context} />;

  return (
    <div className="message assistant px-4 py-2 max-w-[860px] mx-auto w-full" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"}>
      <div className="grid justify-items-start gap-1">
        <div className="min-w-0 w-full">
          <div className="min-w-0">
            {isStreaming ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite" aria-label="Assistant response generating">
                <LoaderCircleIcon className="size-4 animate-spin" />
                <span>Pi is responding…</span>
              </div>
            ) : hasContent
              ? <Segments segments={segments} showThinking={showThinking} context={context} />
              : <MarkdownContent text={item.body} context={context} />
            }
          </div>
        </div>
        <MessageActions item={item} context={context} />
      </div>
    </div>
  );
}

function PlanGeneratingRow({ item, context }: { item: TranscriptItem; context: TranscriptRenderContext }) {
  return (
    <div className="px-4 py-2 max-w-[860px] mx-auto w-full" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"} data-plan-generating="true">
      <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/8 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <LoaderCircleIcon className="size-4 animate-spin text-yellow-600 dark:text-yellow-300" />
          <span>Generating plan</span>
        </div>
      </div>
      <div className="mt-1">
        <MessageActions item={item} context={context} />
      </div>
    </div>
  );
}

function PlanCardRow({ item, plan, context }: { item: TranscriptItem; plan: PlanCardData; context: TranscriptRenderContext }) {
  const [decision, setDecision] = useState<"accepted" | "rejected" | null>(null);
  return (
    <div className="px-4 py-2 max-w-[860px] mx-auto w-full" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"} data-plan-card="true">
      <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/8 p-4 text-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              <ClipboardListIcon className="size-4 text-yellow-600 dark:text-yellow-300" />
              <span>Plan</span>
            </div>
            <p className="mt-1 text-muted-foreground">{plan.summary}</p>
          </div>
        </div>
        <div className="grid gap-2">
          <PlanField label="Smallest next slice" value={plan.nextSlice} />
          {plan.keyFiles.length > 0 && <PlanField label="Key files" value={plan.keyFiles.join(", ")} mono />}
          <PlanField label="Validation" value={plan.validation} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
              View details
            </DialogTrigger>
            <DialogContent className="max-h-[min(820px,calc(100vh-2rem))] overflow-y-auto sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Plan Details</DialogTitle>
                <DialogDescription>Rendered `/plan` output.</DialogDescription>
              </DialogHeader>
              <MarkdownContent text={plan.markdown} context={context} />
            </DialogContent>
          </Dialog>
          <Button type="button" size="sm" onClick={() => { setDecision("accepted"); context.onAcceptPlan?.(); }} disabled={!context.onAcceptPlan} data-row-action="accept-plan">
            Accept plan
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDecision("rejected")} data-row-action="reject-plan">
            Reject / dismiss
          </Button>
          {decision && (
            <span className="self-center text-xs text-muted-foreground" role="status">
              {decision === "accepted" ? "Plan accepted." : "Plan dismissed."}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1">
        <MessageActions item={item} context={context} />
      </div>
    </div>
  );
}

function ExtensionCardRow({ item, payload, context }: { item: TranscriptItem; payload: { kind: string; props: unknown }; context: TranscriptRenderContext }) {
  const contribution = context.extensionCatalog?.cards.find((card) => card.kind === payload.kind);
  const tag = contribution?.component;
  const validTag = tag && /^[-a-z0-9]+$/.test(tag) && tag.includes("-");
  const props = JSON.stringify(payload.props ?? {});
  return (
    <div className="px-4 py-2 max-w-[860px] mx-auto w-full" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"} data-extension-card="true">
      <div className="rounded-lg border border-border/50 bg-card/60 p-4 text-sm">
        {validTag
          ? React.createElement(tag, {
            "data-extension-id": contribution.extensionId,
            "data-extension-card-kind": payload.kind,
            "data-extension-card-props": props,
          })
          : (
            <div className="grid gap-1">
              <strong>Extension card unavailable</strong>
              <span className="text-muted-foreground">{payload.kind}</span>
            </div>
          )}
      </div>
      <div className="mt-1">
        <MessageActions item={item} context={context} />
      </div>
    </div>
  );
}

function PlanField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/40 bg-background/45 px-3 py-2">
      <span className="text-[11px] font-medium uppercase text-muted-foreground">{label}</span>
      <span className={cn("break-words", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

// ---- Tool row ---------------------------------------------------------------

const toolActionColors: Record<string, string> = {
  bash: "text-amber-400",
  read: "text-blue-400",
  edit: "text-purple-400",
  write: "text-purple-400",
  grep: "text-cyan-400",
  find: "text-cyan-400",
  question: "text-yellow-400",
};

function ToolRow({ item, showThinking, context }: { item: TranscriptItem; showThinking: boolean; context: TranscriptRenderContext }) {
  const isRunning = item.status === "running";
  const isError = item.status === "error";
  const shouldDefaultOpen = isRunning || isError || isDeveloperBashItem(item);
  const [expanded, setExpanded] = useState(shouldDefaultOpen);
  const { action, target } = toolHeaderDisplay(item);
  const duration = formatToolDuration(item.durationMs);
  const summary = !isRunning ? compactToolSummary(item) : "";
  const hasBody = Boolean(
    item.segments?.some((s) => "text" in s && s.text.trim()) ||
    (item.body.trim() && item.body !== "Starting…"),
  );

  const actionColor = toolActionColors[action] ?? "text-muted-foreground";

  useEffect(() => {
    if (isRunning || isError || isDeveloperBashItem(item)) setExpanded(true);
    else setExpanded(false);
  }, [isRunning, isError, item.id, item.status]);

  return (
    <div
      className={cn(
        "message tool group/row relative mx-4 my-1 rounded-lg border text-sm",
        item.status === "running" && "running",
        item.status === "done" && "done",
        item.status === "error" && "error",
        !expanded && "collapsed",
        isError ? "border-red-500/30 bg-red-500/5" : "border-border/40 bg-card/50",
      )}
      data-testid="tool-row"
      data-transcript-id={item.id}
      data-transcript-kind={item.kind}
      data-transcript-status={item.status ?? "done"}
      data-tool-state={item.status ?? "done"}
      data-collapsed={expanded ? "false" : "true"}
    >
      <div className="absolute right-1 top-1 z-[1]">
        <RowActions item={item} context={context} />
      </div>
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        disabled={!hasBody}
        data-row-action="toggle-output"
        className={cn(
          "message-header w-full flex items-center gap-2 px-3 py-2 pr-9 text-left rounded-lg",
          hasBody && "cursor-pointer hover:bg-muted/40",
          !hasBody && "cursor-default",
        )}
      >
        {/* Status dot */}
        <span className={cn(
          "shrink-0 w-1.5 h-1.5 rounded-full",
          isRunning ? "bg-sidebar-primary animate-pulse" : isError ? "bg-red-400" : "bg-muted-foreground/40",
        )} />

        {/* Action label */}
        <strong className={cn("shrink-0 font-mono text-xs font-semibold", actionColor)}>
          {action}
        </strong>

        {/* Target path/command */}
        {target && (
          <span className="font-mono text-xs text-muted-foreground truncate min-w-0 flex-1">
            {` ${target}`}
          </span>
        )}

        {/* Duration */}
        {duration && !isRunning && (
          <span className="shrink-0 text-xs text-muted-foreground/60 ml-auto">{duration}</span>
        )}

        {/* Running spinner */}
        {isRunning && (
          <span className="shrink-0 ml-auto text-xs text-sidebar-primary/70 animate-pulse">running…</span>
        )}

        {/* Expand indicator */}
        {hasBody && (
          <span className={cn("message-expand-toggle shrink-0 text-muted-foreground/40 text-xs ml-1 transition-transform", expanded && "rotate-180")}>
            ▾
          </span>
        )}
      </button>

      {/* Compact summary (collapsed) */}
      {!expanded && !isRunning && summary && (
        <p className="px-3 pb-2 text-xs text-muted-foreground/70 font-mono truncate">{summary}</p>
      )}

      {/* Expanded body */}
      {expanded && hasBody && (
        <div className="px-3 pb-3 border-t border-border/30 pt-2">
          {item.segments && item.segments.length > 0
            ? <Segments segments={item.segments} showThinking={showThinking} context={context} />
            : <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{item.body}</pre>
          }
        </div>
      )}
    </div>
  );
}

// ---- Question summary rows --------------------------------------------------

function QuestionSummaryRow({ item }: { item: TranscriptItem }) {
  const raw = isRecord(item.raw) ? item.raw : {};
  const details = isRecord(raw.details) ? raw.details : null;
  const cancelled = item.status === "error" || details?.cancelled === true;
  const terminalCheckpoint = details?.terminalCheckpoint === true;

  const question = typeof details?.question === "string"
    ? details.question
    : item.body.replace(/^Q:\s*/m, "").split("\n")[0] ?? item.body;

  const answer = cancelled
    ? "Cancelled"
    : terminalCheckpoint
      ? "Reply below or choose an option."
      : String(details?.answer ?? details?.optionLabel ?? "").trim() || "—";

  const kicker = cancelled ? "Question cancelled" : terminalCheckpoint ? "Question asked" : "Question answered";

  const selected = terminalCheckpoint
    ? "Chat checkpoint"
    : typeof details?.selectedIndex === "number"
      ? `Option ${details.selectedIndex + 1}`
      : details?.wasCustom === true
        ? "Custom answer"
        : "Answer";

  return (
    <div className={cn(
      "group/row mx-4 my-1 rounded-lg border px-3 py-2.5 text-sm",
      cancelled
        ? "border-border/30 bg-muted/20 opacity-60"
        : terminalCheckpoint
          ? "border-yellow-500/25 bg-yellow-500/5"
          : "border-yellow-500/20 bg-yellow-500/5",
    )} data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn(
          "text-[10px] font-semibold uppercase tracking-wide",
          cancelled ? "text-muted-foreground" : "text-yellow-500/80",
        )}>
          {kicker}
        </span>
        <span className="text-[10px] text-muted-foreground/60">{selected}</span>
      </div>
      <p className="text-xs text-foreground/80 leading-snug">{question}</p>
      {!terminalCheckpoint && (
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-[10px] font-medium text-muted-foreground">
            {cancelled ? "Result" : "Answer"}
          </span>
          <span className={cn(
            "text-xs font-medium",
            cancelled ? "text-muted-foreground" : "text-foreground",
          )}>
            {answer}
          </span>
        </div>
      )}
    </div>
  );
}

// ---- System / question / error rows ----------------------------------------

function SystemRow({ item, context }: { item: TranscriptItem; context: TranscriptRenderContext }) {
  return (
    <div className={cn(
      "message group/row mx-4 my-1 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border px-3 py-2 text-xs font-mono",
      item.kind === "error" ? "border-red-500/30 bg-red-500/5 text-red-400" : "border-border/30 bg-muted/30 text-muted-foreground",
    )} data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"}>
      <div className="min-w-0">
        <span className="font-semibold">{item.title}</span>
        {item.body && item.body !== item.title && (
          <pre className="mt-1 whitespace-pre-wrap break-words opacity-80">{item.body}</pre>
        )}
      </div>
      <RowActions item={item} context={context} />
    </div>
  );
}

// ---- Main export ------------------------------------------------------------

export function TranscriptRow({
  item,
  showThinking,
  sessionId,
  sessionCwd,
  apiBase,
  token,
  extensionCatalog,
  sessionTreeNodes,
  onFork,
  onAcceptPlan,
}: {
  item: TranscriptItem;
  showThinking: boolean;
} & TranscriptRenderContext) {
  const context = { sessionId, sessionCwd, apiBase, token, extensionCatalog, sessionTreeNodes, onFork, onAcceptPlan };
  if (item.kind === "user") return <UserRow item={item} showThinking={showThinking} context={context} />;
  if (item.kind === "assistant") return <AssistantRow item={item} showThinking={showThinking} context={context} />;
  if (item.kind === "tool" && hasSubagentCard(item)) {
    return (
      <div className="message subagent-card-result group/row relative max-w-[640px]" data-transcript-id={item.id} data-transcript-kind={item.kind} data-transcript-status={item.status ?? "done"} data-subagent-card="true">
        <div className="standalone-card-action-area message-action-area absolute right-5 top-2 z-[1]">
          <RowActions item={item} context={context} />
        </div>
        <div className="message-body">
          <SubagentCard item={item} />
        </div>
      </div>
    );
  }
  if (item.kind === "tool") return <ToolRow item={item} showThinking={showThinking} context={context} />;
  if (item.kind === "question") return <QuestionSummaryRow item={item} />;
  return <SystemRow item={item} context={context} />;
}
