import { emptyRunningQueue, hasRunningQueueItems, removeRunningQueueItem, renderRunningQueue, type RunningQueueName, type RunningQueueState } from "./running-queue";
import { recordPerfEvent } from "./utils";

export type RunningQueueControllerOptions = {
  root: () => ParentNode;
  socket: () => WebSocket | null;
  mobileLayout: () => boolean;
  setPromptDraft: (value: string) => void;
  savePromptDraft: () => void;
  setNotice: (notice: string) => void;
  render: () => void;
};

export class RunningQueueController {
  private runningQueue: RunningQueueState = emptyRunningQueue();
  private expanded = false;
  private sectionExpanded = false;

  constructor(private readonly options: RunningQueueControllerOptions) {}

  get queue(): RunningQueueState {
    return this.runningQueue;
  }

  set queue(queue: RunningQueueState) {
    this.runningQueue = queue;
  }

  reset(): void {
    this.runningQueue = emptyRunningQueue();
  }

  update(updater: (queue: RunningQueueState) => RunningQueueState): void {
    this.runningQueue = updater(this.runningQueue);
  }

  hasItems(): boolean {
    return hasRunningQueueItems(this.runningQueue);
  }

  renderHtml(): string {
    const rendered = renderRunningQueue(this.runningQueue, this.expanded, this.options.mobileLayout() && !this.sectionExpanded);
    this.expanded = rendered.expanded;
    return rendered.html;
  }

  bindControls(): void {
    const root = this.options.root();
    root.querySelectorAll<HTMLButtonElement>("#toggleRunningQueueSection").forEach((button) => {
      button.addEventListener("click", () => {
        this.sectionExpanded = !this.sectionExpanded;
        this.options.render();
      });
    });
    root.querySelector<HTMLButtonElement>("#toggleRunningQueue")?.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.options.render();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-edit-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.editQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.editQueuedMessage(queue, index, text);
      });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-cancel-queue]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const queue = button.dataset.cancelQueue === "followUp" ? "followUp" : "steering";
        const index = Number(button.dataset.queueIndex ?? "-1");
        const text = button.dataset.queueText ?? "";
        if (index >= 0 && text) this.cancelQueuedMessage(queue, index, text);
      });
    });
  }

  patch(shell = this.options.root().querySelector<HTMLElement>(".transcript-shell")): void {
    if (!shell) return;
    shell.classList.toggle("has-running-queue", this.hasItems());
    const existing = shell.querySelector<HTMLElement>(".running-queue");
    const renderedHtml = this.renderHtml();
    if (!renderedHtml) {
      existing?.remove();
      this.syncHeight(shell);
      return;
    }
    if (existing) {
      existing.outerHTML = renderedHtml;
      this.bindControls();
      this.syncHeight(shell);
      return;
    }
    const jump = shell.querySelector<HTMLElement>(".jump-to-latest");
    if (jump) jump.insertAdjacentHTML("beforebegin", renderedHtml);
    else shell.insertAdjacentHTML("beforeend", renderedHtml);
    this.bindControls();
    this.syncHeight(shell);
  }

  syncHeight(shell = this.options.root().querySelector<HTMLElement>(".transcript-shell")): void {
    if (!shell) return;
    const queue = shell.querySelector<HTMLElement>(".running-queue");
    if (!queue) {
      if (shell.style.getPropertyValue("--running-queue-height")) recordPerfEvent("queueHeight", "removed", { height: 0 });
      shell.style.removeProperty("--running-queue-height");
      return;
    }
    const height = Math.ceil(queue.getBoundingClientRect().height);
    const nextValue = `${height}px`;
    if (shell.style.getPropertyValue("--running-queue-height") !== nextValue) recordPerfEvent("queueHeight", "changed", { height });
    shell.style.setProperty("--running-queue-height", nextValue);
  }

  private cancelQueuedMessage(queue: RunningQueueName, index: number, text: string): void {
    if (this.removeQueuedMessage(queue, index, text)) this.options.render();
  }

  private editQueuedMessage(queue: RunningQueueName, index: number, text: string): void {
    if (!this.removeQueuedMessage(queue, index, text)) return;
    this.options.setPromptDraft(text);
    this.options.savePromptDraft();
    this.options.setNotice("");
    this.options.render();
    window.requestAnimationFrame(() => {
      const input = this.options.root().querySelector<HTMLTextAreaElement>("#prompt");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  private removeQueuedMessage(queue: RunningQueueName, index: number, text: string): boolean {
    const ws = this.options.socket();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.options.setNotice("Not connected. Queued messages can be changed after reconnect.");
      this.options.render();
      return false;
    }
    const current = this.runningQueue[queue];
    if (current[index]?.text !== text) {
      this.options.setNotice("Queued message changed before it could be updated.");
      this.options.render();
      return false;
    }
    this.runningQueue = removeRunningQueueItem(this.runningQueue, queue, index);
    ws.send(JSON.stringify({ type: "cancel_queued_message", queue, index, text }));
    return true;
  }
}
