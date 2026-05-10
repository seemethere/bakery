import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, FormEvent, KeyboardEvent } from "react";
import type { SessionAttachment, SessionAttachmentUploadResponse, SessionRuntimeSettings } from "@pi-web-agent/protocol";
import { ChevronDown, CircleHelp, ClipboardList, Command, MessageSquareText, Paperclip, Plus, SendHorizontal, Settings2, ShieldOff, Square, Terminal, X } from "lucide-react";
import { AutocompletePopup } from "@/components/AutocompletePopup";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StepSlider } from "@/components/ui/step-slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import { contextUsageLabel, modelOptionLabel, modelThinkingLabel } from "@/lib/model-settings";
import { imageDataTransferResult, type PromptImage } from "@/lib/prompt-images";
import { cn } from "@/lib/utils";

export type ComposerStatus = "idle" | "running" | "aborting" | "connecting" | "disconnected" | "error";
type ComposerMode = "prompt" | "ask" | "plan" | "bash" | "bash-no-context";
export type SendMode = ComposerMode;

type Props = {
  status: ComposerStatus;
  isController: boolean;
  runtimeSettings: SessionRuntimeSettings | null;
  defaultThinkingLevel?: string | undefined;
  showThinking: boolean;
  onSend: (text: string, images: PromptImage[], followUp: boolean, mode: SendMode) => void;
  onNewSessionCommand?: () => Promise<boolean>;
  onAbort: () => void;
  onSetModel: (model: string) => void;
  onSetThinking: (level: string) => void;
  onShowThinkingChange: (show: boolean) => void;
  onTakeControl: () => void;
  isEmptySession?: boolean;
  draftKey?: string;
  draftPrefill?: { text: string; nonce: number } | null;
  focusNonce?: number;
  sessionId?: string | null;
  fetchJson?: <T>(path: string, init?: RequestInit) => Promise<T>;
};

function inferredComposerMode(draft: string, selectedMode: ComposerMode): ComposerMode {
  if (draft.trimStart().startsWith("!!")) return "bash-no-context";
  if (draft.trimStart().startsWith("!")) return "bash";
  return selectedMode;
}

function composerModeLabel(mode: ComposerMode, status: ComposerStatus): string {
  if (mode === "ask") return "Ask";
  if (mode === "plan") return "Plan";
  if (mode === "bash-no-context") return "Bash - no context";
  if (mode === "bash") return "Bash";
  return status === "running" ? "Steer" : "Prompt";
}

function modeIsBash(mode: ComposerMode) {
  return mode === "bash" || mode === "bash-no-context";
}

function sendButtonModeClassName(mode: ComposerMode): string {
  if (mode === "ask") return "bg-emerald-500 text-white hover:bg-emerald-400 focus-visible:border-emerald-300 focus-visible:ring-emerald-400/30";
  if (mode === "plan") return "bg-yellow-500 text-black hover:bg-yellow-400 focus-visible:border-yellow-300 focus-visible:ring-yellow-400/30";
  if (mode === "bash" || mode === "bash-no-context") return "bg-purple-500 text-white hover:bg-purple-400 focus-visible:border-purple-300 focus-visible:ring-purple-400/30";
  return "";
}

function payloadForMode(draft: string, mode: ComposerMode): string {
  const trimmedStart = draft.trimStart();
  if (trimmedStart.startsWith("!")) return draft;
  const command = draft.trim();
  if (mode === "plan") return command ? `/plan ${command}` : "/plan";
  if (!command || mode === "prompt" || mode === "ask") return draft;
  return mode === "bash-no-context" ? `!! ${command}` : `! ${command}`;
}

function sendTextForMode(draft: string, imageCount: number, attachmentCount: number, mode: ComposerMode): string {
  if (draft.trim().length === 0 && (imageCount > 0 || attachmentCount > 0)) return attachmentCount > 0 ? "Please inspect the attached file." : "Please inspect the attached image.";
  return payloadForMode(draft, mode);
}

