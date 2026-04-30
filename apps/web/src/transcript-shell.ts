import type { UiActionContribution } from "@pi-web-agent/protocol";
import { uiActionContributionForTranscriptItem, type TranscriptItem } from "./transcript";
import { renderTranscriptHtml } from "./transcript-renderer";
import { escapeHtml } from "./utils";

export function activeUiActionItem(items: readonly TranscriptItem[], dismissedId: string): TranscriptItem | null {
  const latestItem = items.at(-1);
  if (!latestItem || !uiActionContributionForTranscriptItem(latestItem)) return null;
  return latestItem.id === dismissedId ? null : latestItem;
}

export function renderUiActionComposerTakeover(item: TranscriptItem): string {
  const contribution = uiActionContributionForTranscriptItem(item);
  if (!contribution) return "";
  return renderComposerTakeover(contribution, item.id);
}

function renderComposerTakeover(contribution: UiActionContribution, transcriptId: string): string {
  return `<section class="ui-action-composer-takeover plan-composer-takeover" aria-label="${escapeHtml(contribution.title)}">
      <div class="ui-action-composer-heading plan-composer-heading">
        <strong>${escapeHtml(contribution.title)}</strong>
        ${contribution.description ? `<span>${escapeHtml(contribution.description)}</span>` : ""}
      </div>
      <div class="ui-action-composer-actions plan-composer-actions" data-ui-contribution-id="${escapeHtml(contribution.id)}" data-ui-placement="${escapeHtml(contribution.placement)}">
        ${contribution.actions.map((action) => `<button type="button" class="${action.variant === "primary" ? "primary-action" : ""}" data-ui-action="${escapeHtml(action.id)}" data-plan-action="${escapeHtml(action.id)}" data-ui-contribution-id="${escapeHtml(contribution.id)}" data-transcript-id="${escapeHtml(transcriptId)}">${escapeHtml(action.label)}</button>`).join("")}
      </div>
    </section>`;
}

export function renderTranscriptShell(options: {
  selectedSession: boolean;
  transcript: TranscriptItem[];
  status: string;
}): string {
  if (options.selectedSession && options.transcript.length === 0) return renderEmptyTranscript();
  return renderTranscriptHtml(options.transcript);
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
