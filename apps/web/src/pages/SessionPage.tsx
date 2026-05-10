import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import type { AnswerQuestionPayload, ControllerInfo, ExtensionCatalog, PendingQuestion, SessionRuntimeSettings, SessionSnapshot, SessionTreeResponse, WebSession } from "@pi-web-agent/protocol";
import { Composer } from "@/components/Composer";
import { QuestionPanel } from "@/components/QuestionPanel";
import { RunningQueueStrip } from "@/components/RunningQueueStrip";
import { TranscriptView } from "@/components/transcript/TranscriptView";
import { useTranscript } from "@/hooks/useTranscript";
import type { RunningQueueName, RunningQueueState } from "@/hooks/useServerConnection";
import type { PromptImage } from "@/lib/prompt-images";
import type { SendMode } from "@/components/Composer";
import { sessionRoutePath } from "@/lib/router";
import { flattenSessionTree } from "@/lib/session-tree";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  snapshot: SessionSnapshot | null;
  pendingQuestion: PendingQuestion | null;
  controller: ControllerInfo | null;
  runtimeSettings: SessionRuntimeSettings | null;
  defaultThinkingLevel?: string | undefined;
  showThinking: boolean;
  subscribeAgentEvents: (cb: (event: unknown) => void) => () => void;
  fetchJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  apiBase: string;
  token: string;
  extensionCatalog: ExtensionCatalog | null;
  runningQueue: RunningQueueState;
  status: "idle" | "running" | "aborting" | "connecting" | "disconnected" | "error";
  onForkSession: (sourceSessionId: string, entryId: string) => Promise<WebSession | null>;
  onNewSessionCommand: (cwd?: string | null) => Promise<boolean>;
  onCancelQueuedMessage: (queue: RunningQueueName, index: number, text?: string) => void;
  onSend: (sessionId: string, text: string, images: PromptImage[], followUp: boolean, mode?: SendMode) => void;
  onAbort: (sessionId: string) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetThinking: (sessionId: string, level: string) => void;
  onShowThinkingChange: (show: boolean) => void;
  onAnswerQuestion: (payload: AnswerQuestionPayload) => void;
  onTakeControl: () => void;
  promptFocusNonce?: number;
  isBootstrapping?: boolean;
  sessionNotFound?: boolean;
};

