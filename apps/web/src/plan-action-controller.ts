import { buildComposerSendPayload, composerQueueItem, type ClientMessageType } from "./composer-actions";
import { addRunningQueueItem, type RunningQueueState } from "./running-queue";
import { activePlanActionItem, renderPlanComposerTakeover } from "./transcript-shell";
import type { TranscriptItem } from "./transcript";

export type PlanAction = "accept" | "chat";

function isPlanAction(value: string): value is PlanAction {
  return value === "accept" || value === "chat";
}

export type PlanActionControllerOptions = {
  transcript: () => TranscriptItem[];
  status: () => string;
  socket: () => WebSocket | null;
  promptDraft: () => string;
  setPromptDraft: (value: string) => void;
  clearPromptImages: () => void;
  updateRunningQueue: (updater: (queue: RunningQueueState) => RunningQueueState) => void;
  savePromptDraft: () => void;
  closeAutocompletes: () => void;
  focusPromptOnNextReadyRender: () => void;
  setNotice: (notice: string) => void;
  render: () => void;
};

export class PlanActionController {
  private dismissedTranscriptId = "";

  constructor(private readonly options: PlanActionControllerOptions) {}

  resetDismissed(): void {
    this.dismissedTranscriptId = "";
  }

  activeItem(): TranscriptItem | null {
    return activePlanActionItem(this.options.transcript(), this.dismissedTranscriptId);
  }

  renderTakeover(item: TranscriptItem): string {
    return renderPlanComposerTakeover(item);
  }

  handle(action: string, transcriptId = this.activeItem()?.id ?? ""): void {
    if (!isPlanAction(action)) return;
    if (transcriptId) this.dismissedTranscriptId = transcriptId;
    if (action === "chat") {
      this.fillPromptDraft("");
      return;
    }
    this.submitText("Proceed with the recommended plan.");
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