function appendAttachmentContext(text: string, attachments: SessionAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`);
  const context = `Attached files:\n${lines.join("\n")}`;
  return text.trim().length > 0 ? `${text.trimEnd()}\n\n${context}` : context;
}

function sendModeForComposerMode(mode: ComposerMode): SendMode {
  return mode;
}

function nextComposerMode(mode: ComposerMode): ComposerMode {
  if (mode === "prompt") return "ask";
  if (mode === "ask") return "plan";
  if (mode === "plan") return "bash";
  if (mode === "bash") return "bash-no-context";
  return "prompt";
}

function useDismissablePopover(open: boolean, onOpenChange: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onOpenChange(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  return ref;
}

export function Composer({
  status,
  isController,
  runtimeSettings,
  defaultThinkingLevel,
  showThinking,
  onSend,
  onNewSessionCommand,
  onAbort,
  onSetModel,
  onSetThinking,
  onShowThinkingChange,
  onTakeControl,
  isEmptySession = false,
  draftKey,
  draftPrefill,
  focusNonce,
  sessionId,
  fetchJson,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imagePickerPendingRef = useRef(false);
  const imagePickerReturnTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [draft, setDraft] = useState(() => (draftKey ? (localStorage.getItem(draftKey) ?? "") : ""));
  const [uploadedAttachments, setUploadedAttachments] = useState<SessionAttachment[]>([]);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<ComposerMode>("prompt");

  const noopFetch = useCallback(async <T,>(_: string): Promise<T> => {
    throw new Error("no fetch");
  }, []);
  const ac = useAutocomplete(sessionId ?? null, fetchJson ?? noopFetch);

  const isRunning = status === "running";
  const composerMode = inferredComposerMode(draft, selectedMode);
  const isBash = modeIsBash(composerMode);
  const isAsk = composerMode === "ask";
  const isPlan = composerMode === "plan";
  const canSend = isController && (draft.trim().length > 0 || uploadedAttachments.length > 0) && status !== "aborting" && status !== "connecting";
  const isDisconnected = status === "disconnected" || status === "error";
  const modeLabel = composerModeLabel(composerMode, status);
  const showEmptyLanding = isEmptySession && draft.trim().length === 0 && uploadedAttachments.length === 0;
  const emptyComposerGrown = isEmptySession && draft.includes("\n");

  useEffect(() => {
    if (draftKey) localStorage.setItem(draftKey, draft);
  }, [draft, draftKey]);

  useEffect(() => {
    if (!draftPrefill) return;
    setDraft(draftPrefill.text);
    if (draftKey) localStorage.setItem(draftKey, draftPrefill.text);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(draftPrefill.text.length, draftPrefill.text.length);
    });
  }, [draftKey, draftPrefill]);

  useEffect(() => {
    if (focusNonce === undefined) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [focusNonce]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const computedMaxHeight = Number.parseFloat(window.getComputedStyle(el).maxHeight);
    const maxHeight = Number.isFinite(computedMaxHeight) && computedMaxHeight > 0 ? computedMaxHeight : 132;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  useEffect(() => {
    return () => clearTimeout(imagePickerReturnTimerRef.current);
  }, []);

  useEffect(() => {
    function handleWindowFocus() {
      schedulePickerNoChangeNotice(800);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") schedulePickerNoChangeNotice(800);
    }

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("pageshow", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("pageshow", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "/") {
        event.preventDefault();
        textareaRef.current?.focus();
        return;
      }
      if (event.key !== ".") return;
      event.preventDefault();
      setSelectedMode((mode) => nextComposerMode(mode));
      setModeOpen(false);
    }

    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  async function handleSend(followUp = false) {
    if (!canSend) return;
    const text = appendAttachmentContext(sendTextForMode(draft, 0, uploadedAttachments.length, composerMode), uploadedAttachments);
    const trimmed = text.trim();
    if (isRunning && trimmed.startsWith("!")) {
      setNotice("Bash commands are available when the session is idle.");
      return;
    }
    if (/^\/new(?:\s|$)/i.test(trimmed)) {
      if (uploadedAttachments.length > 0) {
        setNotice("Remove attachments before using /new.");
        return;
      }
      if (trimmed !== "/new") {
        setNotice("Usage: /new");
        return;
      }
      const created = await onNewSessionCommand?.();
      if (!created) {
        setNotice("Could not create a new session.");
        return;
      }
    } else {
      onSend(text, [], followUp, sendModeForComposerMode(composerMode));
    }
    setNotice("");
    setDraft("");
    setUploadedAttachments([]);
    if (draftKey) localStorage.removeItem(draftKey);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setDraft(value);
    ac.updateForInput(value, event.target.selectionStart ?? value.length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (ac.state) {
      if (event.key === "Escape") {
        event.preventDefault();
        ac.close();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        ac.navigate(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        ac.navigate(1);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && ac.state.items.length > 0)) {
        event.preventDefault();
        const result = ac.insertSelected(draft);
        if (!result) return;

        setDraft(result.draft);
        if (draftKey) localStorage.setItem(draftKey, result.draft);
        const item = ac.state?.items[ac.state.selectedIndex];
        if (item && ac.shouldRefetchAfterInsert(item)) {
          setTimeout(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.setSelectionRange(result.cursor, result.cursor);
            ac.updateForInput(result.draft, result.cursor);
          }, 0);
        } else {
          ac.close();
          setTimeout(() => textareaRef.current?.setSelectionRange(result.cursor, result.cursor), 0);
        }
        return;
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend(event.altKey);
    }
  }

  async function uploadSessionAttachments(files: FileList | File[]) {
    const stableFiles = Array.from(files);
    if (stableFiles.length === 0) {
      setNotice("No files were selected.");
      return;
    }
    if (!sessionId || !fetchJson) {
      setNotice("Open a session before uploading attachments.");
      return;
    }
    const form = new FormData();
    for (const file of stableFiles) form.append("files", file, file.name || "attachment");
    setNotice(`Uploading ${stableFiles.length} attachment${stableFiles.length === 1 ? "" : "s"}…`);
    try {
      const response = await fetchJson<SessionAttachmentUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
        method: "POST",
        body: form,
      });
      if (response.attachments.length === 0) {
        setNotice("No attachments were uploaded.");
        return;
      }
      setUploadedAttachments((prev) => [...prev, ...response.attachments]);
      setNotice("");
    } catch (error) {
      setNotice(`Attachment upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function schedulePickerNoChangeNotice(delayMs: number) {
    if (!imagePickerPendingRef.current) return;
    clearTimeout(imagePickerReturnTimerRef.current);
    imagePickerReturnTimerRef.current = setTimeout(() => {
      if (!imagePickerPendingRef.current) return;
      imagePickerPendingRef.current = false;
      setNotice("Image picker opened, but Bakery did not receive any files. Try a PNG/JPEG file, or drag and drop the image into the composer.");
    }, delayMs);
  }

  function handleImagePaste(dataTransfer: DataTransfer | null | undefined): boolean {
    const result = imageDataTransferResult(dataTransfer);
    if (result.files.length > 0) {
      void uploadSessionAttachments(result.files);
      return true;
    }
    if (result.imageLike) {
      setNotice("Clipboard image type is not supported. Use PNG, JPEG, GIF, or WebP.");
      return true;
    }
    return false;
  }

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (handleImagePaste(event.clipboardData)) event.preventDefault();
  }, [draftKey, fetchJson, sessionId]);

  useEffect(() => {
    if (!isController) return;

    function handleDocumentPaste(event: globalThis.ClipboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      const element = target instanceof Element ? target : null;
      const isPrompt = element?.id === "prompt";
      const isOtherEditable = Boolean(element?.closest('textarea,input,[contenteditable="true"]')) && !isPrompt;
      if (isOtherEditable) return;

      if (!handleImagePaste(event.clipboardData)) return;
      event.preventDefault();
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, [draftKey, fetchJson, isController, sessionId]);

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void uploadSessionAttachments(event.dataTransfer.files);
  }

  function handleDragOver(event: DragEvent) {
    const items = Array.from(event.dataTransfer.items);
    const hasFile = items.length === 0 || items.some((item) => item.kind === "file" || item.type.startsWith("image/"));
    if (!hasFile) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  return (
    <footer
      className={cn(
        "relative z-[3] grid justify-center px-4 pb-3 pt-2",
        isEmptySession && "empty-session-composer",
        emptyComposerGrown && "empty-session-composer-grown",
      )}
      style={{ gridTemplateColumns: "minmax(0, 900px)" }}
    >
      {showEmptyLanding && !emptyComposerGrown && (
        <div className="empty-session-greeting mb-3 grid justify-items-center gap-1 text-center">
          <p className="m-0 text-base font-semibold text-foreground">New Bakery session</p>
          <p className="m-0 max-w-md text-xs text-muted-foreground">Start with a plan, attach context, or run a quick command.</p>
        </div>
      )}
      <ComposerNotice disconnected={isDisconnected} notice={notice} />

      <AutocompletePopup
        state={ac.state}
        onSelect={(index) => {
          const result = ac.insertSelected(draft, index);
          if (!result) return;
          setDraft(result.draft);
          if (draftKey) localStorage.setItem(draftKey, result.draft);
          const item = ac.state?.items[index];
          if (item && ac.shouldRefetchAfterInsert(item)) {
            setTimeout(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.setSelectionRange(result.cursor, result.cursor);
              ac.updateForInput(result.draft, result.cursor);
              el.focus();
            }, 0);
          } else {
            ac.close();
            setTimeout(() => {
              const el = textareaRef.current;
              if (!el) return;
              el.setSelectionRange(result.cursor, result.cursor);
              el.focus();
            }, 0);
          }
        }}
      />

      <div
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "composer-shell relative z-[1] grid min-w-0 gap-2 rounded-2xl border bg-card p-2 shadow-xl",
          "border-border/60 focus-within:border-sidebar-primary/50",
          isAsk && "border-emerald-500/50 bg-emerald-500/5 focus-within:border-emerald-400/70",
          isPlan && "border-yellow-500/50 bg-yellow-500/5 focus-within:border-yellow-400/70",
          isBash && "border-purple-500/50 bg-purple-500/5 focus-within:border-purple-400/70",
          dragging && "border-blue-400/60 bg-blue-400/5",
        )}
      >
        <UploadedAttachmentTray attachments={uploadedAttachments} onRemove={(attachment) => {
          setUploadedAttachments((prev) => prev.filter((item) => item.id !== attachment.id));
        }} />

        <ComposerTextarea
          ref={textareaRef}
          value={draft}
          disabled={!isController}
          isController={isController}
          isRunning={isRunning}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setTimeout(() => ac.close(), 150)}
        />

        <ComposerToolbar
          modeLabel={modeLabel}
          mode={composerMode}
          modeOpen={modeOpen}
          isRunning={isRunning}
          isBash={isBash}
          isAsk={isAsk}
          isPlan={isPlan}
          isController={isController}
          canSend={canSend}
          runtimeSettings={runtimeSettings}
          defaultThinkingLevel={defaultThinkingLevel}
          showThinking={showThinking}
          settingsOpen={settingsOpen}
          onModeOpenChange={(open) => {
            setModeOpen(open);
            if (open) setSettingsOpen(false);
          }}
          onModeChange={setSelectedMode}
          onSettingsOpenChange={(open) => {
            setSettingsOpen(open);
            if (open) setModeOpen(false);
          }}
          onSetModel={onSetModel}
          onSetThinking={onSetThinking}
          onShowThinkingChange={onShowThinkingChange}
          onAttachActivate={() => schedulePickerNoChangeNotice(2500)}
          onAttachResolved={() => {
            imagePickerPendingRef.current = false;
            clearTimeout(imagePickerReturnTimerRef.current);
          }}
          onImageFilesSelected={(files) => void uploadSessionAttachments(files)}
          onAbort={onAbort}
          onFollowUp={() => void handleSend(true)}
          onSend={() => void handleSend(false)}
          onTakeControl={onTakeControl}
        />
      </div>

      {showEmptyLanding && !emptyComposerGrown && (
        <div className="empty-quick-start-chips mt-3 flex flex-wrap justify-center gap-2">
          <button type="button" data-empty-quick-start="plan" onClick={() => setDraft("/plan ")} className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">/plan</button>
          <button type="button" data-empty-quick-start="file" onClick={() => setDraft("@")} className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">@file</button>
          <button type="button" data-empty-quick-start="bash" onClick={() => setDraft("!")} className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">!bash</button>
        </div>
      )}
    </footer>
  );
}

