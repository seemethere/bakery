import { escapeHtml } from "./utils";

export type ComposerAgentStatus = "aborting" | "connecting" | "disconnected" | "error" | "idle" | "running";

export interface ComposerModeState {
  promptDraft: string;
  imageCount: number;
  status: ComposerAgentStatus;
  isController: boolean;
}

export function hasComposerSendContent(value: string, imageCount: number): boolean {
  return value.trim().length > 0 || imageCount > 0;
}

export function isBashPromptDraft(promptDraft: string): boolean {
  return promptDraft.trimStart().startsWith("!");
}

export function isNoContextBashPromptDraft(promptDraft: string): boolean {
  return promptDraft.trimStart().startsWith("!!");
}

export function composerModeLabel(promptDraft: string, status: ComposerAgentStatus): string {
  if (isBashPromptDraft(promptDraft)) return isNoContextBashPromptDraft(promptDraft) ? "Bash · no context" : "Bash command";
  return status === "running" ? "Running input" : "Prompt";
}

export function isComposerNotice(notice: string): boolean {
  return notice === "Bash commands are available when the session is idle."
    || notice === "Remove image attachments before running a bash command."
    || notice === "Not connected. Your draft is saved locally; sending will be available after reconnect."
    || notice === "Drop image files here to attach them to the prompt."
    || notice.startsWith("No supported image files found.")
    || notice.startsWith("Could not attach image:")
    || notice.startsWith("Attached image to prompt,")
    || notice.startsWith("Unsupported image type:")
    || notice.includes("is larger than");
}

export function renderComposerNotice(notice: string): string {
  return notice && isComposerNotice(notice) ? `<p class="notice composer-notice">${escapeHtml(notice)}</p>` : "";
}

export function patchComposerSendAvailability(root: ParentNode, input: HTMLTextAreaElement | null | undefined, imageCount: number): void {
  const canSend = Boolean(input && !input.disabled && hasComposerSendContent(input.value, imageCount));
  root.querySelector<HTMLButtonElement>("#send")?.toggleAttribute("disabled", !canSend);
  root.querySelector<HTMLButtonElement>("#followUp")?.toggleAttribute("disabled", !canSend);
}

export function patchComposerMode(root: ParentNode, state: ComposerModeState, input = root.querySelector<HTMLTextAreaElement>("#prompt")): void {
  const isBash = isBashPromptDraft(state.promptDraft);
  const isNoContext = isNoContextBashPromptDraft(state.promptDraft);
  const isRunning = state.status === "running";
  const label = composerModeLabel(state.promptDraft, state.status);
  const promptShell = root.querySelector<HTMLElement>(".prompt-shell");
  const footer = root.querySelector<HTMLElement>("footer");
  const composerMode = root.querySelector<HTMLElement>(".composer-mode");
  const controls = root.querySelector<HTMLElement>(".controls");
  const send = root.querySelector<HTMLButtonElement>("#send");
  const followUp = root.querySelector<HTMLButtonElement>("#followUp");
  const abort = root.querySelector<HTMLButtonElement>("#abort");

  promptShell?.classList.toggle("bash-mode", isBash);
  promptShell?.classList.toggle("no-context", isNoContext);
  footer?.classList.toggle("running-footer", isRunning);
  composerMode?.classList.toggle("bash-mode", isBash);
  composerMode?.classList.toggle("running", !isBash && isRunning);
  composerMode?.classList.toggle("idle", !isBash && !isRunning);
  composerMode?.classList.toggle("no-context", isNoContext);
  controls?.classList.toggle("running", isRunning);
  followUp?.classList.toggle("hidden", !isRunning);
  abort?.classList.toggle("hidden", !isRunning);

  if (input) {
    input.placeholder = state.isController ? (isRunning ? "Steer the active run..." : "Ask pi... Paste/drop screenshots, type / for commands or @ for files.") : "Viewer mode — take control to send";
  }
  const modeLabel = composerMode?.querySelector<HTMLElement>("strong");
  if (modeLabel) modeLabel.textContent = label;
  if (send) {
    send.dataset.tooltip = isRunning ? "Guide active run · Enter" : "Send · Enter";
    send.setAttribute("aria-label", isRunning ? "Guide active run" : "Send");
    const srOnly = send.querySelector<HTMLElement>(".sr-only");
    if (srOnly) srOnly.textContent = isRunning ? "Guide active run" : "Send";
  }
  patchComposerSendAvailability(root, input, state.imageCount);
}
