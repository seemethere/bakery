import { hasPlanActionsMarker, type TranscriptItem } from "./transcript";
import { latestGroupableToolGroupId, renderTranscriptHtml } from "./transcript-renderer";
import { escapeHtml } from "./utils";

export function activePlanActionItem(items: readonly TranscriptItem[], dismissedId: string): TranscriptItem | null {
  const latestItem = items.at(-1);
  if (!latestItem || latestItem.kind !== "assistant" || !hasPlanActionsMarker(latestItem)) return null;
  return latestItem.id === dismissedId ? null : latestItem;
}

export function renderPlanComposerTakeover(item: TranscriptItem): string {
  return `<section class="plan-composer-takeover" aria-label="Plan decision needed">
      <div class="plan-composer-heading">
        <strong>Plan ready</strong>
        <span>Accept to continue with this implementation plan, or return to the normal composer.</span>
      </div>
      <div class="plan-composer-actions">
        <button type="button" class="primary-action" data-plan-action="accept" data-transcript-id="${escapeHtml(item.id)}">Accept plan</button>
        <button type="button" data-plan-action="chat" data-transcript-id="${escapeHtml(item.id)}">Back to chat</button>
      </div>
    </section>`;
}

export function renderTranscriptShell(options: {
  selectedSession: boolean;
  transcript: TranscriptItem[];
  status: string;
  expandedToolActivityIds: ReadonlySet<string>;
}): string {
  if (options.selectedSession && options.transcript.length === 0) return renderEmptyTranscript();
  return renderTranscriptHtml(options.transcript, {
    activeToolGroupId: options.status === "running" ? latestGroupableToolGroupId(options.transcript) : undefined,
    nowMs: Date.now(),
    expandedToolActivityIds: options.expandedToolActivityIds,
  });
}

function renderEmptyTranscript(): string {
  const quickStarts = [
    { action: "plan", label: "/plan", title: "Plan next work", description: "Interview, inspect context, then hand off a small slice." },
    { action: "screenshot", label: "Screenshot", title: "Attach visual context", description: "Paste, drop, or pick an image for the next prompt." },
    { action: "file", label: "@file", title: "Mention workspace files", description: "Start file autocomplete for targeted context." },
    { action: "bash", label: "!bash", title: "Run local bash", description: "Draft a command; use !! to exclude output from context." },
  ];
  return `<div class="empty-transcript" role="status" aria-label="Empty session">
        <p class="empty-transcript-kicker">New pi browser session</p>
        <strong>Start with a workflow.</strong>
        <span>Use Bakery for visual transcript review, screenshots, and guided planning from any browser.</span>
        <div class="empty-quick-starts" aria-label="Quick starts">
          ${quickStarts.map((item) => `<button type="button" class="empty-quick-start" data-empty-quick-start="${escapeHtml(item.action)}">
            <span class="empty-quick-start-label">${escapeHtml(item.label)}</span>
            <span class="empty-quick-start-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small></span>
          </button>`).join("")}
        </div>
      </div>`;
}
