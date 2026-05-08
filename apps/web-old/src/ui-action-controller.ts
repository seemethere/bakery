import { buildComposerSendPayload, composerQueueItem, type ClientMessageType } from "./composer-actions";
import { addRunningQueueItem, type RunningQueueState } from "./running-queue";
import { renderUiActionComposerTakeover } from "./transcript-shell";
import { PLAN_UI_ACTION_CONTRIBUTION, uiActionContributionForTranscriptItem, type PlanActionOutcome, type TranscriptItem } from "./transcript";

export type UiActionControllerOptions = {
  transcript: () => TranscriptItem[];
  status: () => string;
  socket: () => WebSocket | null;
  setPromptDraft: (value: string) => void;
  clearPromptImages: () => void;
  updateRunningQueue: (updater: (queue: RunningQueueState) => RunningQueueState) => void;
  savePromptDraft: () => void;
  closeAutocompletes: () => void;
  focusPromptOnNextReadyRender: () => void;
  setNotice: (notice: string) => void;
  markTranscriptDirty: (transcriptId: string) => void;
  render: () => void;
};

type UiActionHandler = (actionId: string) => void;

const planContributionId = PLAN_UI_ACTION_CONTRIBUTION.id;

export class UiActionController {
  private dismissedTranscriptId = "";
  private readonly outcomes = new Map<string, PlanActionOutcome>();
  private activeTranscriptId = "";
  private readonly actionHandlers: Record<string, UiActionHandler> = {
    [planContributionId]: (actionId) => this.handlePlanAction(actionId),
  };

  constructor(private readonly options: UiActionControllerOptions) {}

  resetDismissed(): void {
    this.dismissedTranscriptId = "";
    this.outcomes.clear();
    this.activeTranscriptId = "";
  }

  activeItem(): TranscriptItem | null {
    return null;
  }

  outcomeFor(transcriptId: string): PlanActionOutcome | undefined {
    return this.outcomes.get(transcriptId);
  }

  markLatestPendingDiscussing(): string {
    const item = this.latestPendingPlanItem();
    if (!item) return "";
    this.setOutcome(item.id, "discussing");
    return item.id;
  }

  renderTakeover(item: TranscriptItem): string {
    return renderUiActionComposerTakeover(item);
  }

  handle(contributionId: string, actionId: string, transcriptId = this.activeItem()?.id ?? ""): void {
    if (!this.canHandle(contributionId, actionId) || !transcriptId || this.outcomes.has(transcriptId)) return;
    const handler = this.actionHandlers[contributionId];
    if (!handler) return;
    this.activeTranscriptId = transcriptId;
    this.dismissedTranscriptId = transcriptId;
    handler(actionId);
    this.activeTranscriptId = "";
  }

  private canHandle(contributionId: string, actionId: string): boolean {
    return contributionId === planContributionId && (actionId === "accept" || actionId === "reject");
  }

  private handlePlanAction(actionId: string): void {
    if (!this.activeTranscriptId) return;
    if (actionId === "reject") {
      this.setOutcome(this.activeTranscriptId, "rejected");
      this.options.render();
      return;
    }
    if (actionId === "accept") {
      this.setOutcome(this.activeTranscriptId, "accepted");
      this.submitText("Proceed with the recommended plan.");
    }
  }

  private setOutcome(transcriptId: string, outcome: PlanActionOutcome): void {
    this.outcomes.set(transcriptId, outcome);
    this.options.markTranscriptDirty(transcriptId);
  }

  private latestPendingPlanItem(): TranscriptItem | null {
    const items = this.options.transcript();
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item || item.id === this.dismissedTranscriptId || this.outcomes.has(item.id)) continue;
      if (uiActionContributionForTranscriptItem(item)) return item;
    }
    return null;
  }

  private fillPromptDraft(text: string): void {
    this.options.setPromptDraft(text);
    this.options.savePromptDraft();
    this.options.closeAutocompletes();
    this.options.focusPromptOnNextReadyRender();
    this.options.setNotice("");
    this.options.render();
  }

  private submitText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ws = this.options.socket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.fillPromptDraft(text);
      this.options.setNotice("Not connected. Your plan response is saved in the composer.");
      return;
    }
    const type: ClientMessageType = this.options.status() === "running" ? "follow_up" : "prompt";
    ws.send(JSON.stringify(buildComposerSendPayload(type, trimmed, [])));
    if (type === "follow_up") this.options.updateRunningQueue((queue) => addRunningQueueItem(queue, "followUp", composerQueueItem(trimmed, 0)));
    this.options.setPromptDraft("");
    this.options.clearPromptImages();
    this.options.savePromptDraft();
    this.options.closeAutocompletes();
    this.options.setNotice("");
    this.options.render();
  }
}
