import { recordPerfEvent } from "./utils";

const autoScrollStorageKey = "piWebAutoScroll";
const nearBottomThresholdPx = 48;
const userScrollIntentMs = 1500;
const jumpToLatestIcon = `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M12 4.75v13.5m0 0 6-6m-6 6-6-6"/></svg>`;

export class TranscriptFollowController {
  private autoScrollValue = localStorage.getItem(autoScrollStorageKey) !== "false";
  private scrollTop = 0;
  private preserveScrollOnce = false;
  private userScrollIntentUntil = 0;
  private readonly unreadTranscriptIdsValue = new Set<string>();

  get autoScroll(): boolean {
    return this.autoScrollValue;
  }

  set autoScroll(value: boolean) {
    this.setAutoScroll(value);
  }

  get unreadCount(): number {
    return this.unreadTranscriptIdsValue.size;
  }

  setAutoScroll(value: boolean, reason = "set"): void {
    if (this.autoScrollValue !== value) recordPerfEvent("autoScrollTransition", reason, { enabled: value });
    this.autoScrollValue = value;
    localStorage.setItem(autoScrollStorageKey, String(value));
  }

  resetToLatest(): void {
    this.setAutoScroll(true);
    this.scrollTop = 0;
    this.preserveScrollOnce = false;
    this.userScrollIntentUntil = 0;
    this.unreadTranscriptIdsValue.clear();
  }

  markUnread(id: string): void {
    if (!this.autoScrollValue) this.unreadTranscriptIdsValue.add(id);
  }

  clearUnread(): void {
    this.unreadTranscriptIdsValue.clear();
  }

  captureScrollTop(transcript: HTMLElement | null | undefined): void {
    if (transcript) this.scrollTop = transcript.scrollTop;
  }

  preserveNextSync(): void {
    this.preserveScrollOnce = true;
  }

  markUserScrollIntent(): void {
    this.userScrollIntentUntil = Date.now() + userScrollIntentMs;
  }

  renderJumpToLatest(): string {
    if (this.autoScrollValue) return "";
    const label = this.jumpToLatestLabel();
    return `<button id="jumpToLatest" class="jump-to-latest" type="button" aria-label="${label}" title="${label}">${jumpToLatestIcon}</button>`;
  }

  isNearBottom(transcript: HTMLElement | null | undefined): boolean {
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= nearBottomThresholdPx;
  }

  scrollToBottom(root: ParentNode, reason = "scroll-to-bottom"): void {
    const transcript = root.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    const before = transcript.scrollTop;
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    this.scrollTop = transcript.scrollTop;
    if (Math.abs(transcript.scrollTop - before) >= 1) recordPerfEvent("scrollCorrection", reason, { before: Math.round(before), after: Math.round(transcript.scrollTop), delta: Math.round(transcript.scrollTop - before), autoScroll: this.autoScrollValue });
  }

  private preserveScrollPosition(transcript: HTMLElement, reason: string): void {
    const before = transcript.scrollTop;
    transcript.scrollTop = Math.min(this.scrollTop, Math.max(0, transcript.scrollHeight - transcript.clientHeight));
    this.scrollTop = transcript.scrollTop;
    if (Math.abs(transcript.scrollTop - before) >= 1) recordPerfEvent("scrollCorrection", reason, { before: Math.round(before), after: Math.round(transcript.scrollTop), delta: Math.round(transcript.scrollTop - before), autoScroll: this.autoScrollValue });
  }

  jumpToLatest(root: ParentNode): void {
    this.setAutoScroll(true, "jump-to-latest");
    this.clearUnread();
    this.scrollToBottom(root, "jump-to-latest");
  }

  scheduleFollow(root: ParentNode, reason = "scheduled-follow"): void {
    requestAnimationFrame(() => {
      if (!this.autoScrollValue) return;
      this.scrollToBottom(root, reason);
    });
  }

  syncScroll(root: ParentNode): void {
    const transcript = root.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    if (!this.autoScrollValue || this.preserveScrollOnce) {
      this.preserveScrollPosition(transcript, this.preserveScrollOnce ? "preserve-once" : "auto-scroll-paused");
      this.preserveScrollOnce = false;
      return;
    }

    this.scheduleFollow(root, "sync-scroll");
  }

  patchJumpToLatest(root: ParentNode, onJumpToLatest: () => void): void {
    const shell = root.querySelector<HTMLElement>(".transcript-shell");
    if (!shell) return;
    const existing = shell.querySelector<HTMLButtonElement>("#jumpToLatest");
    if (this.autoScrollValue) {
      existing?.remove();
      return;
    }
    const label = this.jumpToLatestLabel();
    if (existing) {
      existing.setAttribute("aria-label", label);
      existing.title = label;
      existing.innerHTML = jumpToLatestIcon;
      return;
    }
    const button = document.createElement("button");
    button.id = "jumpToLatest";
    button.className = "jump-to-latest";
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = jumpToLatestIcon;
    button.addEventListener("click", onJumpToLatest);
    shell.append(button);
  }

  disableFollowIfDetached(transcript: HTMLElement | null | undefined): void {
    if (!this.autoScrollValue || !transcript || this.isNearBottom(transcript)) return;
    if (this.hasUserScrollIntent()) {
      this.setAutoScroll(false, "detached-during-user-scroll");
      return;
    }
  }

  handleScroll(event: Event, callbacks: { requestRender: () => void; patchJumpToLatest: () => void; scheduleFollow: () => void }): void {
    const transcript = event.currentTarget as HTMLElement;
    this.scrollTop = transcript.scrollTop;
    if (this.isNearBottom(transcript)) {
      if (!this.autoScrollValue || this.unreadCount > 0) {
        this.setAutoScroll(true, "scroll-near-bottom");
        this.clearUnread();
        callbacks.requestRender();
      }
      return;
    }

    if (this.autoScrollValue) {
      const userInitiatedScroll = this.hasUserScrollIntent() || !event.isTrusted;
      if (!userInitiatedScroll) {
        callbacks.scheduleFollow();
        return;
      }
      this.setAutoScroll(false, "user-scroll-away");
      callbacks.requestRender();
      return;
    }

    callbacks.patchJumpToLatest();
  }

  private hasUserScrollIntent(): boolean {
    return Date.now() <= this.userScrollIntentUntil;
  }

  private jumpToLatestLabel(): string {
    const count = this.unreadCount;
    return `Jump to latest${count > 0 ? ` · ${count} update${count === 1 ? "" : "s"}` : ""}`;
  }
}
