export type ClientMessageType = "prompt" | "command" | "steer" | "follow_up";

export type ParsedBashPrompt = {
  command: string;
  excludeFromContext: boolean;
};

export type ComposerSendPayload =
  | { type: "bash"; command: string; excludeFromContext: boolean }
  | { type: ClientMessageType; text: string; images?: string[] };

export type ComposerQueueItem = {
  text: string;
  imageCount: number | undefined;
};

export function promptDraftStorageKey(sessionId: string | null | undefined): string | null {
  return sessionId ? `piWebPromptDraft:${sessionId}` : null;
}

export function promptAttachmentWarningStorageKey(sessionId: string | null | undefined): string | null {
  return sessionId ? `piWebPromptAttachmentWarning:${sessionId}` : null;
}

export function savePromptDraftForSession(storage: Storage, sessionId: string | null | undefined, draft: string): void {
  const key = promptDraftStorageKey(sessionId);
  if (!key) return;
  if (draft) storage.setItem(key, draft);
  else storage.removeItem(key);
}

export function loadPromptDraftForSession(storage: Storage, sessionId: string): string {
  const key = promptDraftStorageKey(sessionId);
  return key ? storage.getItem(key) ?? "" : "";
}

export function persistPromptAttachmentWarning(storage: Storage, sessionId: string | null | undefined, hasAttachments: boolean): void {
  const key = promptAttachmentWarningStorageKey(sessionId);
  if (key && hasAttachments) storage.setItem(key, "lost");
}

export function consumePromptAttachmentWarning(storage: Storage, sessionId: string): boolean {
  const key = promptAttachmentWarningStorageKey(sessionId);
  if (!key) return false;
  const hadLostAttachments = storage.getItem(key) === "lost";
  storage.removeItem(key);
  return hadLostAttachments;
}

export function parseBashPrompt(text: string): ParsedBashPrompt | null {
  if (text.startsWith("!!")) {
    const command = text.slice(2).trim();
    return command ? { command, excludeFromContext: true } : null;
  }
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { command, excludeFromContext: false } : null;
  }
  return null;
}

export function promptTextFromInput(value: string | null | undefined, imageCount: number): string {
  return value?.trim() || (imageCount > 0 ? "Please inspect the attached image." : "");
}

export function buildComposerSendPayload(type: ClientMessageType, text: string, images: string[] = []): ComposerSendPayload {
  const bash = type === "prompt" ? parseBashPrompt(text) : null;
  if (bash) return { type: "bash", command: bash.command, excludeFromContext: bash.excludeFromContext };
  if (type === "command") return { type, text };
  return images.length > 0 ? { type, text, images } : { type, text };
}

export function composerQueueItem(text: string, imageCount: number): ComposerQueueItem {
  return { text, imageCount: imageCount > 0 ? imageCount : undefined };
}