export function SessionPage({
  snapshot,
  pendingQuestion,
  controller,
  runtimeSettings,
  defaultThinkingLevel,
  showThinking,
  subscribeAgentEvents,
  fetchJson,
  apiBase,
  token,
  extensionCatalog,
  runningQueue,
  status,
  onForkSession,
  onNewSessionCommand,
  onCancelQueuedMessage,
  onSend,
  onAbort,
  onSetModel,
  onSetThinking,
  onShowThinkingChange,
  onAnswerQuestion,
  onTakeControl,
  promptFocusNonce,
  isBootstrapping = false,
  sessionNotFound = false,
}: Props) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const items = useTranscript(snapshot, subscribeAgentEvents);
  const [draftPrefill, setDraftPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const [sessionTree, setSessionTree] = useState<SessionTreeResponse | null>(null);
  const treeNodes = useMemo(() => flattenSessionTree(sessionTree?.tree ?? []), [sessionTree]);

  useEffect(() => {
    if (!sessionId || !snapshot) {
      setSessionTree(null);
      return;
    }
    let cancelled = false;
    void fetchJson<SessionTreeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/tree`)
      .then((tree) => { if (!cancelled) setSessionTree(tree); })
      .catch(() => { if (!cancelled) setSessionTree(null); });
    return () => { cancelled = true; };
  }, [fetchJson, sessionId, snapshot?.messages.length]);

  if (!sessionId) return null;

  if (isBootstrapping) return <SessionBootstrapSkeleton />;

  if (sessionNotFound) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Session not found.
      </div>
    );
  }

  const isController = controller?.isController ?? true;
  const isEmptySession = items.length === 0 && !pendingQuestion && status !== "running";
  const canAnswer = isController && status !== "disconnected" && status !== "connecting" && status !== "error";
  const otherConnectedTabs = Math.max(0, (controller?.connectedClients ?? 1) - 1);

  return (
    <>
      <TranscriptView
        items={items}
        connectionStatus={status}
        showThinking={showThinking}
        sessionId={sessionId}
        sessionCwd={snapshot?.session.cwd ?? null}
        apiBase={apiBase}
        token={token}
        extensionCatalog={extensionCatalog}
        sessionTreeNodes={treeNodes}
        onFork={async (entryId) => {
          const session = await onForkSession(sessionId, entryId);
          if (session) navigate(sessionRoutePath(session.id));
        }}
        onAcceptPlan={() => setDraftPrefill((current) => ({
          text: "Proceed with the recommended plan.",
          nonce: (current?.nonce ?? 0) + 1,
        }))}
      />
      <RunningQueueStrip
        queue={runningQueue}
        onCancel={onCancelQueuedMessage}
        onEdit={(text) => setDraftPrefill((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }))}
      />
      {!isController && (
        <div className="relative z-[3] grid justify-center px-4 pt-3" style={{ gridTemplateColumns: "minmax(0, 860px)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-yellow-500/25 bg-yellow-500/8 px-3 py-2 text-sm text-yellow-600 dark:text-yellow-300">
            <span>
              Viewer mode. Another tab controls this session.
              {otherConnectedTabs > 0 ? ` ${otherConnectedTabs} other ${otherConnectedTabs === 1 ? "tab is" : "tabs are"} connected.` : ""}
            </span>
            <button
              id="takeControl"
              type="button"
              onClick={onTakeControl}
              className="rounded-lg border border-yellow-500/30 bg-yellow-500/15 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-yellow-500/25"
            >
              Take control
            </button>
          </div>
        </div>
      )}
      {pendingQuestion && (
        <div className="question-panel-strip relative z-[3] grid justify-center px-4 pb-2" style={{ gridTemplateColumns: "minmax(0, 860px)" }}>
          <QuestionPanel
            question={pendingQuestion}
            canAnswer={canAnswer}
            onAnswer={onAnswerQuestion}
          />
        </div>
      )}
      <Composer
        status={status}
        isController={isController}
        runtimeSettings={runtimeSettings}
        defaultThinkingLevel={defaultThinkingLevel}
        showThinking={showThinking}
        onSend={(text, images, followUp, mode) => onSend(sessionId, text, images, followUp, mode)}
        onNewSessionCommand={() => onNewSessionCommand(snapshot?.session.cwd ?? undefined)}
        onAbort={() => onAbort(sessionId)}
        onSetModel={(model) => onSetModel(sessionId, model)}
        onSetThinking={(level) => onSetThinking(sessionId, level)}
        onShowThinkingChange={onShowThinkingChange}
        onTakeControl={onTakeControl}
        isEmptySession={isEmptySession}
        draftKey={`piWebPromptDraft:${sessionId}`}
        draftPrefill={draftPrefill}
        focusNonce={promptFocusNonce}
        sessionId={sessionId}
        fetchJson={fetchJson}
      />
    </>
  );
}

function SessionBootstrapSkeleton() {
  return (
    <>
      <div className="flex-1 overflow-hidden px-4 py-6">
        <div className="mx-auto grid w-full max-w-[860px] gap-5">
          <div className="grid justify-items-end gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-16 w-[min(560px,82%)] rounded-2xl" />
          </div>
          <div className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-[min(640px,88%)] rounded-2xl" />
            <Skeleton className="h-16 w-[min(520px,76%)] rounded-2xl" />
          </div>
        </div>
      </div>
      <footer className="relative z-[2] border-t border-border/40 bg-background/95 px-4 py-3">
        <div className="mx-auto grid w-full max-w-[860px] gap-3 rounded-2xl border border-border/50 bg-card p-3 shadow-sm">
          <Skeleton className="h-12 w-full rounded-xl" />
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <Skeleton className="size-8 rounded-lg" />
              <Skeleton className="h-8 w-24 rounded-lg" />
            </div>
            <Skeleton className="size-8 rounded-full" />
          </div>
        </div>
      </footer>
    </>
  );
}
