import { buildComposerSendPayload, composerQueueItem, type ClientMessageType } from "./composer-actions";
import { addRunningQueueItem, type RunningQueueState } from "./running-queue";
import { activeUiActionItem, renderUiActionComposerTakeover } from "./transcript-shell";
import { PLAN_UI_ACTION_CONTRIBUTION, type TranscriptItem } from "./transcript";

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
  render: () => void;
};

type UiActionHandler = (actionId: string) => void;

const planContributionId = PLAN_UI_ACTION_CONTRIBUTION.id;

export class UiActionController {
  private dismissedTranscriptId = "";
  private readonly actionHandlers: Record<string, UiActionHandler> = {
    [planContributionId]: (actionId) => this.handlePlanAction(actionId),
  };

  constructor(private readonly options: UiActionControllerOptions) {}

  resetDismissed(): void {
    this.dismissedTranscriptId = "";
  }

  activeItem(): TranscriptItem | null {
    return activeUiActionItem(this.options.transcript(), this.dismissedTranscriptId);
  }

  renderTakeover(item: TranscriptItem): string {
    return renderUiActionComposerTakeover(item);
  }

  handle(contributionId: string, actionId: string, transcriptId = this.activeItem()?.id ?? ""): void {
    if (!this.canHandle(contributionId, actionId)) return;
    const handler = this.actionHandlers[contributionId];
    if (!handler) return;
    if (transcriptId) this.dismissedTranscriptId = transcriptId;
    handler(actionId);
  }

  private canHandle(contributionId: string, actionId: string): boolean {
    return contributionId === planContributionId && (actionId === "accept" || actionId === "chat");
  }

  private handlePlanAction(actionId: string): void {
    if (actionId === "chat") {
      this.fillPromptDraft("");
      return;
    }
    if (actionId === "accept") this.submitText("Proceed with the recommended plan.");
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