function ComposerNotice({ disconnected, notice }: { disconnected: boolean; notice: string }) {
  if (!disconnected && !notice) return null;
  return (
    <div className="relative mb-2 grid gap-2">
      {disconnected && (
        <p className="connection-banner disconnected m-0 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-500/80">
          Not connected. Your draft is saved locally; sending will be available after reconnect.
        </p>
      )}
      {notice && (
        <p className="notice m-0 rounded-lg border border-yellow-600/30 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
          {notice}
        </p>
      )}
    </div>
  );
}

function UploadedAttachmentTray({ attachments, onRemove }: { attachments: SessionAttachment[]; onRemove: (attachment: SessionAttachment) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Uploaded attachments">
      {attachments.map((attachment) => (
        <figure key={attachment.id} className="prompt-image relative m-0 flex max-w-[180px] items-center gap-1.5 overflow-hidden rounded-lg border border-border/50 bg-muted/50 py-1 pl-1 pr-7">
          {attachment.kind === "image"
            ? <img src={attachment.url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
            : <div className="grid size-8 shrink-0 place-items-center rounded-md bg-background px-1 text-center text-[9px] text-muted-foreground">file</div>}
          <figcaption className="min-w-0 truncate text-[11px] text-muted-foreground" title={attachment.name}>
            {attachment.name}
          </figcaption>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(attachment)}
            aria-label={`Remove ${attachment.name}`}
            className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:bg-background/80 hover:text-foreground"
          >
            <X />
          </Button>
        </figure>
      ))}
    </div>
  );
}

