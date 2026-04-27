import { escapeHtml } from "./utils";

export type RunningQueueName = "steering" | "followUp";

export type RunningQueueItem = {
  text: string;
  imageCount: number | undefined;
};

export type RunningQueueState = {
  steering: RunningQueueItem[];
  followUp: RunningQueueItem[];
};

export const emptyRunningQueue = (): RunningQueueState => ({ steering: [], followUp: [] });

export function runningQueueCount(queue: RunningQueueState): number {
  return queue.steering.length + queue.followUp.length;
}

export function hasRunningQueueItems(queue: RunningQueueState): boolean {
  return runningQueueCount(queue) > 0;
}

export function addRunningQueueItem(queue: RunningQueueState, name: RunningQueueName, item: RunningQueueItem): RunningQueueState {
  return { ...queue, [name]: [...queue[name], item] };
}

export function removeRunningQueueItem(queue: RunningQueueState, name: RunningQueueName, index: number): RunningQueueState {
  return { ...queue, [name]: queue[name].filter((_, candidateIndex) => candidateIndex !== index) };
}

export function runningQueueFromUpdate(previous: RunningQueueState, steering: unknown[], followUp: unknown[]): RunningQueueState {
  const preserveImageCounts = (name: RunningQueueName, values: unknown[]): RunningQueueItem[] => {
    const previousItems = [...previous[name]];
    return values.map((value) => {
      const text = String(value);
      const matchIndex = previousItems.findIndex((item) => item.text === text);
      const match = matchIndex >= 0 ? previousItems.splice(matchIndex, 1)[0] : undefined;
      return { text, imageCount: match?.imageCount };
    });
  };
  return {
    steering: preserveImageCounts("steering", steering),
    followUp: preserveImageCounts("followUp", followUp),
  };
}

type RunningQueueRenderItem = {
  kind: "Steer" | "Follow-up";
  queue: RunningQueueName;
  item: RunningQueueItem;
  index: number;
};

export function renderRunningQueue(queue: RunningQueueState, expanded: boolean): { html: string; expanded: boolean } {
  const allItems: RunningQueueRenderItem[] = [
    ...queue.steering.map((item, index) => ({ kind: "Steer" as const, queue: "steering" as const, item, index })),
    ...queue.followUp.map((item, index) => ({ kind: "Follow-up" as const, queue: "followUp" as const, item, index })),
  ];
  if (allItems.length === 0) return { html: "", expanded: false };

  const visibleItems = expanded ? allItems : allItems.slice(0, 3);
  const hiddenCount = Math.max(0, allItems.length - visibleItems.length);
  const total = allItems.length;
  return {
    expanded,
    html: `
      <div class="running-queue ${expanded ? "expanded" : "compact"}" aria-label="Queued running controls">
        <div class="running-queue-heading">
          <strong>Queued for this run</strong>
          <span>${total} pending</span>
          ${hiddenCount > 0 ? `<button id="toggleRunningQueue" class="queue-more" type="button">+${hiddenCount} more</button>` : expanded && total > 3 ? `<button id="toggleRunningQueue" class="queue-more" type="button">Show less</button>` : ""}
        </div>
        <div class="running-queue-items">
          ${visibleItems.map(renderRunningQueuePill).join("")}
        </div>
      </div>`,
  };
}

function renderRunningQueuePill({ kind, queue, item, index }: RunningQueueRenderItem): string {
  return `
      <span class="queue-pill ${kind.toLowerCase()}" title="${escapeHtml(item.text)}">
        <strong>${escapeHtml(kind)} ${index + 1}</strong>
        <span>${escapeHtml(item.text)}</span>
        ${item.imageCount ? `<em class="queue-image-badge" title="${item.imageCount} attached image${item.imageCount === 1 ? "" : "s"}">🖼 ${item.imageCount}</em>` : ""}
        <button type="button" class="queue-edit" data-edit-queue="${queue}" data-queue-index="${index}" data-queue-text="${escapeHtml(item.text)}" aria-label="Edit ${escapeHtml(kind)} ${index + 1}">✎</button>
        <button type="button" class="queue-cancel" data-cancel-queue="${queue}" data-queue-index="${index}" data-queue-text="${escapeHtml(item.text)}" aria-label="Cancel ${escapeHtml(kind)} ${index + 1}">×</button>
      </span>`;
}
