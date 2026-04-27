const autoScrollStorageKey = "piWebAutoScroll";
const nearBottomThresholdPx = 48;
const userScrollIntentMs = 1500;

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

  setAutoScroll(value: boolean): void {
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
    const count = this.unreadCount;
    return `<button id="jumpToLatest" class="jump-to-latest" type="button">${this.jumpToLatestLabel()}</button>`;
  }

  isNearBottom(transcript: HTMLElement | null | undefined): boolean {
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= nearBottomThresholdPx;
  }

  scrollToBottom(root: ParentNode): void {
    const transcript = root.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    this.scrollTop = transcript.scrollTop;
  }

  jumpToLatest(root: ParentNode): void {
    this.setAutoScroll(true);
    this.clearUnread();
    this.scrollToBottom(root);
  }

  scheduleFollow(root: ParentNode): void {
    requestAnimationFrame(() => this.scrollToBottom(root));
  }

  syncScroll(root: ParentNode): void {
    const transcript = root.querySelector<HTMLElement>(".transcript");
    if (!transcript) return;
    if (!this.autoScrollValue || this.preserveScrollOnce) {
      transcript.scrollTop = Math.min(this.scrollTop, Math.max(0, transcript.scrollHeight - transcript.clientHeight));
      this.preserveScrollOnce = false;
      return;
    }

    this.scheduleFollow(root);
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
      existing.textContent = label;
      return;
    }
    const button = document.createElement("button");
    button.id = "jumpToLatest";
    button.className = "jump-to-latest";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onJumpToLatest);
    shell.append(button);
  }

  disableFollowIfDetached(transcript: HTMLElement | null | undefined): void {
    if (this.autoScrollValue && transcript && !this.isNearBottom(transcript)) this.autoScrollValue = false;
  }

  handleScroll(event: Event, callbacks: { requestRender: () => void; patchJumpToLatest: () => void; scheduleFollow: () => void }): void {
    const transcript = event.currentTarget as HTMLElement;
    this.scrollTop = transcript.scrollTop;
    if (this.isNearBottom(transcript)) {
      if (!this.autoScrollValue || this.unreadCount > 0) {
        this.setAutoScroll(true);
        this.clearUnread();
        callbacks.requestRender();
      }
      return;
    }

    if (this.autoScrollValue) {
      const userInitiatedScroll = Date.now() <= this.userScrollIntentUntil || !event.isTrusted;
      if (!userInitiatedScroll) {
        callbacks.scheduleFollow();
        return;
      }
      this.setAutoScroll(false);
      callbacks.requestRender();
      return;
    }

    callbacks.patchJumpToLatest();
  }

  private jumpToLatestLabel(): string {
    const count = this.unreadCount;
    return `Jump to latest${count > 0 ? ` · ${count} update${count === 1 ? "" : "s"}` : ""}`;
  }
}
