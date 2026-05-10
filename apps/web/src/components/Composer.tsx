import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import type { ArtifactUploadResponse, SessionRuntimeSettings } from "@pi-web-agent/protocol";
import { ChevronDown, CircleHelp, ClipboardList, Command, MessageSquareText, Paperclip, Plus, SendHorizontal, Settings2, ShieldOff, Square, Terminal, X } from "lucide-react";
import { AutocompletePopup } from "@/components/AutocompletePopup";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StepSlider } from "@/components/ui/step-slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutocomplete } from "@/hooks/useAutocomplete";
import { contextUsageLabel, modelOptionLabel, modelThinkingLabel } from "@/lib/model-settings";
import { artifactPathForFile, imageFilesFromDataTransfer, imageMimeType, isSupportedImageFile, loadImageFile, maxArtifactImageBytes, maxPromptImages, readFileAsBase64, supportedPromptImageTypes, type PromptImage } from "@/lib/prompt-images";
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

function sendTextForMode(draft: string, imageCount: number, mode: ComposerMode): string {
  if (draft.trim().length === 0 && imageCount > 0) return "Please inspect the attached image.";
  return payloadForMode(draft, mode);
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
  const [draft, setDraft] = useState(() => (draftKey ? (localStorage.getItem(draftKey) ?? "") : ""));
  const [images, setImages] = useState<PromptImage[]>([]);
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
  const canSend = isController && (draft.trim().length > 0 || images.length > 0) && status !== "aborting" && status !== "connecting";
  const isDisconnected = status === "disconnected" || status === "error";
  const modeLabel = composerModeLabel(composerMode, status);
  const showEmptyLanding = isEmptySession && draft.trim().length === 0 && images.length === 0;
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
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

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
    const text = sendTextForMode(draft, images.length, composerMode);
    const trimmed = text.trim();
    if (isRunning && trimmed.startsWith("!")) {
      setNotice("Bash commands are available when the session is idle.");
      return;
    }
    if (/^\/new(?:\s|$)/i.test(trimmed)) {
      if (images.length > 0) {
        setNotice("Remove image attachments before using /new.");
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
      onSend(text, images, followUp, sendModeForComposerMode(composerMode));
    }
    setNotice("");
    setDraft("");
    setImages([]);
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

  function appendArtifactPaths(paths: string[]) {
    if (paths.length === 0) return;
    setDraft((prev) => {
      const prefix = prev.trim().length === 0 || prev.endsWith("\n") ? "" : "\n";
      const suffix = paths.map((path) => `Screenshot artifact: ${path}`).join("\n");
      const next = `${prev}${prefix}${suffix}`;
      if (draftKey) localStorage.setItem(draftKey, next);
      return next;
    });
  }

  async function uploadImageArtifacts(files: File[]): Promise<{ paths: string[]; notices: string[] }> {
    const notices: string[] = [];
    if (!sessionId || !fetchJson) return { paths: [], notices: ["Image attached; artifact upload is unavailable until the session is ready."] };

    const paths: string[] = [];
    for (const file of files) {
      const mimeType = imageMimeType(file);
      if (!supportedPromptImageTypes.has(mimeType)) {
        notices.push(`Unsupported image type: ${file.type || file.name}`);
        continue;
      }
      if (file.size > maxArtifactImageBytes) {
        notices.push(`${file.name || "Image"} is larger than ${maxArtifactImageBytes / 1024 / 1024}MB and was not uploaded as an artifact.`);
        continue;
      }

      const path = artifactPathForFile(file);
      try {
        const data = await readFileAsBase64(file);
        const uploaded = await fetchJson<ArtifactUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, mimeType, data }),
        });
        paths.push(uploaded.path);
      } catch (error) {
        notices.push(`Could not upload ${file.name || "image"} as an artifact: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { paths, notices };
  }

  async function handleImageFiles(files: FileList | File[]) {
    const fileArray = Array.from(files).filter(isSupportedImageFile);
    if (fileArray.length === 0) {
      setNotice("No supported image files found.");
      return;
    }

    const remaining = maxPromptImages - images.length;
    const promptFiles = remaining > 0 ? fileArray.slice(0, remaining) : [];
    const results = await Promise.all(promptFiles.map(loadImageFile));
    const loaded: PromptImage[] = [];
    const notices: string[] = [];
    for (const result of results) {
      if (typeof result === "string") notices.push(result);
      else loaded.push(result);
    }
    if (remaining <= 0) notices.push(`Maximum ${maxPromptImages} images allowed.`);
    else if (fileArray.length > remaining) notices.push(`Attached the first ${remaining} image${remaining === 1 ? "" : "s"}; maximum ${maxPromptImages} images allowed.`);

    if (loaded.length > 0) setImages((prev) => [...prev, ...loaded]);

    const uploadResult = await uploadImageArtifacts(fileArray);
    appendArtifactPaths(uploadResult.paths);
    notices.push(...uploadResult.notices);

    if (loaded.length > 0 && uploadResult.paths.length > 0) notices.unshift(`Attached ${loaded.length} image${loaded.length === 1 ? "" : "s"} and uploaded ${uploadResult.paths.length} artifact${uploadResult.paths.length === 1 ? "" : "s"}.`);
    else if (loaded.length > 0) notices.unshift(`Attached ${loaded.length} image${loaded.length === 1 ? "" : "s"}.`);
    else if (uploadResult.paths.length > 0) notices.unshift(`Uploaded ${uploadResult.paths.length} image artifact${uploadResult.paths.length === 1 ? "" : "s"}.`);

    if (notices.length > 0) setNotice(notices[0] ?? "");
  }

  function openImagePicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.style.cssText = "position:fixed;left:-10000px;top:0";
    input.addEventListener("change", () => {
      void handleImageFiles(input.files ?? []);
      input.remove();
    }, { once: true });
    document.body.append(input);
    input.click();
  }

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromDataTransfer(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      void handleImageFiles(files);
    }
  }, [draftKey, fetchJson, images, sessionId]);

  useEffect(() => {
    if (!isController) return;

    function handleDocumentPaste(event: globalThis.ClipboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target;
      const element = target instanceof Element ? target : null;
      const isPrompt = element?.id === "prompt";
      const isOtherEditable = Boolean(element?.closest('textarea,input,[contenteditable="true"]')) && !isPrompt;
      if (isOtherEditable) return;

      const files = imageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void handleImageFiles(files);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    document.addEventListener("paste", handleDocumentPaste);
    return () => document.removeEventListener("paste", handleDocumentPaste);
  }, [draftKey, fetchJson, images, isController, sessionId]);

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) void handleImageFiles(event.dataTransfer.files);
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
          "relative z-[1] grid min-w-0 gap-2 rounded-2xl border bg-card p-2 shadow-xl",
          "border-border/60 focus-within:border-sidebar-primary/50",
          isAsk && "border-emerald-500/50 bg-emerald-500/5 focus-within:border-emerald-400/70",
          isPlan && "border-yellow-500/50 bg-yellow-500/5 focus-within:border-yellow-400/70",
          isBash && "border-purple-500/50 bg-purple-500/5 focus-within:border-purple-400/70",
          dragging && "border-blue-400/60 bg-blue-400/5",
        )}
      >
        <AttachmentTray images={images} onRemove={(id) => setImages((prev) => prev.filter((image) => image.id !== id))} />

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
          onAttach={openImagePicker}
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
        <p className="m-0 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-500/80">
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

function AttachmentTray({ images, onRemove }: { images: PromptImage[]; onRemove: (id: string) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Attached images">
      {images.map((image) => (
        <figure key={image.id} className="prompt-image relative m-0 grid w-[88px] overflow-hidden rounded-xl border border-border/50 bg-muted" style={{ gridTemplateRows: "58px auto" }}>
          <img src={image.dataUrl} alt={image.name} className="h-[58px] w-full object-cover" />
          <figcaption className="truncate px-1.5 py-1 text-[11px] text-muted-foreground" title={image.name}>
            {image.name}
          </figcaption>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(image.id)}
            aria-label={`Remove ${image.name}`}
            className="absolute right-1 top-1 bg-black/80 text-white hover:bg-black"
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
  onAttach,
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
  onAttach: () => void;
  onAbort: () => void;
  onFollowUp: () => void;
  onSend: () => void;
  onTakeControl: () => void;
}) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 px-1">
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

      <Button id="attachImages" type="button" variant="outline" size="icon" onClick={onAttach} title="Attach images" aria-label="Attach images" disabled={!isController}>
        <Paperclip />
      </Button>

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
