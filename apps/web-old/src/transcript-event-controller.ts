import { agentEventType, bashEventCommand, bashEventToTranscriptItem, messageEventToTranscriptItem, queueUpdateValues, questionSummaryForToolItem, toolExecutionToTranscriptItem, webCommandResultToTranscriptItem } from "./session-events";
import { clearConfirmedRunningQueueItem, runningQueueFromUpdate, type RunningQueueState } from "./running-queue";
import type { TranscriptController } from "./transcript-controller";
import { isRecord } from "./utils";
import type { SessionSnapshot } from "@pi-web-agent/protocol";

type AgentStatus = SessionSnapshot["status"] | "disconnected" | "connecting";

export type TranscriptEventContext = {
  event: unknown;
  transcriptController: TranscriptController;
  selectedSessionId: string | undefined;
  runningQueue: RunningQueueState;
  transcriptElement: HTMLElement | null;
  disableFollowIfDetached: (transcript?: HTMLElement | null) => void;
  setAgentStatus: (status: AgentStatus) => void;
  setRunningQueue: (queue: RunningQueueState) => void;
  refreshTree: () => void;
  requestImmediateRender: () => void;
  markUnread: (id: string) => void;
};

export function applyTranscriptAgentEvent(context: TranscriptEventContext): void {
  const upsert = (item: Parameters<TranscriptController["upsert"]>[0]) => context.transcriptController.upsert(item, { markUnread: context.markUnread });
  const type = agentEventType(context.event);
  if (!type || !isRecord(context.event)) return;
  context.disableFollowIfDetached(context.transcriptElement);

  if (type === "agent_start" || type === "turn_start") {
    context.setAgentStatus("running");
  }
  if (type === "agent_end" || type === "turn_end") {
    context.setAgentStatus("idle");
    context.setRunningQueue(runningQueueFromUpdate(context.runningQueue, [], []));
    context.refreshTree();
  }

  if (type === "web_command_result") {
    upsert(webCommandResultToTranscriptItem(context.event));
    return;
  }

  if (type === "bash_execution_start" || type === "bash_execution_update" || type === "bash_execution_end") {
    const command = bashEventCommand(context.event);
    if (type !== "bash_execution_end") context.setAgentStatus("running");
    else context.setAgentStatus("idle");
    if (type === "bash_execution_start") {
      const pendingIds = context.transcriptController.items
        .filter((item) => item.id.startsWith("bash:pending:") && isRecord(item.raw) && item.raw.command === command)
        .map((item) => item.id);
      if (pendingIds.length > 0) context.transcriptController.removeByIds(pendingIds);
    }
    const item = bashEventToTranscriptItem(context.event);
    if (item) upsert(item);
    if (type === "bash_execution_end") context.refreshTree();
    return;
  }

  if (type === "message_start" || type === "message_update" || type === "message_end") {
    const item = messageEventToTranscriptItem(type, context.event);
    if (!item) return;
    upsert(item);
    if (item.kind === "user") context.setRunningQueue(clearConfirmedRunningQueueItem(context.runningQueue, item.body));
    return;
  }

  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    const id = `tool:${String(context.event.toolCallId ?? Date.now())}`;
    const existing = context.transcriptController.items.find((item) => item.id === id);
    const toolItem = toolExecutionToTranscriptItem(type, context.event, existing);
    if (!toolItem) return;
    context.transcriptController.rememberToolTiming(context.selectedSessionId, toolItem);
    upsert(toolItem);
    if (type === "tool_execution_start") context.requestImmediateRender();
    const questionSummary = type === "tool_execution_end" ? questionSummaryForToolItem(toolItem) : null;
    if (questionSummary) upsert(questionSummary);
    return;
  }

  if (type === "queue_update") {
    const update = queueUpdateValues(context.event);
    context.setRunningQueue(runningQueueFromUpdate(context.runningQueue, update.steering, update.followUp));
  }
}