type ComposerTextareaProps = {
  value: string;
  disabled: boolean;
  isController: boolean;
  isRunning: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
};

const ComposerTextarea = forwardRef<HTMLTextAreaElement, ComposerTextareaProps>(function ComposerTextarea(
  {
    value,
    disabled,
    isController,
    isRunning,
    onChange,
    onKeyDown,
    onPaste,
    onBlur,
  },
  ref,
) {
  return (
    <textarea
      ref={ref}
      id="prompt"
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onPaste={onPaste}
      disabled={disabled}
      placeholder={
        !isController
          ? "Viewer mode - take control to send"
          : isRunning
            ? "Steer the active run..."
            : "Ask pi... Paste/drop screenshots, type / for commands or @ for files."
      }
      rows={1}
      className={cn(
        "max-h-[132px] min-h-[64px] w-full resize-none rounded-xl border-0 bg-transparent px-2 py-2",
        "text-sm leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground/50",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
      style={{ height: "64px" }}
    />
  );
});

function ComposerToolbar({
  modeLabel,
  mode,
  modeOpen,
  isRunning,
  isBash,
  isAsk,
  isPlan,
  isController,
  canSend,
  runtimeSettings,
  defaultThinkingLevel,
  showThinking,
  settingsOpen,
  onModeOpenChange,
  onModeChange,
  onSettingsOpenChange,
  onSetModel,
  onSetThinking,
  onShowThinkingChange,
  onAttachActivate,
  onAttachResolved,
  onImageFilesSelected,
  onAbort,
  onFollowUp,
  onSend,
  onTakeControl,
}: {
  modeLabel: string;
  mode: ComposerMode;
  modeOpen: boolean;
  isRunning: boolean;
  isBash: boolean;
  isAsk: boolean;
  isPlan: boolean;
  isController: boolean;
  canSend: boolean;
  runtimeSettings: SessionRuntimeSettings | null;
  defaultThinkingLevel?: string | undefined;
  showThinking: boolean;
  settingsOpen: boolean;
  onModeOpenChange: (open: boolean) => void;
  onModeChange: (mode: ComposerMode) => void;
  onSettingsOpenChange: (open: boolean) => void;
  onSetModel: (model: string) => void;
  onSetThinking: (level: string) => void;
  onShowThinkingChange: (show: boolean) => void;
  onAttachActivate: () => void;
  onAttachResolved: () => void;
  onImageFilesSelected: (files: File[]) => void;
  onAbort: () => void;
  onFollowUp: () => void;
  onSend: () => void;
  onTakeControl: () => void;
}) {
  const nativeFileInputRef = useRef<HTMLInputElement>(null);
  const nativeFileEventHandledRef = useRef(false);

  function submitNativeFileInput(input = nativeFileInputRef.current) {
    onAttachResolved();
    if (!input) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0) return;
    onImageFilesSelected(files);
  }

  function handleNativeFileInput(event: ChangeEvent<HTMLInputElement> | FormEvent<HTMLInputElement>) {
    if (nativeFileEventHandledRef.current) return;
    nativeFileEventHandledRef.current = true;
    window.setTimeout(() => { nativeFileEventHandledRef.current = false; }, 0);
    submitNativeFileInput(event.currentTarget);
  }

  return (
    <div className="composer-toolbar flex min-h-8 flex-wrap items-center gap-2 px-1">
      <ModeMenu
        label={modeLabel}
        mode={mode}
        open={modeOpen}
        disabled={!isController}
        isRunning={isRunning}
        isBash={isBash}
        isAsk={isAsk}
        isPlan={isPlan}
        onOpenChange={onModeOpenChange}
        onModeChange={onModeChange}
      />

      {runtimeSettings && (
        <ModelThinkingControl
          settings={runtimeSettings}
          defaultThinkingLevel={defaultThinkingLevel}
          showThinking={showThinking}
          open={settingsOpen}
          disabled={!isController}
          onOpenChange={onSettingsOpenChange}
          onSetModel={onSetModel}
          onSetThinking={onSetThinking}
          onShowThinkingChange={onShowThinkingChange}
        />
      )}

      {runtimeSettings?.contextUsage && <ContextUsageBadge usage={runtimeSettings.contextUsage} />}

      <span className="min-w-2 flex-1" />

      {!isController && (
        <Button type="button" variant="outline" size="sm" onClick={onTakeControl}>
          Take control
        </Button>
      )}

      <div className={cn("composer-attach-control relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50", !isController && "opacity-50")} title="Attach files">
        <Paperclip aria-hidden="true" className="pointer-events-none size-4 text-muted-foreground" />
        <input
          ref={nativeFileInputRef}
          id="attachImages"
          type="file"
          accept="image/*"
          multiple
          disabled={!isController}
          aria-label="Attach files"
          title="Attach files"
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          onPointerDown={() => {
            if (isController) onAttachActivate();
          }}
          onClick={() => {
            if (isController) onAttachActivate();
          }}
          onInput={handleNativeFileInput}
          onChange={handleNativeFileInput}
        />
      </div>

      {isRunning && (
        <Button id="abort" type="button" variant="destructive" size="icon" onClick={onAbort} title="Abort" aria-label="Abort">
          <Square />
        </Button>
      )}

      {isRunning && (
        <Button id="followUp" type="button" variant="outline" size="sm" onClick={onFollowUp} disabled={!canSend} title="Follow-up" aria-label="Follow-up">
          <Plus />
          <span className="hidden sm:inline">Follow-up</span>
        </Button>
      )}

      <Button
        id="send"
        type="button"
        size="icon"
        onClick={onSend}
        disabled={!canSend}
        title={isRunning ? "Guide active run" : "Send"}
        aria-label={isRunning ? "Guide active run" : "Send"}
        className={sendButtonModeClassName(mode)}
      >
        <SendHorizontal />
      </Button>
    </div>
  );
}

function ModeMenu({
  label,
  mode,
  open,
  disabled,
  isRunning,
  isBash,
  isAsk,
  isPlan,
  onOpenChange,
  onModeChange,
}: {
  label: string;
  mode: ComposerMode;
  open: boolean;
  disabled: boolean;
  isRunning: boolean;
  isBash: boolean;
  isAsk: boolean;
  isPlan: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: ComposerMode) => void;
}) {
  const popoverRef = useDismissablePopover(open, onOpenChange);
  const options: Array<{ mode: ComposerMode; label: string; description: string }> = [
    { mode: "prompt", label: isRunning ? "Steer" : "Prompt", description: isRunning ? "Guide the active run." : "Send a normal message to pi." },
    { mode: "ask", label: "Ask", description: "Ask for an explanation; tools are discouraged unless you request them." },
    { mode: "plan", label: "Plan", description: "Start the bundled planning workflow with your draft as the topic." },
    { mode: "bash", label: "Bash", description: "Run a local shell command and include output in context." },
    { mode: "bash-no-context", label: "Bash - no context", description: "Run a local shell command without adding output to context." },
  ];

  function modeIcon(optionMode: ComposerMode) {
    if (optionMode === "ask") return <CircleHelp className="size-4 text-emerald-400" />;
    if (optionMode === "plan") return <ClipboardList className="size-4 text-yellow-400" />;
    if (optionMode === "bash") return <Terminal className="size-4 text-purple-400" />;
    if (optionMode === "bash-no-context") return <ShieldOff className="size-4 text-purple-400" />;
    return <MessageSquareText className="size-4 text-muted-foreground" />;
  }

  return (
    <div ref={popoverRef} className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => onOpenChange(!open)}
              className={cn(
                "rounded-full px-2 text-muted-foreground",
                isRunning && !isBash && "text-sidebar-primary",
                isAsk && "text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 aria-expanded:bg-emerald-500/10 aria-expanded:text-emerald-300",
                isPlan && "text-yellow-400 hover:bg-yellow-500/10 hover:text-yellow-300 aria-expanded:bg-yellow-500/10 aria-expanded:text-yellow-300",
                isBash && "text-purple-400 hover:bg-purple-500/10 hover:text-purple-300 aria-expanded:bg-purple-500/10 aria-expanded:text-purple-300",
              )}
            />
          }
        >
          <ChevronDown
            className={cn(
              "transition-transform duration-150 ease-out",
              open && "rotate-180",
            )}
          />
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          <span className="inline-flex items-center gap-2">
            Mode
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Command className="size-3" />
              .
            </span>
          </span>
        </TooltipContent>
      </Tooltip>

      {open && (
        <div
          role="menu"
          aria-label="Composer mode"
          className="absolute bottom-[calc(100%+10px)] left-0 z-20 grid w-max max-w-[calc(100vw-2rem)] gap-1 rounded-2xl border border-border bg-popover p-2 shadow-2xl"
        >
          {options.map((option) => (
            <Tooltip key={option.mode}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === option.mode}
                    aria-label={`${option.label}: ${option.description}`}
                    onClick={() => {
                      onModeChange(option.mode);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-left text-sm hover:bg-muted",
                      mode === option.mode && "bg-muted text-foreground",
                    )}
                  >
                    {modeIcon(option.mode)}
                    <span className="font-semibold">{option.label}</span>
                  </button>
                }
              />
              <TooltipContent side="right" sideOffset={10} className="max-w-64">
                {option.description}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelThinkingControl({
  settings,
  defaultThinkingLevel,
  showThinking,
  open,
  disabled,
  onOpenChange,
  onSetModel,
  onSetThinking,
  onShowThinkingChange,
}: {
  settings: SessionRuntimeSettings;
  defaultThinkingLevel?: string | undefined;
  showThinking: boolean;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSetModel: (model: string) => void;
  onSetThinking: (level: string) => void;
  onShowThinkingChange: (show: boolean) => void;
}) {
  const selectedModel = settings.model?.id ?? "";
  const popoverRef = useDismissablePopover(open, onOpenChange);

  return (
    <div ref={popoverRef} className="relative">
      <select id="model" className="sr-only" tabIndex={-1} value={selectedModel} disabled={disabled} onChange={(event) => event.target.value && onSetModel(event.target.value)}>
        {settings.availableModels.map((model) => <option key={model.id} value={model.id}>{modelOptionLabel(model)}</option>)}
      </select>
      <select id="thinking" className="sr-only" tabIndex={-1} value={settings.thinkingLevel} disabled={disabled} onChange={(event) => onSetThinking(event.target.value)}>
        {settings.availableThinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
      <Button
        id="modelThinkingToggle"
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="max-w-[240px] rounded-full"
        title="Change model and thinking level"
      >
        <Settings2 />
        <span className="truncate">{modelThinkingLabel(settings, defaultThinkingLevel)}</span>
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Model and thinking settings"
          className={cn(
            "model-thinking-popover absolute bottom-[calc(100%+10px)] left-1/2 z-20 grid w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 gap-3 rounded-2xl border p-3 shadow-2xl sm:left-0 sm:translate-x-0",
            "border-border bg-popover text-popover-foreground",
          )}
        >
          <SettingField label="Model">
            <Select value={selectedModel} disabled={disabled} onValueChange={(value) => value && onSetModel(value)}>
              <SelectTrigger aria-label="Model">
                <SelectValue placeholder="Select model">
                  {(value: string | null) => {
                    const model = settings.availableModels.find((item) => item.id === value);
                    return model ? modelOptionLabel(model) : "Select model";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
              {settings.availableModels.map((model) => (
                <SelectItem key={model.id} value={model.id} selected={model.id === selectedModel}>
                  {modelOptionLabel(model)}
                </SelectItem>
              ))}
              </SelectContent>
            </Select>
          </SettingField>

          <label className="flex min-h-9 items-center justify-between gap-3 px-1 text-sm font-medium text-foreground">
            <span>
              Thinking <span className="text-muted-foreground">({settings.thinkingLevel})</span>
            </span>
            <StepSlider
              value={settings.thinkingLevel}
              disabled={disabled}
              aria-label="Thinking level"
              options={settings.availableThinkingLevels.map((level) => ({ value: level, label: level }))}
              onValueChange={onSetThinking}
              className="flex-none"
            />
          </label>

          <label className="flex min-h-9 items-center justify-between gap-3 px-1 text-sm font-medium text-foreground">
            <span>Show <span className="text-muted-foreground">in transcript</span></span>
            <Switch
              checked={showThinking}
              disabled={disabled}
              onCheckedChange={onShowThinkingChange}
              aria-label="Show thinking in transcript"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function SettingField({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ContextUsageBadge({ usage }: { usage: NonNullable<SessionRuntimeSettings["contextUsage"]> }) {
  const percent = Math.max(0, Math.min(100, usage.percent ?? 0));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="context-usage inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-full px-1.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Context ${contextUsageLabel(usage)}`}
          >
            <span className="sr-only">Context {contextUsageLabel(usage)}</span>
            <span aria-hidden="true">Ctx</span>
            <svg className="size-5 -rotate-90" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <circle
                cx="10"
                cy="10"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="text-sidebar-primary transition-[stroke-dashoffset]"
              />
            </svg>
          </button>
        }
      />
      <TooltipContent side="top" sideOffset={8}>
        Context {contextUsageLabel(usage)}
      </TooltipContent>
    </Tooltip>
  );
}
